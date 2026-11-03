import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
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

describe("real stack: the probe app under local workerd (G5-D-F1)", () => {
  // The probe registers the middleware exactly as documented (src/start.ts, no collectorPath and no exclusion of
  // /idr/e) and the collector route at /idr/e with only POST (src/routes/idr.e.ts). Its resolver URL is the fixed
  // local sink http://127.0.0.1:4599. Same gating as the bundle-safety test.
  const haveProbe = existsSync(join(probeDir, "node_modules", ".bin", "wrangler"));
  const requireProbe = process.env["IDR_REQUIRE_PROBE"] === "1";
  const SINK_PORT = 4599;
  // What a browser sends for an address-bar navigation. CF-Connecting-IP is passed through by local workerd, and
  // the probe allows documentation ranges, so an eligible page is delivered.
  const NAVIGATION = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "cf-connecting-ip": "198.51.100.23",
  };

  /** node:http, because fetch (undici) rewrites Sec-Fetch-Mode and normalises the path. */
  function send(port: number, method: string, path: string, headers: Record<string, string> = NAVIGATION): Promise<{ status: number; type: string; body: string }> {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body }));
      });
      r.on("error", reject);
      r.end();
    });
  }
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });

  it.skipIf(!haveProbe && !requireProbe)("a GET/HEAD navigation to /idr/e through the real router creates no entrance; an ordinary page still does", async () => {
    rmSync(join(probeDir, ".output"), { recursive: true, force: true });
    // NODE_ENV=production: under vitest it is "test", which makes Vite emit the development JSX runtime.
    execFileSync("npm", ["run", "build"], { cwd: probeDir, stdio: "pipe", timeout: 240_000, env: { ...process.env, NITRO_PRESET: "", CI: "1", NODE_ENV: "production" } });

    const entrances: Array<{ url: string; body: Record<string, unknown> }> = [];
    const sink = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (req.url === "/v1/entrances") entrances.push({ url: req.url, body: JSON.parse(b || "{}") as Record<string, unknown> });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "1", status: "ineligible", source: "none", recorded: false }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      sink.once("error", (e) => reject(new Error(`the probe's fixed sink port ${SINK_PORT} is in use (${(e as Error).message})`)));
      sink.listen(SINK_PORT, "127.0.0.1", () => resolve());
    });
    const port = await freePort();
    const wrangler = spawn(join(probeDir, "node_modules", ".bin", "wrangler"), ["dev", "-c", ".output/server/wrangler.json", "--port", String(port), "--ip", "127.0.0.1", "--local"], {
      cwd: probeDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    });
    let log = "";
    wrangler.stdout.on("data", (d) => (log += d));
    wrangler.stderr.on("data", (d) => (log += d));
    try {
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        try {
          ready = (await send(port, "GET", "/m/none/warm")).status === 200;
        } catch {
          ready = false;
        }
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      expect(ready, `wrangler dev did not start:\n${log.slice(-2000)}`).toBe(true);
      const hookCount = (JSON.parse((await send(port, "GET", "/diag/idr")).body) as string[]).length;
      entrances.length = 0;

      const collectorRequests: Array<[string, string]> = [["GET", "/idr/e"], ["HEAD", "/idr/e"], ["GET", "/IDR/E"], ["GET", "/idr/e/"], ["GET", "/idr/%65"], ["GET", "/%69dr/e"], ["GET", "//idr/e"], ["GET", "/idr//e"]];
      const answers = [];
      for (const [method, path] of collectorRequests) answers.push({ method, path, ...(await send(port, method, path)) });
      const control = `/landing/control${Date.now().toString(36).replace(/[0-9]/g, "")}`;
      const controlAnswer = await send(port, "GET", control);
      await new Promise((r) => setTimeout(r, 1500));
      const hooks = (JSON.parse((await send(port, "GET", "/diag/idr")).body) as string[]).slice(hookCount).map((x) => JSON.parse(x) as { route?: string; outcome: string; reason: string });

      // The precondition of G5-D-F1: with only POST registered, the framework itself serves GET /idr/e as a page.
      expect(answers[0]).toMatchObject({ status: 200 });
      expect(answers[0]!.type).toContain("text/html");
      // The resolver (the sink) received exactly one entrance: the ordinary page. None for the collector path.
      // (Before the fix it received /idr/e, /IDR/E, /idr/%65 and /%69dr/e as well.)
      expect(controlAnswer.status).toBe(200);
      expect(entrances.map((e) => e.body["page_key"])).toEqual([control]);
      // Every request to the collector path that the framework answered with a 2xx reached the middleware and was
      // skipped as collector_path. (Verified with TanStack Start 1.168: GET, HEAD, /IDR/E, /idr/%65 and /%69dr/e are
      // served 200 text/html; the router redirects /idr/e/ and /idr//e (307) and //idr/e (308) to /idr/e.)
      const reportable = answers.filter((a) => a.status >= 200 && a.status <= 299);
      expect(reportable.length).toBeGreaterThanOrEqual(5);
      const middlewareHooks = hooks.filter((h) => h.route === undefined);
      expect(middlewareHooks.filter((h) => h.reason === "eligibility:collector_path")).toHaveLength(reportable.length);
      expect(middlewareHooks.filter((h) => h.outcome === "delivered")).toHaveLength(1);
    } finally {
      try {
        process.kill(-wrangler.pid!, "SIGTERM");
      } catch {
        // already gone
      }
      await new Promise<void>((r) => sink.close(() => r()));
    }
  }, 300_000);
});
