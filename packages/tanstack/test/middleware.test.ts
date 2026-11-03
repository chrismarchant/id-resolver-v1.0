import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdrServerMiddleware, type DeliveryResult, type IdrOptions } from "../src/index.js";
import { resetRuntimeCache } from "../src/runtime.js";
import { baseOptions, PUBLIC_IP, reqWithIp, TEST_TOKEN, validateEntranceV1, withWaitUntil } from "./helpers.js";
import { closedPortUrl, startResolver } from "./resolver-fixture.js";

type Fixture = Awaited<ReturnType<typeof startResolver>>;
let fx: Fixture;
beforeEach(async () => {
  fx = await startResolver({ kind: "ok" });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetRuntimeCache();
  await fx.close();
});

const opts = (over: Partial<IdrOptions> = {}): IdrOptions => baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true, ...over });
const html = () => new Response("<html><body>page</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-app": "1" } });
const nextOf = (r: Response) => async () => r;

describe("middleware: pass-through and scheduling (waitUntil available)", () => {
  it("calls next() first, then reports; returns the very same object untouched", async () => {
    const order: string[] = [];
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ onDeliveryResult: (r) => void results.push(r) }));
    const { request, pending } = withWaitUntil(reqWithIp("/pricing?plan=x"));
    const page = html();
    const out = await mw({
      request,
      next: async () => {
        order.push("next");
        expect(fx.captured).toHaveLength(0);
        return page;
      },
    });
    order.push("returned");
    expect(out).toBe(page);
    expect([...page.headers.keys()].sort()).toEqual(["content-type", "x-app"]);
    expect(page.headers.get("set-cookie")).toBeNull();
    await Promise.all(pending);
    expect(order).toEqual(["next", "returned"]);
    expect(fx.captured).toHaveLength(1);
    expect(await page.text()).toBe("<html><body>page</body></html>");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "delivered", reason: "ok", mode: "wait_until", attempts: 1, httpStatus: 200, resolverStatus: "qualified", recorded: true });
  });

  it("returns a TanStack-style context result (object with .response) unchanged", async () => {
    const mw = createIdrServerMiddleware(opts());
    const { request, pending } = withWaitUntil(reqWithIp());
    const ctx = { request, pathname: "/pricing", context: {}, response: html() };
    const out = await mw({ request, next: async () => ctx });
    expect(out).toBe(ctx);
    expect(Object.keys(out).sort()).toEqual(["context", "pathname", "request", "response"]);
    await Promise.all(pending);
    expect(fx.captured).toHaveLength(1);
  });

  it("sends the contract request: POST /v1/entrances, bearer token, JSON, valid entrance.v1 body", async () => {
    const mw = createIdrServerMiddleware(opts());
    const { request, pending } = withWaitUntil(reqWithIp("/blog/post?utm_medium=email", PUBLIC_IP, { referer: "https://www.example.com/" }));
    await mw({ request, next: nextOf(html()) });
    await Promise.all(pending);
    const c = fx.captured[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("/v1/entrances");
    expect(c.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(c.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(c.body);
    expect(validateEntranceV1(body)).toEqual([]);
    expect(body).toMatchObject({ contract: "entrance.v1", website_id: "example-site", ip: PUBLIC_IP, page_key: "/blog/post", acquisition: "internal", eligibility: "tsa-1" });
  });

  it("each request gets a fresh entrance_id", async () => {
    const mw = createIdrServerMiddleware(opts());
    for (let i = 0; i < 3; i++) {
      const { request, pending } = withWaitUntil(reqWithIp());
      await mw({ request, next: nextOf(html()) });
      await Promise.all(pending);
    }
    const ids = fx.captured.map((c) => JSON.parse(c.body).entrance_id);
    expect(new Set(ids).size).toBe(3);
  });

  it("a base path in resolverUrl is kept", async () => {
    const mw = createIdrServerMiddleware(opts({ resolverUrl: `${fx.url}/idr/` }));
    const { request, pending } = withWaitUntil(reqWithIp());
    await mw({ request, next: nextOf(html()) });
    await Promise.all(pending);
    expect(fx.captured[0]!.url).toBe("/idr/v1/entrances");
  });

  it("does not report ineligible requests, untrusted IPs, or none-policy", async () => {
    const cases: Array<[string, IdrOptions, Request]> = [
      ["bot", opts(), reqWithIp("/pricing", PUBLIC_IP, { "user-agent": "Googlebot/2.1" })],
      ["asset", opts(), reqWithIp("/a.css")],
      ["private ip", opts(), reqWithIp("/pricing", "10.0.0.1")],
      ["none policy", opts({ trustPolicy: { mode: "none" } }), reqWithIp()],
      ["no ip header", opts(), new Request("https://www.example.com/pricing", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } })],
    ];
    for (const [, o, r] of cases) {
      const mw = createIdrServerMiddleware(o);
      const { request, pending } = withWaitUntil(r);
      const page = html();
      expect(await mw({ request, next: nextOf(page) })).toBe(page);
      await Promise.all(pending);
    }
    expect(fx.captured).toHaveLength(0);
  });

  it.each([
    ["404", new Response("nf", { status: 404, headers: { "content-type": "text/html" } })],
    ["500", new Response("err", { status: 500, headers: { "content-type": "text/html" } })],
    ["redirect", new Response(null, { status: 302, headers: { location: "/x" } })],
    ["json", new Response("{}", { status: 200, headers: { "content-type": "application/json" } })],
  ])("does not report a %s response", async (_n, res) => {
    const mw = createIdrServerMiddleware(opts());
    const { request, pending } = withWaitUntil(reqWithIp());
    expect(await mw({ request, next: nextOf(res) })).toBe(res);
    await Promise.all(pending);
    expect(fx.captured).toHaveLength(0);
  });

  it("propagates an error thrown by next() and reports nothing", async () => {
    const mw = createIdrServerMiddleware(opts());
    const { request, pending } = withWaitUntil(reqWithIp());
    await expect(mw({ request, next: async () => { throw new Error("render failed"); } })).rejects.toThrow("render failed");
    await Promise.all(pending);
    expect(fx.captured).toHaveLength(0);
  });
});

describe("middleware: background context selection", () => {
  it("long-lived runtime without waitUntil: detached, no retry", async () => {
    await fx.close();
    fx = await startResolver({ kind: "sequence", steps: [{ kind: "status", code: 503 }, { kind: "ok" }] });
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ resolverUrl: fx.url, onDeliveryResult: (r) => void results.push(r) }));
    const page = html();
    const t0 = Date.now();
    expect(await mw({ request: reqWithIp(), next: nextOf(page) })).toBe(page);
    expect(Date.now() - t0).toBeLessThan(150);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ outcome: "dropped", reason: "http_5xx", mode: "detached", attempts: 1, httpStatus: 503 });
    expect(fx.captured).toHaveLength(1);
  });

  it("Workers without request.waitUntil: uses cloudflare:workers import when present, otherwise drops", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ onDeliveryResult: (r) => void results.push(r) }));
    const page = html();
    expect(await mw({ request: reqWithIp(), next: nextOf(page) })).toBe(page);
    // `cloudflare:workers` cannot be imported under Node, so the default is to drop.
    expect(results).toEqual([expect.objectContaining({ outcome: "skipped", reason: "no_background_context", mode: "none" })]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fx.captured).toHaveLength(0);
  });

  it("edge isolate without waitUntil + onUnsupportedBackground:await: bounded blocking delivery", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ onUnsupportedBackground: "await", blockingBudgetMs: 100, onDeliveryResult: (r) => void results.push(r) }));
    const page = html();
    expect(await mw({ request: reqWithIp(), next: nextOf(page) })).toBe(page);
    expect(fx.captured).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "delivered", mode: "blocking", attempts: 1 });
  });

  it("blocking mode never adds more than blockingBudgetMs (+ scheduling slack) against a hanging resolver", async () => {
    await fx.close();
    fx = await startResolver({ kind: "hang" });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ resolverUrl: fx.url, onUnsupportedBackground: "await", blockingBudgetMs: 120, timeoutMs: 5000, onDeliveryResult: (r) => void results.push(r) }));
    const page = html();
    const t0 = Date.now();
    expect(await mw({ request: reqWithIp(), next: nextOf(page) })).toBe(page);
    const added = Date.now() - t0;
    expect(added).toBeGreaterThanOrEqual(100);
    expect(added).toBeLessThan(120 + 250);
    expect(results[0]).toMatchObject({ outcome: "dropped", reason: "timeout", mode: "blocking", attempts: 1 });
  });
});

describe("middleware: retry policy (only with waitUntil)", () => {
  async function run(steps: Parameters<typeof startResolver>[0], over: Partial<IdrOptions> = {}) {
    await fx.close();
    fx = await startResolver(steps);
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ resolverUrl: fx.url, retryDelayMs: 10, onDeliveryResult: (r) => void results.push(r), ...over }));
    const { request, pending } = withWaitUntil(reqWithIp());
    await mw({ request, next: nextOf(html()) });
    await Promise.all(pending);
    return { results, calls: fx.captured };
  }

  it("503 then 200: one retry, same entrance_id (idempotent)", async () => {
    const { results, calls } = await run({ kind: "sequence", steps: [{ kind: "status", code: 503 }, { kind: "ok" }] });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body).entrance_id).toBe(JSON.parse(calls[1]!.body).entrance_id);
    expect(results[0]).toMatchObject({ outcome: "delivered", attempts: 2 });
  });

  it.each([429, 502, 503, 504])("retries once on %i then drops", async (code) => {
    const { results, calls } = await run({ kind: "status", code });
    expect(calls).toHaveLength(2);
    expect(results[0]).toMatchObject({ outcome: "dropped", attempts: 2, httpStatus: code });
  });

  it.each([400, 401, 403, 404, 413, 500])("does not retry %i", async (code) => {
    const { results, calls } = await run({ kind: "status", code });
    expect(calls).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "dropped", attempts: 1, httpStatus: code });
  });

  it("reason vocabulary: 4xx, 429, 5xx", async () => {
    expect((await run({ kind: "status", code: 401 })).results[0]!.reason).toBe("http_4xx");
    expect((await run({ kind: "status", code: 429 })).results[0]!.reason).toBe("http_429");
    expect((await run({ kind: "status", code: 500 })).results[0]!.reason).toBe("http_5xx");
  });

  it("a long Retry-After is a drop, not a wait", async () => {
    const t0 = Date.now();
    const { results, calls } = await run({ kind: "status", code: 429, headers: { "retry-after": "120" } });
    expect(calls).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "dropped", reason: "http_429", attempts: 1 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("retry:false disables the retry", async () => {
    const { calls } = await run({ kind: "status", code: 503 }, { retry: false });
    expect(calls).toHaveLength(1);
  });

  it("a redirect is never followed", async () => {
    const other = await startResolver();
    const { results, calls } = await run({ kind: "redirect", to: other.url + "/v1/entrances" });
    expect(calls).toHaveLength(1);
    expect(other.captured).toHaveLength(0);
    expect(results[0]).toMatchObject({ outcome: "dropped" });
    await other.close();
  });

  it("an unreadable 200 body still counts as delivered", async () => {
    const { results } = await run({ kind: "bad-json" });
    expect(results[0]).toMatchObject({ outcome: "delivered", attempts: 1 });
    expect(results[0]).not.toHaveProperty("resolverStatus");
  });
});

describe("middleware: overload and hook safety", () => {
  it("drops above maxInFlight with reason overload and recovers", async () => {
    await fx.close();
    fx = await startResolver({ kind: "hang" });
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ resolverUrl: fx.url, maxInFlight: 2, timeoutMs: 400, retry: false, onDeliveryResult: (r) => void results.push(r) }));
    const pendings: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const { request, pending } = withWaitUntil(reqWithIp());
      await mw({ request, next: nextOf(html()) });
      pendings.push(...pending);
    }
    expect(results.filter((r) => r.reason === "overload")).toHaveLength(3);
    await Promise.all(pendings);
    expect(results.filter((r) => r.reason === "timeout")).toHaveLength(2);
    const { request, pending } = withWaitUntil(reqWithIp());
    await mw({ request, next: nextOf(html()) });
    await Promise.all(pending);
    expect(results.filter((r) => r.reason === "overload")).toHaveLength(3); // capacity is back
  });

  it("a throwing or rejecting hook never reaches the page", async () => {
    for (const hook of [(): void => { throw new Error("hook boom"); }, (): Promise<void> => Promise.reject(new Error("hook async boom"))]) {
      const mw = createIdrServerMiddleware(opts({ onDeliveryResult: hook }));
      const { request, pending } = withWaitUntil(reqWithIp());
      const page = html();
      expect(await mw({ request, next: nextOf(page) })).toBe(page);
      await expect(Promise.all(pending)).resolves.toBeDefined();
      // ineligible path also fires the hook
      const r2 = reqWithIp("/a.css");
      expect(await mw({ request: r2, next: nextOf(page) })).toBe(page);
    }
  });

  it("hook results are non-identifying: no IP, token, path, URL or header values", async () => {
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware(opts({ onDeliveryResult: (r) => void results.push(r) }));
    for (const r of [reqWithIp("/secret-path?x=1"), reqWithIp("/a.css"), reqWithIp("/p", "10.0.0.8")]) {
      const w = withWaitUntil(r);
      await mw({ request: w.request, next: nextOf(html()) });
      await Promise.all(w.pending);
    }
    const text = JSON.stringify(results);
    for (const secret of [PUBLIC_IP, "10.0.0.8", TEST_TOKEN, "secret-path", fx.url, "127.0.0.1", "example.com"]) expect(text).not.toContain(secret);
    for (const r of results) expect(Object.keys(r).every((k) => ["outcome", "reason", "mode", "attempts", "httpStatus", "resolverStatus", "recorded", "durationMs"].includes(k))).toBe(true);
  });
});

describe("middleware: construction and configuration", () => {
  it("throws at creation in a browser-like environment", () => {
    vi.stubGlobal("window", {});
    expect(() => createIdrServerMiddleware(opts())).toThrow(/server/);
    expect(() => createIdrServerMiddleware(() => opts())).toThrow(/server/);
  });

  const bad: Array<[string, Partial<IdrOptions>]> = [
    ["http url", { resolverUrl: "http://resolver.example.com", allowInsecureHttp: false }],
    ["invalid url", { resolverUrl: "not a url" }],
    ["empty url", { resolverUrl: "" }],
    ["ftp url", { resolverUrl: "ftp://resolver.example.com" }],
    ["url with credentials", { resolverUrl: "https://user:pw@example.com" }],
    ["url with query", { resolverUrl: "https://resolver.example.com/?a=1" }],
    ["short token", { token: "short" }],
    ["31-char token", { token: "a".repeat(31) }],
    ["token with space", { token: "a".repeat(31) + " " }],
    ["token with newline", { token: "a".repeat(40) + "\n" }],
    ["empty websiteId", { websiteId: "" }],
    ["upper-case websiteId", { websiteId: "Example" }],
    ["websiteId leading hyphen", { websiteId: "-example" }],
    ["websiteId too long", { websiteId: "a".repeat(64) }],
    ["missing trust policy", { trustPolicy: undefined as never }],
    ["bad trust policy", { trustPolicy: { mode: "xff", trustedHops: 0 } }],
    ["timeout too low", { timeoutMs: 10 }],
    ["timeout too high", { timeoutMs: 60_000 }],
    ["blocking budget too high", { blockingBudgetMs: 5000 }],
    ["maxInFlight zero", { maxInFlight: 0 }],
    ["bad background mode", { onUnsupportedBackground: "wait" as never }],
  ];
  it.each(bad)("rejects %s at creation, without echoing the token or URL", (_n, over) => {
    const o = { ...baseOptions(), ...over } as IdrOptions;
    let message = "";
    try {
      createIdrServerMiddleware(o);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^idr-tanstack:/);
    expect(message).not.toContain(TEST_TOKEN);
    expect(message).not.toContain("resolver.example.com");
    expect(message).not.toContain("user:pw");
  });

  it("accepts http only with allowInsecureHttp, https always", () => {
    expect(() => createIdrServerMiddleware(baseOptions({ resolverUrl: "http://localhost:3000", allowInsecureHttp: true }))).not.toThrow();
    expect(() => createIdrServerMiddleware(baseOptions({ resolverUrl: "https://resolver.example.com/" }))).not.toThrow();
  });

  it("lazy options: evaluated on first use, not at creation", async () => {
    const factory = vi.fn(() => opts());
    const mw = createIdrServerMiddleware(factory);
    expect(factory).not.toHaveBeenCalled();
    const { request, pending } = withWaitUntil(reqWithIp());
    await mw({ request, next: nextOf(html()) });
    await Promise.all(pending);
    expect(factory).toHaveBeenCalledTimes(1);
    const w2 = withWaitUntil(reqWithIp());
    await mw({ request: w2.request, next: nextOf(html()) });
    await Promise.all(w2.pending);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fx.captured).toHaveLength(2);
  });

  it("lazy options that are invalid or throw: page unaffected, reported once, stays disabled", async () => {
    const results: DeliveryResult[] = [];
    const factory = vi.fn(() => baseOptions({ token: "short", onDeliveryResult: (r) => void results.push(r) }));
    const mw = createIdrServerMiddleware(factory);
    for (let i = 0; i < 3; i++) {
      const page = html();
      expect(await mw({ request: reqWithIp(), next: nextOf(page) })).toBe(page);
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(results).toEqual([expect.objectContaining({ outcome: "skipped", reason: "config_invalid" })]);

    const throwing = createIdrServerMiddleware(() => { throw new Error("missing env"); });
    const page = html();
    expect(await throwing({ request: reqWithIp(), next: nextOf(page) })).toBe(page);
  });
});
