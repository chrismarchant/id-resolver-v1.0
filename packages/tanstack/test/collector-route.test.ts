import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEntrance,
  compileRouteTemplates,
  composePageKeyMapper,
  createCollectorRoute,
  normalisePageKey,
  type CollectorRouteOptions,
  type DeliveryResult,
} from "../src/index.js";
import { resetRuntimeCache } from "../src/runtime.js";
import { baseOptions, EVENT_V1_KEYS, TEST_TOKEN, validateEventV1, withWaitUntil } from "./helpers.js";
import { closedPortUrl, startResolver } from "./resolver-fixture.js";

const SITE = "https://www.example.com";
const RESOLVER = "https://resolver.example.com";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetRuntimeCache();
});

let counter = 0;
/** A fresh, valid event_id (22 characters). */
const id = () => `evt${String(++counter).padStart(6, "0")}abcdefghijklm`;
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, event_id: id(), occurred_at: iso(), type: "conversion_intent", name: "cta_click", path: "/pricing", consent: "granted", ...over };
}

const BROWSER: Record<string, string> = { origin: SITE, "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8" };

function post(body: unknown, headers: Record<string, string | null> = {}, init: { method?: string; url?: string } = {}): Request {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...BROWSER, ...headers })) if (v !== null) h[k] = v;
  const method = init.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(init.url ?? `${SITE}/idr/e`, { method, headers: h, ...(hasBody ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}

interface Forwarded {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  body: Record<string, unknown>;
}

/** A fake resolver fetch: records exactly what the route forwards. */
function fakeResolver(status = 200) {
  const forwarded: Forwarded[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const bodyText = String(init?.body);
    forwarded.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), bodyText, body: JSON.parse(bodyText) as Record<string, unknown> });
    return status === 200 ? new Response(JSON.stringify({ version: "1", recorded: true }), { status: 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ version: "1", error: "x" }), { status });
  });
  return { forwarded, fetch: fetchFn as unknown as typeof fetch };
}

function setup(over: Partial<CollectorRouteOptions> = {}, status = 200) {
  const r = fakeResolver(status);
  const results: DeliveryResult[] = [];
  const route = createCollectorRoute({
    resolverUrl: RESOLVER,
    token: TEST_TOKEN,
    websiteId: "example-site",
    allow: ["page_view", "cta_click", "scroll_50", "form_start", "form_submit"],
    fetch: r.fetch,
    onDeliveryResult: (x) => void results.push(x),
    ...over,
  });
  /** Sends one request with a waitUntil context and waits for the background delivery. */
  async function send(request: Request): Promise<Response> {
    const { pending } = withWaitUntil(request);
    const res = await route({ request });
    await Promise.all(pending);
    return res;
  }
  const reasons = () => results.filter((x) => x.outcome === "skipped").map((x) => x.reason);
  return { route, send, forwarded: r.forwarded, fetch: r.fetch, results, reasons };
}

async function expectBare(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(await res.text()).toBe("");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  const names = [...res.headers.keys()].sort();
  expect(names).toEqual(status === 405 ? ["allow", "cache-control"] : ["cache-control"]);
}

describe("collector route: an accepted event", () => {
  it("answers a bare 204 and forwards exactly the event.v1 body to <resolverUrl>/v1/events with the server token", async () => {
    const t = setup();
    const e = event({ type: "page_view", name: "page_view" });
    const res = await t.send(post(e));
    await expectBare(res, 204);
    expect(t.forwarded).toHaveLength(1);
    const f = t.forwarded[0]!;
    expect(f.url).toBe(`${RESOLVER}/v1/events`);
    expect(f.headers).toEqual({ authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json", accept: "application/json" });
    expect(Object.keys(f.body).sort()).toEqual(EVENT_V1_KEYS);
    expect(validateEventV1(f.body)).toEqual([]);
    expect(f.body).toEqual({ contract: "event.v1", website_id: "example-site", event_id: e["event_id"], occurred_at: e["occurred_at"], type: "page_view", name: "page_view", page_key: "/pricing", consent: "granted" });
    expect(t.results).toEqual([expect.objectContaining({ outcome: "delivered", reason: "ok", mode: "wait_until", attempts: 1, httpStatus: 200, recorded: true })]);
  });

  it("accepts the TanStack handler context and a plain Request", async () => {
    const t = setup();
    expect((await t.route({ request: post(event()) })).status).toBe(204);
    expect((await t.route(post(event()))).status).toBe(204);
    await vi.waitFor(() => expect(t.forwarded).toHaveLength(2));
  });

  it("keeps a base path in resolverUrl", async () => {
    const t = setup({ resolverUrl: `${RESOLVER}/idr/` });
    await t.send(post(event()));
    expect(t.forwarded[0]!.url).toBe(`${RESOLVER}/idr/v1/events`);
  });

  it("forwards occurred_at in canonical whole-second UTC", async () => {
    const t = setup();
    const ms = Date.now() - 5_000;
    await t.send(post(event({ occurred_at: new Date(ms).toISOString() })));
    expect(t.forwarded[0]!.body["occurred_at"]).toBe(iso(ms));
  });

  it("maps path to page_key with the same composed mapper as the entrance middleware", async () => {
    const pageKeyMapper = compileRouteTemplates(["/blog/:slug"]);
    const t = setup({ pageKeyMapper });
    const paths = ["/blog/my-post", "/orders/12345", "/reset/9f86d081884c7d659a2feaa0c55ad015", "/u/person%40example.com", "/case-studies/", "//double//slash", "/" + "seg/".repeat(80)];
    for (const path of paths) await t.send(post(event({ path })));
    const keys = t.forwarded.map((f) => f.body["page_key"]);
    const viaMiddleware = paths.map((path) => {
      const built = buildEntrance(new Request(`${SITE}${path.startsWith("//") ? path.replace(/^\/+/, "/") : path}`, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0", "x-client-ip": "198.51.100.23" } }), baseOptions({ pageKeyMapper }));
      return built.ok ? built.payload.page_key : `not-built:${built.reason}`;
    });
    expect(keys).toEqual(paths.map((p) => normalisePageKey(p, composePageKeyMapper(pageKeyMapper))));
    expect(keys).toEqual(viaMiddleware);
    expect(keys.slice(0, 4)).toEqual(["/blog/:slug", "/orders/:n", "/reset/:token", "/u/:email"]);
    for (const k of keys) expect(String(k).length).toBeLessThanOrEqual(256);
  });

  it("works with a shared options object that includes the middleware's trustPolicy (ignored: no IP is ever read)", async () => {
    const r = fakeResolver();
    const shared = baseOptions({ fetch: r.fetch });
    const route = createCollectorRoute({ ...shared, allow: ["cta_click"] });
    const req = post(event(), { "x-client-ip": "198.51.100.23" });
    const { pending } = withWaitUntil(req);
    expect((await route(req)).status).toBe(204);
    await Promise.all(pending);
    expect(r.forwarded[0]!.bodyText).not.toContain("198.51.100.23");
  });
});

describe("collector route: never forwards an IP, cookie, user agent, referrer or any other header", () => {
  const HOSTILE: Record<string, string> = {
    "cf-connecting-ip": "203.0.113.9",
    "x-forwarded-for": "198.51.100.7, 192.0.2.1",
    "x-real-ip": "192.0.2.44",
    "true-client-ip": "203.0.113.77",
    "x-client-ip": "198.51.100.99",
    forwarded: "for=192.0.2.60;proto=https",
    cookie: "session=secret-cookie-value; _ga=GA1.1.123456789.987654321",
    "user-agent": "SecretAgent/1.0 (fingerprint-me)",
    referer: "https://www.example.com/secret-page?token=abc123",
    authorization: "Bearer browser-supplied-secret",
    "x-custom": "custom-secret-header",
  };

  it("the forwarded body has exactly the event.v1 keys and none of the request's header values; the forwarded headers are the route's own", async () => {
    const t = setup();
    const res = await t.send(post(event(), HOSTILE));
    expect(res.status).toBe(204);
    expect(t.forwarded).toHaveLength(1);
    const f = t.forwarded[0]!;
    expect(Object.keys(f.body).sort()).toEqual(EVENT_V1_KEYS);
    for (const v of Object.values(HOSTILE)) {
      for (const part of v.split(/[;,= ]+/).filter((p) => p.length >= 6)) expect(f.bodyText).not.toContain(part);
    }
    for (const needle of ["203.0.113", "198.51.100", "192.0.2", "secret", "SecretAgent", "GA1", "token", "abc123"]) expect(f.bodyText).not.toContain(needle);
    expect(f.headers).toEqual({ authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json", accept: "application/json" });
    expect(JSON.stringify(t.results)).not.toMatch(/203\.0\.113|198\.51\.100|192\.0\.2|secret/);
  });

  it("reads only Origin, Sec-Fetch-Site, Content-Type, Content-Length and Sec-GPC, and never enumerates the headers", async () => {
    const t = setup();
    const req = post(event(), HOSTILE);
    const read: string[] = [];
    const h = req.headers;
    const realGet = h.get.bind(h);
    vi.spyOn(h, "get").mockImplementation((name: string) => (read.push(name.toLowerCase()), realGet(name)));
    const enumerators = (["has", "forEach", "entries", "keys", "values", "getSetCookie"] as const).map((m) => vi.spyOn(h, m));
    const iter = vi.spyOn(h, Symbol.iterator as unknown as "entries");
    expect((await t.send(req)).status).toBe(204);
    expect(new Set(read)).toEqual(new Set(["origin", "sec-fetch-site", "content-type", "content-length", "sec-gpc"]));
    for (const e of [...enumerators, iter]) expect(e).not.toHaveBeenCalled();
  });

  it("the route module does not import the trust policy or IP code, and EventPayload has no ip field", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/collector-route.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/(?:trust|ip|build|eligibility)\.js["']/);
    expect(src).not.toMatch(/selectClientIp|parsePublicIp|cf-connecting-ip|x-forwarded-for|x-real-ip|user-agent|["']cookie["']|["']referer["']/i);
    const types = readFileSync(resolve(import.meta.dirname, "../src/types.ts"), "utf8");
    const eventPayload = /export interface EventPayload \{([\s\S]*?)\n\}/.exec(types)![1]!;
    const fields = [...eventPayload.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(EVENT_V1_KEYS);
  });
});

describe("collector route: CSRF-style origin checks", () => {
  it.each([
    ["missing Origin", { origin: null }],
    ["foreign Origin", { origin: "https://evil.example.net" }],
    ["opaque Origin", { origin: "null" }],
    ["scheme mismatch", { origin: "http://www.example.com" }],
    ["sibling subdomain", { origin: "https://shop.example.com" }],
    ["Origin with a path", { origin: "https://www.example.com/" }],
  ])("%s: 403, nothing forwarded", async (_n, headers) => {
    const t = setup();
    await expectBare(await t.send(post(event(), headers)), 403);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:origin"]);
  });

  it.each(["cross-site", "same-site", "none"])("Sec-Fetch-Site: %s: 403", async (site) => {
    const t = setup();
    await expectBare(await t.send(post(event(), { "sec-fetch-site": site })), 403);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:sec_fetch_site"]);
  });

  it("no Sec-Fetch-Site header (older browsers) with the right Origin: accepted", async () => {
    const t = setup();
    expect((await t.send(post(event(), { "sec-fetch-site": null }))).status).toBe(204);
    expect(t.forwarded).toHaveLength(1);
  });

  it("origins option: the configured site origins are accepted, the request URL's own origin no longer is", async () => {
    const t = setup({ origins: ["https://www.example.com", "https://shop.example.com"] });
    const behindProxy = { url: "http://10.0.0.5:3000/idr/e" };
    expect((await t.send(post(event(), { origin: "https://shop.example.com" }, behindProxy))).status).toBe(204);
    expect((await t.send(post(event(), { origin: "https://www.example.com" }, behindProxy))).status).toBe(204);
    expect((await t.send(post(event(), { origin: "http://10.0.0.5:3000" }, behindProxy))).status).toBe(403);
  });
});

describe("collector route: method, content type, size, JSON", () => {
  it.each(["GET", "PUT", "DELETE", "OPTIONS", "PATCH"])("%s: 405 with Allow: POST", async (method) => {
    const t = setup();
    await expectBare(await t.send(post(event(), {}, { method })), 405);
    expect((await t.route(post(event(), {}, { method }))).headers.get("allow")).toBe("POST");
    expect(t.forwarded).toHaveLength(0);
  });

  it.each([
    ["form-urlencoded", "application/x-www-form-urlencoded"],
    ["multipart", "multipart/form-data; boundary=x"],
    ["json-ish", "application/vnd.api+json"],
    ["empty", ""],
  ])("content type %s: 415", async (_n, ct) => {
    const t = setup();
    await expectBare(await t.send(post(event(), { "content-type": ct })), 415);
    expect(t.forwarded).toHaveLength(0);
  });

  it("content type missing altogether: 415", async () => {
    const t = setup();
    const req = new Request(`${SITE}/idr/e`, { method: "POST", headers: { origin: SITE }, body: new TextEncoder().encode(JSON.stringify(event())) });
    expect(req.headers.get("content-type")).toBeNull();
    await expectBare(await t.send(req), 415);
  });

  it.each(["application/json", "application/json; charset=utf-8", "TEXT/PLAIN", "text/plain;charset=UTF-8"])("content type %s: accepted", async (ct) => {
    const t = setup();
    expect((await t.send(post(event(), { "content-type": ct }))).status).toBe(204);
  });

  it("a declared Content-Length over 1 KiB: 413 without reading the body at all", async () => {
    const t = setup();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(512));
      },
    });
    const req = new Request(`${SITE}/idr/e`, { method: "POST", headers: { ...BROWSER, "content-length": "4096" }, body, duplex: "half" } as RequestInit);
    await expectBare(await t.send(req), 413);
    expect(pulled).toBeLessThanOrEqual(1); // a stream may pre-pull once on construction; the route reads none of it
    expect(t.reasons()).toEqual(["collector:too_large"]);
  });

  it("an undeclared, endless body: 413 after at most 1 KiB plus one chunk, and the stream is cancelled", async () => {
    const t = setup();
    let bytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        bytes += 256;
        c.enqueue(new Uint8Array(256).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(`${SITE}/idr/e`, { method: "POST", headers: BROWSER, body, duplex: "half" } as RequestInit);
    await expectBare(await t.send(req), 413);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(bytes).toBeLessThanOrEqual(1024 + 2 * 256); // the limit, the chunk that crossed it, and at most one queued ahead
  });

  it("exactly 1024 bytes is accepted, 1025 is refused", async () => {
    const t = setup();
    const json = JSON.stringify(event());
    expect((await t.send(post(json + " ".repeat(1024 - json.length)))).status).toBe(204);
    const json2 = JSON.stringify(event());
    expect((await t.send(post(json2 + " ".repeat(1025 - json2.length)))).status).toBe(413);
  });

  it.each([
    ["truncated JSON", '{"v":1,"event_id":'],
    ["not JSON", "v=1&name=cta_click"],
    ["empty body", ""],
  ])("%s: 400", async (_n, body) => {
    const t = setup();
    await expectBare(await t.send(post(body)), 400);
    expect(t.reasons()).toEqual(["collector:malformed"]);
  });

  it("invalid UTF-8: 400", async () => {
    const t = setup();
    const req = new Request(`${SITE}/idr/e`, { method: "POST", headers: BROWSER, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    await expectBare(await t.send(req), 400);
  });
});

describe("collector route: strict schema", () => {
  const bad: Array<[string, unknown]> = [
    ["JSON null", null],
    ["JSON array", [event()]],
    ["JSON string", JSON.stringify("page_view")],
    ["missing v", (() => { const e = event(); delete e["v"]; return e; })()],
    ["missing path", (() => { const e = event(); delete e["path"]; return e; })()],
    ["missing consent", (() => { const e = event(); delete e["consent"]; return e; })()],
    ["extra ip", event({ ip: "198.51.100.7" })],
    ["extra user_agent", event({ user_agent: "x" })],
    ["extra session_id", event({ session_id: "s" })],
    ["extra visitor_id", event({ visitor_id: "s" })],
    ["extra company", event({ company: "Example Ltd" })],
    ["extra text", event({ text: "free text" })],
    ["v 2", event({ v: 2 })],
    ["v as string", event({ v: "1" })],
    ["short event_id", event({ event_id: "abc" })],
    ["event_id with dots", event({ event_id: "abc.def.ghi.jkl.mno" })],
    ["event_id too long", event({ event_id: "a".repeat(65) })],
    ["occurred_at with offset", event({ occurred_at: "2026-11-03T10:00:00+01:00" })],
    ["occurred_at date only", event({ occurred_at: "2026-11-03" })],
    ["occurred_at number", event({ occurred_at: Date.now() })],
    ["consent yes", event({ consent: "yes" })],
    ["type not a string", event({ type: 1 })],
    ["name not a string", event({ name: ["cta_click"] })],
  ];
  it.each(bad)("%s: 400", async (_n, body) => {
    const t = setup();
    await expectBare(await t.send(post(body)), 400);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:schema"]);
  });

  it("an own __proto__ key is an unknown field: 400", async () => {
    const t = setup();
    const json = JSON.stringify(event()).replace(/^\{/, '{"__proto__":{"x":1},');
    await expectBare(await t.send(post(json)), 400);
  });

  it.each([
    ["query string", "/pricing?email=person%40example.com"],
    ["fragment", "/pricing#section"],
    ["no leading slash", "pricing"],
    ["absolute URL", "https://www.example.com/pricing"],
    ["backslash", "/\\evil.example.net/x"],
    ["whitespace", "/pricing page"],
    ["control character", "/pricing\u0000"],
    ["not a string", 7],
  ])("path with %s: 400, never forwarded", async (_n, path) => {
    const t = setup();
    await expectBare(await t.send(post(event({ path }))), 400);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:path"]);
  });
});

describe("collector route: vocabulary and site allowlist", () => {
  it.each([
    ["unknown name", { type: "conversion_intent", name: "rage_click" }],
    ["unknown type", { type: "identity", name: "cta_click" }],
    ["name under the wrong type", { type: "engagement", name: "cta_click" }],
    ["inherited property name", { type: "conversion_intent", name: "constructor" }],
    ["__proto__ name", { type: "page_view", name: "__proto__" }],
  ])("%s: 400", async (_n, over) => {
    const t = setup();
    await expectBare(await t.send(post(event(over))), 400);
    expect(t.reasons()).toEqual(["collector:vocabulary"]);
  });

  it("a vocabulary name outside the site allowlist: 403", async () => {
    const t = setup({ allow: ["page_view"] });
    await expectBare(await t.send(post(event({ type: "conversion_intent", name: "demo_request_start" }))), 403);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:not_allowed"]);
  });
});

describe("collector route: consent policy (the server decides)", () => {
  it("required (the default) refuses consent: not_required", async () => {
    const t = setup();
    await expectBare(await t.send(post(event({ consent: "not_required" }))), 403);
    expect(t.reasons()).toEqual(["collector:consent"]);
  });

  it("required + hasConsent: the browser's 'granted' is not enough", async () => {
    let allowed = false;
    const hook = vi.fn(async (r: Request) => (r.headers.get("cookie") ?? "").includes("cmp=yes") && allowed);
    const t = setup({ hasConsent: hook });
    expect((await t.send(post(event(), { cookie: "cmp=no" }))).status).toBe(403);
    allowed = true;
    expect((await t.send(post(event(), { cookie: "cmp=no" }))).status).toBe(403);
    expect((await t.send(post(event(), { cookie: "cmp=yes" }))).status).toBe(204);
    expect(hook).toHaveBeenCalledTimes(3);
    expect(t.forwarded).toHaveLength(1);
    expect(t.forwarded[0]!.bodyText).not.toContain("cmp");
  });

  it("a throwing or rejecting hasConsent refuses the event", async () => {
    for (const hasConsent of [() => { throw new Error("cmp"); }, () => Promise.reject(new Error("cmp")), () => "yes" as unknown as boolean]) {
      const t = setup({ hasConsent });
      expect((await t.send(post(event()))).status).toBe(403);
      expect(t.forwarded).toHaveLength(0);
    }
  });

  it("not_required accepts granted and not_required and forwards the value as given; hasConsent is not consulted", async () => {
    const hook = vi.fn(() => false);
    const t = setup({ consent: "not_required", hasConsent: hook });
    expect((await t.send(post(event({ consent: "not_required" })))).status).toBe(204);
    expect((await t.send(post(event({ consent: "granted" })))).status).toBe(204);
    expect(t.forwarded.map((f) => f.body["consent"])).toEqual(["not_required", "granted"]);
    expect(hook).not.toHaveBeenCalled();
  });

  it("off refuses every event", async () => {
    const t = setup({ consent: "off" });
    for (const consent of ["granted", "not_required"]) expect((await t.send(post(event({ consent })))).status).toBe(403);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:consent_off", "collector:consent_off"]);
  });

  it("Sec-GPC: 1 refuses the event in every mode", async () => {
    for (const consent of ["required", "not_required"] as const) {
      const t = setup({ consent });
      expect((await t.send(post(event({ consent: "granted" }), { "sec-gpc": "1" }))).status).toBe(403);
      expect(t.forwarded).toHaveLength(0);
      expect(t.reasons()).toEqual(["collector:gpc"]);
    }
  });
});

describe("collector route: bounded waits (CHR-66 G4-I3)", () => {
  /** Settles with the response, or "pending" if the route has not answered within `ms` (before the fix it never did). */
  const answerWithin = (p: Promise<Response>, ms = 2000) => Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

  it("a hasConsent that never settles: 403 after consentTimeoutMs (fail closed), nothing forwarded, reported as consent_timeout", async () => {
    const t = setup({ hasConsent: () => new Promise<boolean>(() => {}), consentTimeoutMs: 50 });
    const started = Date.now();
    const res = await answerWithin(t.send(post(event())));
    expect(res).not.toBe("pending");
    await expectBare(res as Response, 403);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:consent_timeout"]);
  });

  it("a hasConsent that grants within the limit is accepted (control); a late grant is still refused", async () => {
    const late = (ms: number) => () => new Promise<boolean>((r) => setTimeout(() => r(true), ms));
    const fast = setup({ hasConsent: late(10), consentTimeoutMs: 500 });
    expect((await fast.send(post(event()))).status).toBe(204);
    const slow = setup({ hasConsent: late(300), consentTimeoutMs: 50 });
    expect((await slow.send(post(event()))).status).toBe(403);
    expect(slow.forwarded).toHaveLength(0);
  });

  it("the default consent limit is 1 s, and no timer is left behind once the route has answered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ hasConsent: () => new Promise<boolean>(() => {}) });
    let res: Response | undefined;
    void t.route({ request: post(event()) }).then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(999);
    expect(res).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(res?.status).toBe(403);
    expect(vi.getTimerCount()).toBe(0);
    // A hook that answers at once: its timer is cleared too.
    const quick = setup({ hasConsent: () => false });
    expect((await quick.route({ request: post(event()) })).status).toBe(403);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a slow-dripping body: 408 after bodyTimeoutMs, the stream is cancelled, nothing forwarded, reported as body_timeout", async () => {
    const t = setup({ bodyTimeoutMs: 150 });
    let cancelled = false;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 40));
        sent++;
        c.enqueue(new TextEncoder().encode(" ")); // one byte every 40 ms: 1 KiB would take 40 s
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(`${SITE}/idr/e`, { method: "POST", headers: BROWSER, body, duplex: "half" } as RequestInit);
    const started = Date.now();
    const res = await answerWithin(t.send(req));
    expect(res).not.toBe("pending");
    await expectBare(res as Response, 408);
    expect(Date.now() - started).toBeLessThan(1500);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(sent).toBeLessThan(20);
    expect(t.forwarded).toHaveLength(0);
    expect(t.reasons()).toEqual(["collector:body_timeout"]);
  });

  it("a body that stalls after a valid-looking first chunk: 408 and cancelled", async () => {
    const t = setup({ bodyTimeoutMs: 100 });
    let cancelled = false;
    const head = new TextEncoder().encode(JSON.stringify(event()).slice(0, 40));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(head); // then nothing, and never closed
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(`${SITE}/idr/e`, { method: "POST", headers: BROWSER, body, duplex: "half" } as RequestInit);
    const res = await answerWithin(t.send(req));
    expect(res).not.toBe("pending");
    await expectBare(res as Response, 408);
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(t.forwarded).toHaveLength(0);
  });

  it("consentTimeoutMs and bodyTimeoutMs are bounded at creation", () => {
    const base = { resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", allow: ["cta_click"] as const };
    for (const consentTimeoutMs of [0, 9, 10_001, 1.5, Number.NaN]) expect(() => createCollectorRoute({ ...base, allow: [...base.allow], consentTimeoutMs })).toThrow(/consentTimeoutMs/);
    for (const bodyTimeoutMs of [0, 99, 60_001, 2.5]) expect(() => createCollectorRoute({ ...base, allow: [...base.allow], bodyTimeoutMs })).toThrow(/bodyTimeoutMs/);
    expect(() => createCollectorRoute({ ...base, allow: [...base.allow], consentTimeoutMs: 10, bodyTimeoutMs: 60_000 })).not.toThrow();
  });
});

describe("collector route: occurred_at window, replay cache, rate budget", () => {
  it.each([
    ["10 minutes old", -600_000],
    ["10 minutes in the future", 600_000],
    ["121 s old", -121_000],
    ["121 s in the future", 121_000],
  ])("%s: 400", async (_n, offset) => {
    const t = setup();
    await expectBare(await t.send(post(event({ occurred_at: iso(Date.now() + offset) }))), 400);
    expect(t.reasons()).toEqual(["collector:occurred_at"]);
  });

  it("inside the default 120 s window in either direction: accepted; maxClockSkewMs narrows it", async () => {
    const t = setup();
    expect((await t.send(post(event({ occurred_at: iso(Date.now() - 110_000) })))).status).toBe(204);
    expect((await t.send(post(event({ occurred_at: iso(Date.now() + 110_000) })))).status).toBe(204);
    const narrow = setup({ maxClockSkewMs: 10_000 });
    expect((await narrow.send(post(event({ occurred_at: iso(Date.now() - 30_000) })))).status).toBe(400);
  });

  it("an impossible date is refused", async () => {
    const t = setup();
    expect((await t.send(post(event({ occurred_at: "2026-13-45T25:61:61Z" })))).status).toBe(400);
  });

  it("a repeated event_id: 204 once, then 409; forwarded once", async () => {
    const t = setup();
    const e = event();
    expect((await t.send(post(e))).status).toBe(204);
    await expectBare(await t.send(post(e)), 409);
    await expectBare(await t.send(post({ ...e, name: "page_view", type: "page_view" })), 409);
    expect(t.forwarded).toHaveLength(1);
    expect(t.reasons()).toEqual(["collector:replay", "collector:replay"]);
  });

  it("only accepted events are remembered: a refused event does not poison its id", async () => {
    const t = setup();
    const e = event();
    expect((await t.send(post({ ...e, consent: "not_required" }))).status).toBe(403);
    expect((await t.send(post(e))).status).toBe(204);
  });

  it("an id is remembered for twice the skew window; after that the window itself refuses the replay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const t = setup({ maxClockSkewMs: 10_000 });
    const e = event({ occurred_at: iso(start) });
    expect((await t.send(post(e))).status).toBe(204);
    vi.setSystemTime(start + 9_000);
    expect((await t.send(post(e))).status).toBe(409);
    vi.setSystemTime(start + 21_000);
    expect((await t.send(post(e))).status).toBe(400);
    expect(t.reasons()).toEqual(["collector:replay", "collector:occurred_at"]);
  });

  it("the cache is bounded (replayCacheSize): the oldest id falls out first", async () => {
    const t = setup({ replayCacheSize: 100, rateLimit: { events: 10_000 } });
    const first = event();
    expect((await t.route(post(first))).status).toBe(204);
    for (let i = 0; i < 100; i++) expect((await t.route(post(event()))).status).toBe(204);
    expect((await t.route(post(first))).status).toBe(204); // evicted; the resolver still stores one row per event_id
  });

  it("rate budget per instance, not per client: different IPs, cookies and agents share it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const t = setup({ rateLimit: { events: 3, windowMs: 1_000 } });
    const clients = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"].map((ip, i) => ({ "x-forwarded-for": ip, "cf-connecting-ip": ip, cookie: `c=${i}`, "user-agent": `ua${i}` }));
    const statuses: number[] = [];
    for (const c of clients) statuses.push((await t.send(post(event(), c))).status);
    expect(statuses).toEqual([204, 204, 204, 429]);
    const limited = event();
    await expectBare(await t.send(post(limited)), 429);
    vi.setSystemTime(start + 1_000);
    expect((await t.send(post(limited))).status).toBe(204); // a rate-limited id was not remembered
    expect(t.forwarded).toHaveLength(4);
  });

  it("checks run in the documented order", async () => {
    const t = setup({ allow: ["cta_click"], consent: "required" });
    const big = JSON.stringify(event()) + " ".repeat(2000);
    const cases: Array<[Request, number, string]> = [
      [post(big, { origin: "https://evil.example.net", "content-type": "application/x-www-form-urlencoded" }, { method: "PUT" }), 405, ""],
      [post(big, { origin: "https://evil.example.net", "content-type": "application/x-www-form-urlencoded" }), 403, "collector:origin"],
      [post(big, { "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }), 403, "collector:sec_fetch_site"],
      [post(big, { "content-type": "application/x-www-form-urlencoded" }), 415, "collector:content_type"],
      [post(big.replace(/^\{/, "[")), 413, "collector:too_large"],
      [post("{bad json"), 400, "collector:malformed"],
      [post(event({ extra: 1, name: "made_up" })), 400, "collector:schema"],
      [post(event({ name: "made_up", consent: "not_required" })), 400, "collector:vocabulary"],
      [post(event({ type: "page_view", name: "page_view", consent: "not_required" })), 403, "collector:not_allowed"],
      [post(event({ consent: "not_required", occurred_at: iso(Date.now() - 600_000) })), 403, "collector:consent"],
      [post(event({ occurred_at: iso(Date.now() - 600_000) })), 400, "collector:occurred_at"],
    ];
    for (const [req, status, reason] of cases) {
      const before = t.reasons().length;
      expect((await t.send(req)).status, reason).toBe(status);
      if (reason) expect(t.reasons().slice(before), reason).toEqual([reason]);
    }
    expect(t.forwarded).toHaveLength(0);
  });
});

describe("collector route: delivery failures never reach the browser", () => {
  it.each([400, 401, 403, 413, 429, 500, 503])("resolver answers %i: the browser still gets 204; the drop goes to onDeliveryResult", async (status) => {
    const t = setup({ retry: false }, status);
    await expectBare(await t.send(post(event())), 204);
    expect(t.results).toHaveLength(1);
    expect(t.results[0]).toMatchObject({ outcome: "dropped", mode: "wait_until", attempts: 1, httpStatus: status, reason: status === 429 ? "http_429" : status >= 500 ? "http_5xx" : "http_4xx" });
  });

  it("resolver hangs: 204 at once; dropped as timeout after the per-attempt timeout", async () => {
    const fx = await startResolver({ kind: "hang" });
    try {
      const results: DeliveryResult[] = [];
      const route = createCollectorRoute({ resolverUrl: fx.url, allowInsecureHttp: true, token: TEST_TOKEN, websiteId: "example-site", allow: ["cta_click"], timeoutMs: 250, retry: false, onDeliveryResult: (r) => void results.push(r) });
      const req = post(event());
      const { pending } = withWaitUntil(req);
      const t0 = performance.now();
      const res = await route(req);
      expect(performance.now() - t0).toBeLessThan(100);
      await expectBare(res, 204);
      await Promise.all(pending);
      expect(results).toEqual([expect.objectContaining({ outcome: "dropped", reason: "timeout", mode: "wait_until", attempts: 1 })]);
      expect(fx.captured[0]!.url).toBe("/v1/events");
    } finally {
      await fx.close();
    }
  });

  it("resolver unreachable: 204; dropped as network", async () => {
    const results: DeliveryResult[] = [];
    const route = createCollectorRoute({ resolverUrl: await closedPortUrl(), allowInsecureHttp: true, token: TEST_TOKEN, websiteId: "example-site", allow: ["cta_click"], retry: false, onDeliveryResult: (r) => void results.push(r) });
    const req = post(event());
    const { pending } = withWaitUntil(req);
    expect((await route(req)).status).toBe(204);
    await Promise.all(pending);
    expect(results).toEqual([expect.objectContaining({ outcome: "dropped", reason: "network" })]);
  });

  it("a transient 503 is retried once with the same event_id (idempotent at the resolver)", async () => {
    const fx = await startResolver({ kind: "sequence", steps: [{ kind: "status", code: 503 }, { kind: "ok" }] });
    try {
      const results: DeliveryResult[] = [];
      const route = createCollectorRoute({ resolverUrl: fx.url, allowInsecureHttp: true, token: TEST_TOKEN, websiteId: "example-site", allow: ["cta_click"], retryDelayMs: 0, onDeliveryResult: (r) => void results.push(r) });
      const req = post(event());
      const { pending } = withWaitUntil(req);
      expect((await route(req)).status).toBe(204);
      await Promise.all(pending);
      expect(fx.captured).toHaveLength(2);
      expect(fx.captured[0]!.body).toBe(fx.captured[1]!.body);
      expect(results).toEqual([expect.objectContaining({ outcome: "delivered", attempts: 2 })]);
    } finally {
      await fx.close();
    }
  });

  it("long-lived runtime without waitUntil: detached delivery, 204 first", async () => {
    const t = setup();
    expect((await t.route(post(event()))).status).toBe(204);
    await vi.waitFor(() => expect(t.results).toHaveLength(1));
    expect(t.results[0]).toMatchObject({ outcome: "delivered", mode: "detached" });
  });

  it("edge isolate without waitUntil: 204, nothing sent, skipped/no_background_context", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const t = setup();
    expect((await t.route(post(event()))).status).toBe(204);
    expect(t.forwarded).toHaveLength(0);
    expect(t.results).toEqual([expect.objectContaining({ outcome: "skipped", reason: "no_background_context" })]);
  });

  it("more than maxInFlight deliveries: 204, dropped as overload", async () => {
    const fx = await startResolver({ kind: "hang" });
    try {
      const results: DeliveryResult[] = [];
      const route = createCollectorRoute({ resolverUrl: fx.url, allowInsecureHttp: true, token: TEST_TOKEN, websiteId: "example-site", allow: ["cta_click"], maxInFlight: 1, timeoutMs: 250, retry: false, onDeliveryResult: (r) => void results.push(r) });
      const a = withWaitUntil(post(event()));
      const b = withWaitUntil(post(event()));
      expect((await route(a.request)).status).toBe(204);
      expect((await route(b.request)).status).toBe(204);
      await Promise.all([...a.pending, ...b.pending]);
      expect(results.map((r) => r.reason).sort()).toEqual(["overload", "timeout"]);
    } finally {
      await fx.close();
    }
  });

  it("a throwing or rejecting onDeliveryResult never changes the response", async () => {
    for (const hook of [() => { throw new Error("x"); }, () => Promise.reject(new Error("x"))]) {
      const t = setup({ onDeliveryResult: hook });
      expect((await t.send(post(event()))).status).toBe(204);
      expect((await t.send(post(event(), { origin: null }))).status).toBe(403);
    }
  });
});

describe("collector route: configuration", () => {
  it.each([
    ["unknown allow name", { allow: ["page_view", "rage_click"] }],
    ["allow not an array", { allow: "page_view" }],
    ["bad consent", { consent: "maybe" }],
    ["origin with a path", { origins: ["https://www.example.com/shop"] }],
    ["origin not http(s)", { origins: ["ftp://www.example.com"] }],
    ["origins not an array", { origins: "https://www.example.com" }],
    ["hasConsent not a function", { hasConsent: true }],
    ["skew too large", { maxClockSkewMs: 300_000 }],
    ["cache too small", { replayCacheSize: 1 }],
    ["rate zero", { rateLimit: { events: 0 } }],
    ["http resolver", { resolverUrl: "http://resolver.example.com" }],
    ["short token", { token: "short" }],
  ])("%s: throws at creation without echoing secrets", (_n, over) => {
    const opts = { resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", allow: ["page_view"], ...over } as unknown as CollectorRouteOptions;
    let message = "";
    try {
      createCollectorRoute(opts);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^idr-tanstack: /);
    expect(message).not.toContain(TEST_TOKEN);
    expect(message).not.toContain("resolver.example.com");
  });

  it("a lazy configuration error: every POST gets 204, nothing is forwarded, config_invalid is reported once", async () => {
    const results: DeliveryResult[] = [];
    const r = fakeResolver();
    const route = createCollectorRoute(() => ({ resolverUrl: RESOLVER, token: "short", websiteId: "example-site", allow: ["cta_click"], fetch: r.fetch, onDeliveryResult: (x) => void results.push(x) }));
    for (let i = 0; i < 3; i++) expect((await route(post(event()))).status).toBe(204);
    expect((await route(post(event(), {}, { method: "GET" }))).status).toBe(405);
    expect(r.forwarded).toHaveLength(0);
    expect(results).toEqual([expect.objectContaining({ outcome: "skipped", reason: "config_invalid" })]);
  });

  it("a lazy configuration is read on the first request only", async () => {
    const factory = vi.fn(() => ({ resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", allow: ["cta_click"] as const, fetch: fakeResolver().fetch }));
    const route = createCollectorRoute(factory);
    expect(factory).not.toHaveBeenCalled();
    await route(post(event()));
    await route(post(event()));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("refuses to run when a browser global is present (server-only guard)", () => {
    const prev = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    try {
      expect(() => createCollectorRoute({ resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", allow: ["page_view"] })).toThrow(/server/);
      expect(() => createCollectorRoute(() => ({ resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", allow: ["page_view"] }))).toThrow(/server/);
    } finally {
      if (prev === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prev;
    }
  });
});
