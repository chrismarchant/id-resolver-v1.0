// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleCollector, GZIP_BUDGET_BYTES } from "../scripts/bundle.mjs";

const pkgDir = resolve(import.meta.dirname, "..");
let code = "";
beforeAll(async () => {
  code = await bundleCollector();
});

describe("bundle budget", () => {
  it(`the minified ESM build is at most ${GZIP_BUDGET_BYTES} bytes gzip`, () => {
    const gz = gzipSync(code, { level: 9 }).length;
    console.log(`idr-collector minified: ${code.length} bytes, gzip ${gz} bytes (budget ${GZIP_BUDGET_BYTES})`);
    expect(code.length).toBeGreaterThan(1000); // the build really contains the collector
    expect(code).toContain("initCollector");
    expect(gz).toBeLessThanOrEqual(GZIP_BUDGET_BYTES);
  });
});

describe("CSP static scan of the shipped bundle (script-src 'self'; connect-src 'self'; no unsafe-eval, no unsafe-inline)", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["eval", /\beval\b/],
    ["Function constructor", /\bFunction\s*\(/],
    ["document.write", /document\.write/],
    ["innerHTML", /innerHTML/],
    ["outerHTML", /outerHTML/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["string timer", /set(?:Timeout|Interval)\(\s*["'`]/],
    ["absolute URL", /https?:\/\//i],
    ["protocol-relative URL literal", /["'`]\/\/[^"'`]/],
    ["javascript: URL", /javascript:/i],
    ["dynamic import", /\bimport\s*\(/],
    ["workers", /importScripts|\bWorker\b|serviceWorker/],
    ["element creation or injection", /createElement|appendChild|insertBefore|replaceChildren|\.append\(|\.prepend\(|DOMParser|createContextualFragment/],
    ["style injection", /\.style\b|setAttribute|insertRule|CSSStyleSheet|adoptedStyleSheets/],
    ["other network channels", /XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|postMessage|\.open\(/],
  ];
  it.each(forbidden)("no %s", (_name, re) => {
    expect(code).not.toMatch(re);
  });

  it("every timer is given a function, never a string", () => {
    const calls = [...code.matchAll(/set(?:Timeout|Interval)\(([^,)]*)/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const first of calls) expect(first).toMatch(/^[A-Za-z_$][\w$]*$/);
  });
});

describe("privacy static scan of the shipped bundle", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["storage and cookies", /localStorage|sessionStorage|indexedDB|cookie|\bcaches\b/i],
    ["fingerprinting surfaces", /userAgent|userAgentData|\bplatform\b|languages?\b|hardwareConcurrency|deviceMemory|\bscreen\b|devicePixelRatio|getContext|toDataURL|\bplugins\b|mimeTypes|getBattery|enumerateDevices|Intl\b|timeZone|getTimezoneOffset|AudioContext|webdriver|connection\b/],
    ["content capture", /\.value\b|FormData|\.elements\b|textContent|innerText|outerText|(?<!location)\.href\b|\.search\b|\.hash\b|\.referrer\b|getSelection|MutationObserver|\.files\b|\.title\b|\.action\b/],
    ["identity or session state", /visitor|session|\buid\b|fingerprint/i],
    ["Math.random (ids come from crypto.getRandomValues only)", /Math\.random/],
  ];
  it.each(forbidden)("no %s", (_name, re) => {
    expect(code).not.toMatch(re);
  });

  it("reads location.pathname and no other part of the URL", () => {
    const uses = [...code.matchAll(/location\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(uses)).toEqual(new Set(["href", "origin", "pathname"].filter((k) => uses.includes(k))));
    // href and origin are used only for the init-time same-origin check of the endpoint.
    expect(code).toMatch(/new URL\([\w$]+,location\.href\)\.origin!==location\.origin/);
    expect(uses.filter((u) => u === "href")).toHaveLength(1);
  });

  it("the only attribute it reads is data-idr-event", () => {
    const reads = [...code.matchAll(/getAttribute\(([^)]*)\)/g)].map((m) => m[1]);
    expect(reads).toEqual(['"data-idr-event"']);
  });
});

describe("package hygiene", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;

  it("is the unpublished 0.1.0-dev.1 browser ESM package with zero runtime dependencies", () => {
    expect(pkg["name"]).toBe("@id-resolver/collector");
    expect(pkg["version"]).toBe("0.1.0-dev.1");
    expect(pkg["private"]).toBe(true);
    expect(pkg["type"]).toBe("module");
    expect(pkg["sideEffects"]).toBe(false);
    expect(pkg["dependencies"]).toBeUndefined();
    expect(pkg["peerDependencies"]).toBeUndefined();
    expect(pkg["optionalDependencies"]).toBeUndefined();
    expect(pkg["bundleDependencies"]).toBeUndefined();
  });

  it("dev dependencies are pinned to exact versions", () => {
    for (const [name, v] of Object.entries(pkg["devDependencies"] as Record<string, string>)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("source imports nothing outside the package (no node:, no bare specifiers)", () => {
    const srcDir = join(pkgDir, "src");
    for (const f of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, f), "utf8");
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) expect(m[1], f).toMatch(/^\.\/[\w-]+\.js$/);
    }
  });

  it("tsc emits ESM with declarations", () => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const out = mkdtempSync(join(tmpdir(), "idr-collector-dist-"));
    try {
      execFileSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.build.json"), "--outDir", out], { cwd: pkgDir, stdio: "pipe" });
      const files = readdirSync(out);
      expect(files).toEqual(expect.arrayContaining(["index.js", "index.d.ts", "vocabulary.js", "vocabulary.d.ts"]));
      const js = readFileSync(join(out, "index.js"), "utf8");
      expect(js).toMatch(/^import .* from "\.\/vocabulary\.js";/m);
      expect(js).not.toMatch(/\brequire\(|module\.exports/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
