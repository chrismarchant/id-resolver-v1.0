import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers.js";

const pkgDir = resolve(import.meta.dirname, "..");
const srcDir = join(pkgDir, "src");
const probeDir = join(pkgDir, "verification", "cf-lifecycle");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe("package hygiene", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;

  it("is the unpublished 0.1.0-dev.0 package with zero runtime dependencies", () => {
    expect(pkg["name"]).toBe("@salescrusader/idr-tanstack");
    expect(pkg["version"]).toBe("0.1.0-dev.0");
    expect(pkg["private"]).toBe(true);
    expect(pkg["dependencies"]).toBeUndefined();
    expect(pkg["peerDependencies"]).toBeUndefined();
    expect(pkg["optionalDependencies"]).toBeUndefined();
    expect(Object.keys(pkg["devDependencies"] as object).sort()).toEqual(["@types/node", "typescript", "vitest"]);
  });

  it("has no browser export condition or browser field", () => {
    const text = JSON.stringify(pkg);
    expect(pkg["browser"]).toBeUndefined();
    expect(text).not.toMatch(/"browser"/);
    expect(text).not.toMatch(/"(?:worker|workerd|react-native|deno)"/);
    expect(Object.keys((pkg["exports"] as Record<string, Record<string, string>>)["."]!).sort()).toEqual(["default", "import", "types"]);
  });

  it("source uses Web APIs only: no node: imports, require, process, Buffer or console", () => {
    const offenders: string[] = [];
    for (const f of walk(srcDir).filter((p) => p.endsWith(".ts"))) {
      const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/from\s+["'](?:node:|fs|path|http|https|net|crypto|os|child_process|buffer|stream|url)["']/.test(text)) offenders.push(`${f}: node import`);
      if (/\brequire\s*\(/.test(text)) offenders.push(`${f}: require`);
      if (/\bprocess\b/.test(text)) offenders.push(`${f}: process`);
      if (/\bBuffer\b/.test(text)) offenders.push(`${f}: Buffer`);
      if (/\bconsole\s*\./.test(text)) offenders.push(`${f}: console`);
      if (/\blocalStorage|document\.cookie|sessionStorage\b/.test(text)) offenders.push(`${f}: browser storage`);
    }
    expect(offenders).toEqual([]);
  });

  it("the only dynamic import is the computed cloudflare:workers lookup (no static cloudflare: import)", () => {
    const text = walk(srcDir).map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");
    expect(text).not.toMatch(/from\s+["']cloudflare:/);
    expect(text).not.toMatch(/import\(\s*["']cloudflare:/);
    expect([...text.matchAll(/import\(/g)]).toHaveLength(1);
  });

  it("the compiled output is clean ESM with declarations", () => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const out = mkdtempSync(join(tmpdir(), "idr-dist-"));
    try {
      execFileSync(process.execPath, [tsc, "-p", join(pkgDir, "tsconfig.build.json"), "--outDir", out], { cwd: pkgDir, stdio: "pipe" });
      const files = walk(out);
      expect(files.some((f) => f.endsWith("index.js"))).toBe(true);
      expect(files.some((f) => f.endsWith("index.d.ts"))).toBe(true);
      const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
      expect(js).not.toMatch(/from\s+["']node:/);
      expect(js).not.toMatch(/\bprocess\b/);
      expect(js).not.toContain(TEST_TOKEN);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("bundle safety (TanStack Start probe build)", () => {
  const haveProbe = existsSync(join(probeDir, "node_modules", ".bin", "vite"));
  // The probe registers both server exports exactly as documented: the middleware in src/start.ts and the
  // collector route inline in src/routes/idr.e.ts `server.handlers`. Its root route also starts the browser
  // collector, so the client bundle legitimately holds the collector, and must hold nothing of the server side.
  const FORBIDDEN_IN_CLIENT = [TEST_TOKEN, "createIdrServerMiddleware", "createCollectorRoute", "idr-tanstack", "/v1/entrances", "/v1/events", "entrance.v1", "event.v1", "cf-connecting-ip", "x-forwarded-for", "sec-gpc", "resolverUrl", "allowInsecureHttp", "replayCacheSize", "maxClockSkewMs"];

  // The probe has its own lockfile and is not an npm workspace. When its
  // node_modules are absent (for example a fresh CI checkout) this test is
  // skipped and reported as skipped, never silently green: run
  //   (cd verification/cf-lifecycle && npm ci --ignore-scripts)
  // to enable it.
  // CI sets IDR_REQUIRE_PROBE=1 so a missing probe install fails instead of skipping.
  const requireProbe = process.env["IDR_REQUIRE_PROBE"] === "1";
  it.skipIf(!haveProbe && !requireProbe)("a production build puts neither the server code (middleware, collector route) nor the token in client assets", () => {
    rmSync(join(probeDir, ".output"), { recursive: true, force: true });
    execFileSync("npm", ["run", "build"], { cwd: probeDir, stdio: "pipe", timeout: 240_000, env: { ...process.env, NITRO_PRESET: "", CI: "1" } });
    const clientDir = join(probeDir, ".output", "public");
    const serverDir = join(probeDir, ".output", "server");
    const clientFiles = walk(clientDir);
    expect(clientFiles.length).toBeGreaterThan(0);
    const clientText = clientFiles.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const needle of FORBIDDEN_IN_CLIENT) expect(clientText, `client assets contain ${needle}`).not.toContain(needle);

    // Sanity: the scan is meaningful, the server bundle does hold the package and the token.
    const serverText = walk(serverDir).filter((f) => /\.(?:m?js|json)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(serverText).toContain(TEST_TOKEN);
    expect(serverText).toContain("entrance.v1");
    expect(serverText).toContain("event.v1");
    expect(serverText).toContain("/v1/events");
    expect(serverText).toContain("createCollectorRoute must only run on the server");
    // ...and the client half is really there (the collector is bundled into the client).
    expect(clientText).toContain("data-idr-event");
    expect(clientText).toContain("idr-collector:");
  }, 300_000);

  it("refuses to run when a browser global is present (defence in depth)", async () => {
    const { createIdrServerMiddleware } = await import("../src/index.js");
    const prev = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    try {
      expect(() => createIdrServerMiddleware({ resolverUrl: "https://resolver.example.com", token: TEST_TOKEN, websiteId: "example-site", trustPolicy: { mode: "none" } })).toThrow(/server/);
    } finally {
      if (prev === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prev;
    }
  });
});
