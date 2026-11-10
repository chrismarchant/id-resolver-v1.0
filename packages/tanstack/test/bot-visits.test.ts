import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotVisitMiddleware, createIdrServerMiddleware, type BotVisitOptions, type DeliveryResult } from "../src/index.js";
import { resetRuntimeCache } from "../src/runtime.js";
import { baseOptions, PUBLIC_IP, req, reqWithIp, TEST_TOKEN, withWaitUntil } from "./helpers.js";
import { startResolver } from "./resolver-fixture.js";

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

const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const botOpts = (over: Partial<BotVisitOptions> = {}): BotVisitOptions => ({ resolverUrl: fx.url, allowInsecureHttp: true, token: TEST_TOKEN, websiteId: "example-site", ...over });
const html = (status = 200) => new Response(status === 304 ? null : "<html>page</html>", { status, headers: { "content-type": "text/html; charset=utf-8" } });
const botReq = (path = "/pricing", ua = GPTBOT, init: { method?: string; headers?: Record<string, string> } = {}) =>
  withWaitUntil(req(path, { "user-agent": ua, accept: "*/*", ...(init.headers ?? {}) }, { method: init.method ?? "GET", base: false }));

describe("createBotVisitMiddleware: human traffic", () => {
  it("passes a human request through untouched: same object returned, nothing sent, no hook call", async () => {
    const results: DeliveryResult[] = [];
    const mw = createBotVisitMiddleware(botOpts({ onDeliveryResult: (r) => void results.push(r) }));
    const { request, pending } = withWaitUntil(reqWithIp("/pricing"));
    const page = html();
    const out = await mw({ request, next: async () => page });
    expect(out).toBe(page);
    expect(pending).toHaveLength(0);
    expect(fx.captured).toHaveLength(0);
    expect(results).toEqual([]);
  });

  it("registered before the entrance middleware, leaves the entrance report of a human request exactly as without it", async () => {
    const idrAlone = createIdrServerMiddleware(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true }));
    const page = html();
    const a = withWaitUntil(reqWithIp("/blog/post?utm_medium=email", PUBLIC_IP, { referer: "https://www.example.com/" }));
    expect(await idrAlone({ request: a.request, next: async () => page })).toBe(page);
    await Promise.all(a.pending);

    const bots = createBotVisitMiddleware(botOpts());
    const idr = createIdrServerMiddleware(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true }));
    const b = withWaitUntil(reqWithIp("/blog/post?utm_medium=email", PUBLIC_IP, { referer: "https://www.example.com/" }));
    const out = await bots({ request: b.request, next: () => idr({ request: b.request, next: async () => page }) });
    expect(out).toBe(page);
    await Promise.all(b.pending);

    expect(fx.captured.map((c) => c.url)).toEqual(["/v1/entrances", "/v1/entrances"]);
    const strip = (body: string) => {
      const { entrance_id: _e, occurred_at: _o, ...rest } = JSON.parse(body) as Record<string, unknown>;
      return rest;
    };
    expect(strip(fx.captured[1]!.body)).toEqual(strip(fx.captured[0]!.body));
    expect(b.pending).toHaveLength(1);
  });

  it("a page error from next() propagates unchanged and nothing is sent", async () => {
    const mw = createBotVisitMiddleware(botOpts());
    const { request } = botReq();
    const boom = new Error("page failed");
    await expect(mw({ request, next: async () => Promise.reject(boom) })).rejects.toBe(boom);
    expect(fx.captured).toHaveLength(0);
  });
});

describe("createBotVisitMiddleware: bot visits", () => {
  it("records a bot's page visit as one bot-visit.v1 body: no IP, no user agent, path-only page_key, after next()", async () => {
    const results: DeliveryResult[] = [];
    const mw = createBotVisitMiddleware(botOpts({ onDeliveryResult: (r) => void results.push(r) }));
    const { request, pending } = botReq("/account/person@example.com/orders/12345?session=abc#x", GPTBOT, { headers: { cookie: "sid=secret", "x-client-ip": PUBLIC_IP } });
    const page = html();
    const out = await mw({
      request,
      next: async () => {
        expect(fx.captured).toHaveLength(0);
        return page;
      },
    });
    expect(out).toBe(page);
    await Promise.all(pending);
    expect(fx.captured).toHaveLength(1);
    const c = fx.captured[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("/v1/bot-visits");
    expect(c.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    const body = JSON.parse(c.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["bot_category", "bot_name", "contract", "occurred_at", "page_key", "user_agent_family", "visit_id", "website_id"]);
    expect(body).toMatchObject({
      contract: "bot-visit.v1",
      website_id: "example-site",
      page_key: "/account/:email/orders/:n",
      bot_name: "GPTBot",
      bot_category: "ai_crawler",
      user_agent_family: "GPTBot",
    });
    expect(body["visit_id"]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(body["occurred_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    for (const secret of [PUBLIC_IP, "openai.com", "Mozilla", "secret", "session", "person@example.com", "12345"]) expect(c.body).not.toContain(secret);
    expect(results).toEqual([expect.objectContaining({ outcome: "delivered", mode: "wait_until", httpStatus: 200 })]);
  });

  it("each bot visit gets a fresh visit_id", async () => {
    const mw = createBotVisitMiddleware(botOpts());
    for (let i = 0; i < 3; i++) {
      const { request, pending } = botReq();
      await mw({ request, next: async () => html() });
      await Promise.all(pending);
    }
    const ids = fx.captured.map((c) => (JSON.parse(c.body) as { visit_id: string }).visit_id);
    expect(new Set(ids).size).toBe(3);
  });

  it.each([
    ["GET 200", "GET", "/pricing", 200, true],
    ["HEAD 200", "HEAD", "/", 200, true],
    ["GET 304 (revalidation)", "GET", "/blog", 304, true],
    ["robots.txt", "GET", "/robots.txt", 200, true],
    ["sitemap.xml", "GET", "/sitemap.xml", 200, true],
    ["llms.txt", "GET", "/llms.txt", 200, true],
    ["POST", "POST", "/pricing", 200, false],
    ["a redirect", "GET", "/old", 301, false],
    ["a 404", "GET", "/wp-login.php", 404, false],
    ["a 500", "GET", "/pricing", 500, false],
    ["a script", "GET", "/main.js", 200, false],
    ["an image", "GET", "/images/logo.png", 200, false],
    ["build assets", "GET", "/assets/index-abc.css", 200, false],
    ["a server function", "GET", "/_serverFn/abc123", 200, false],
    ["the collector route", "GET", "/idr/e", 200, false],
  ] as const)("%s → recorded: %s", async (_label, method, path, status, recorded) => {
    const results: DeliveryResult[] = [];
    const mw = createBotVisitMiddleware(botOpts({ onDeliveryResult: (r) => void results.push(r) }));
    const { request, pending } = botReq(path, GOOGLEBOT, { method });
    await mw({ request, next: async () => html(status) });
    await Promise.all(pending);
    expect(fx.captured).toHaveLength(recorded ? 1 : 0);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe(recorded ? "delivered" : "skipped");
    if (!recorded) expect(results[0]!.reason).toMatch(/^bot:/);
  });

  it("a server-function request (x-tsr-serverfn) is not recorded", async () => {
    const mw = createBotVisitMiddleware(botOpts());
    const { request, pending } = botReq("/pricing", GOOGLEBOT, { headers: { "x-tsr-serverfn": "true" } });
    await mw({ request, next: async () => html() });
    await Promise.all(pending);
    expect(fx.captured).toHaveLength(0);
  });

  it("a bot request stays out of the entrance report (the entrance middleware's own bot rule) and is recorded once as a bot visit", async () => {
    const bots = createBotVisitMiddleware(botOpts());
    const idr = createIdrServerMiddleware(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true }));
    const { request, pending } = withWaitUntil(reqWithIp("/pricing", PUBLIC_IP, { "user-agent": GPTBOT }));
    const page = html();
    expect(await bots({ request, next: () => idr({ request, next: async () => page }) })).toBe(page);
    await Promise.all(pending);
    expect(fx.captured.map((c) => c.url)).toEqual(["/v1/bot-visits"]);
  });
});

describe("createBotVisitMiddleware: never slows or breaks the page", () => {
  it("returns before the resolver answers (it never does here); the send runs under waitUntil", async () => {
    await fx.close();
    fx = await startResolver({ kind: "hang" });
    const mw = createBotVisitMiddleware(botOpts({ timeoutMs: 250, retry: false }));
    const { request, pending } = botReq();
    const t0 = Date.now();
    const page = html();
    expect(await mw({ request, next: async () => page })).toBe(page);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });

  it("on an edge isolate without waitUntil it drops the visit instead of waiting", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const results: DeliveryResult[] = [];
    const mw = createBotVisitMiddleware(botOpts({ onDeliveryResult: (r) => void results.push(r) }));
    const request = req("/pricing", { "user-agent": GPTBOT }, { base: false });
    const page = html();
    expect(await mw({ request, next: async () => page })).toBe(page);
    expect(results).toEqual([expect.objectContaining({ outcome: "skipped", reason: "no_background_context", mode: "none" })]);
    expect(fx.captured).toHaveLength(0);
  });

  it("a resolver error is a dropped result, never a page error", async () => {
    await fx.close();
    fx = await startResolver({ kind: "status", code: 500 });
    const results: DeliveryResult[] = [];
    const mw = createBotVisitMiddleware(botOpts({ onDeliveryResult: (r) => void results.push(r) }));
    const { request, pending } = botReq();
    const page = html();
    expect(await mw({ request, next: async () => page })).toBe(page);
    await Promise.all(pending);
    expect(results).toEqual([expect.objectContaining({ outcome: "dropped", reason: "http_5xx" })]);
  });

  it("drops above maxInFlight with reason overload", async () => {
    await fx.close();
    fx = await startResolver({ kind: "hang" });
    const results: DeliveryResult[] = [];
    const mw = createBotVisitMiddleware(botOpts({ maxInFlight: 2, timeoutMs: 250, retry: false, onDeliveryResult: (r) => void results.push(r) }));
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      const { request, pending } = botReq();
      await mw({ request, next: async () => html() });
      all.push(...pending);
    }
    expect(results.filter((r) => r.reason === "overload")).toHaveLength(2);
    await Promise.all(all);
  });

  it("an invalid lazy configuration disables recording once (config_invalid) and never affects the page", async () => {
    const results: DeliveryResult[] = [];
    const mw = createBotVisitMiddleware(() => ({ resolverUrl: "", token: "short", websiteId: "Bad Site", onDeliveryResult: (r: DeliveryResult) => void results.push(r) }));
    for (let i = 0; i < 2; i++) {
      const { request, pending } = botReq();
      const page = html();
      expect(await mw({ request, next: async () => page })).toBe(page);
      await Promise.all(pending);
    }
    expect(results).toEqual([expect.objectContaining({ outcome: "skipped", reason: "config_invalid" })]);
    expect(fx.captured).toHaveLength(0);
  });

  it("refuses an invalid eager configuration at creation, and refuses to run in a browser", () => {
    expect(() => createBotVisitMiddleware({ resolverUrl: "https://resolver.example.com", token: "short", websiteId: "example-site" })).toThrow(/token/);
    vi.stubGlobal("window", {});
    expect(() => createBotVisitMiddleware(botOpts())).toThrow(/server/);
  });
});
