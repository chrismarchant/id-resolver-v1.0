import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdrServerMiddleware, type DeliveryResult, type IdrOptions } from "../src/index.js";
import { baseOptions, reqWithIp, withWaitUntil } from "./helpers.js";
import { closedPortUrl, startResolver } from "./resolver-fixture.js";

const PAGE_BODY = "<!doctype html><html><body><h1>Pricing</h1>" + "x".repeat(4096) + "</body></html>";
const makePage = () => new Response(PAGE_BODY, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "x-app": "1" } });

async function snapshot(res: Response) {
  return { status: res.status, headers: [...res.headers].sort(([a], [b]) => a.localeCompare(b)), body: new Uint8Array(await res.arrayBuffer()) };
}

const BUDGET_MS = 100; // maximum added latency tolerated for wait_until / detached delivery
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of closers.splice(0)) await c();
});

async function scenario(name: string, make: () => Promise<{ options: Partial<IdrOptions>; expectReason: string }>) {
  it(`${name}: the page is byte-identical, within budget, and the drop is reported`, async () => {
    const baseline = await snapshot(makePage());
    const { options, expectReason } = await make();
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(baseOptions({ allowInsecureHttp: true, retry: false, onDeliveryResult: (r) => void results.push(r), ...options }));
    for (const mode of ["wait_until", "detached"] as const) {
      results.length = 0;
      const w = withWaitUntil(reqWithIp());
      const request = mode === "wait_until" ? w.request : reqWithIp();
      const t0 = performance.now();
      const out = await mw({ request, next: async () => makePage() });
      const added = performance.now() - t0;
      expect(added).toBeLessThan(BUDGET_MS);
      expect(await snapshot(out)).toEqual(baseline);
      await vi.waitFor(async () => {
        await Promise.all(w.pending);
        expect(results).toHaveLength(1);
      }, { timeout: 6000 });
      expect(results[0]).toMatchObject({ outcome: "dropped", reason: expectReason, mode });
    }
  });
}

describe("fail-open", () => {
  scenario("resolver answers 500", async () => {
    const fx = await startResolver({ kind: "status", code: 500 });
    closers.push(() => fx.close());
    return { options: { resolverUrl: fx.url }, expectReason: "http_5xx" };
  });

  scenario("resolver answers 503", async () => {
    const fx = await startResolver({ kind: "status", code: 503 });
    closers.push(() => fx.close());
    return { options: { resolverUrl: fx.url }, expectReason: "http_5xx" };
  });

  scenario("resolver answers 401 (bad token)", async () => {
    const fx = await startResolver({ kind: "status", code: 401 });
    closers.push(() => fx.close());
    return { options: { resolverUrl: fx.url }, expectReason: "http_4xx" };
  });

  scenario("resolver never answers (timeout)", async () => {
    const fx = await startResolver({ kind: "hang" });
    closers.push(() => fx.close());
    return { options: { resolverUrl: fx.url, timeoutMs: 300 }, expectReason: "timeout" };
  });

  scenario("network error (connection refused)", async () => {
    return { options: { resolverUrl: await closedPortUrl() }, expectReason: "network" };
  });

  scenario("unresolvable host", async () => {
    return { options: { resolverUrl: "https://resolver.invalid" }, expectReason: "network" };
  });

  scenario("fetch throws synchronously", async () => {
    return { options: { fetch: (() => { throw new Error("sync boom"); }) as unknown as typeof fetch }, expectReason: "network" };
  });

  scenario("fetch rejects with a non-error value", async () => {
    return { options: { fetch: (() => Promise.reject("nope")) as unknown as typeof fetch }, expectReason: "network" };
  });

  it("response body that stalls after headers is bounded by the timeout", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"version":"1"');
      // never ends
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(baseOptions({ resolverUrl: `http://127.0.0.1:${port}`, allowInsecureHttp: true, timeoutMs: 300, retry: false, onDeliveryResult: (r) => void results.push(r) }));
    const w = withWaitUntil(reqWithIp());
    const t0 = performance.now();
    await mw({ request: w.request, next: async () => makePage() });
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    await Promise.all(w.pending);
    // Headers arrived with 200, so the entrance counts as delivered even though the body never finished.
    expect(results[0]).toMatchObject({ outcome: "delivered" });
    expect(results[0]!.durationMs).toBeLessThan(2000);
  });

  it("an invalid resolver URL fails at creation (deploy-time), never at request time", () => {
    expect(() => createIdrServerMiddleware(baseOptions({ resolverUrl: "::::" }))).toThrow(/idr-tanstack/);
  });

  it("an invalid lazily-resolved URL leaves the page untouched", async () => {
    const baseline = await snapshot(makePage());
    const mw = createIdrServerMiddleware(() => baseOptions({ resolverUrl: "::::" }));
    const out = await mw({ request: reqWithIp(), next: async () => makePage() });
    expect(await snapshot(out)).toEqual(baseline);
  });

  it("a hung resolver does not delay the response even across many concurrent pages", async () => {
    const fx = await startResolver({ kind: "hang" });
    closers.push(() => fx.close());
    const mw = createIdrServerMiddleware(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true, timeoutMs: 400, retry: false, maxInFlight: 10 }));
    const pending: Promise<unknown>[] = [];
    const t0 = performance.now();
    const outs = await Promise.all(
      Array.from({ length: 40 }, async () => {
        const w = withWaitUntil(reqWithIp());
        pending.push(...w.pending);
        return mw({ request: w.request, next: async () => makePage() });
      }),
    );
    expect(performance.now() - t0).toBeLessThan(500);
    for (const o of outs) expect(o.status).toBe(200);
    await Promise.all(pending);
  });

  it("a browser navigation to the collector path (G5-D-F1): the page is byte-identical and nothing reaches the resolver", async () => {
    const fx = await startResolver({ kind: "ok" });
    closers.push(() => fx.close());
    const baseline = await snapshot(makePage());
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true, onDeliveryResult: (r) => void results.push(r) }));
    for (const method of ["GET", "HEAD"]) {
      for (const request of [reqWithIp("/idr/e"), new Request(reqWithIp("/idr/e"), { method })]) {
        const w = withWaitUntil(request);
        const t0 = performance.now();
        const out = await mw({ request: w.request, next: async () => makePage() });
        expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
        expect(await snapshot(out)).toEqual(baseline);
        await Promise.all(w.pending);
      }
    }
    expect(fx.captured).toHaveLength(0);
    expect(results.map((r) => `${r.outcome}/${r.reason}`)).toEqual(Array(4).fill("skipped/eligibility:collector_path"));
  });

  it("nothing is written to the console by any outcome", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const fx = await startResolver({ kind: "status", code: 500 });
    closers.push(() => fx.close());
    const mw = createIdrServerMiddleware(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true }));
    for (const r of [reqWithIp(), reqWithIp("/x.css"), reqWithIp("/p", "10.0.0.1")]) {
      const w = withWaitUntil(r);
      await mw({ request: w.request, next: async () => makePage() });
      await Promise.all(w.pending);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});
