import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkConnectivity, createCollectorRoute, createIdrServerMiddleware, type DeliveryResult } from "../src/index.js";
import { resetRuntimeCache } from "../src/runtime.js";
import { TEST_TOKEN, withWaitUntil } from "./helpers.js";
import { startResolver } from "./resolver-fixture.js";

// G4-I8 / T5, code-side evidence: every outbound request the adapter makes builds its headers from scratch. It never
// copies, clones or forwards the incoming request or its headers, on the entrance path (createIdrServerMiddleware ->
// deliverEntrance), on the event path (createCollectorRoute -> deliverEvent) and in checkConnectivity.
//
// What this does NOT show: which headers the hosting platform adds to the subrequest after it leaves the adapter
// (on Cloudflare, possibly CF-Connecting-IP / X-Real-IP with the visitor's IP). Only T5 on the real edge can show
// that (docs/staging/CLOUDFLARE_TEST_SITE.md, section 4).

const SITE = "https://www.example.com";
const RESOLVER = "https://resolver.example.com";
const EXPECTED_NAMES = ["accept", "authorization", "content-type"];
const EXPECTED = { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json", accept: "application/json" };

/** The owner's list of hostile incoming headers (G4-I8), each carrying the visitor's IP or another visitor value. */
function hostile(visitorIp: string): Record<string, string> {
  return {
    "cf-connecting-ip": visitorIp,
    "x-real-ip": visitorIp,
    "x-forwarded-for": `203.0.113.9, ${visitorIp}`,
    forwarded: `for="${visitorIp.includes(":") ? `[${visitorIp}]` : visitorIp}";proto=https`,
    "true-client-ip": visitorIp,
    "cf-ipcountry": "GB",
    cookie: "session=secret-cookie-value; _ga=GA1.1.123456789.987654321",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SecretAgentMarker",
    referer: "https://www.example.org/secret-ref?token=abc123",
    origin: SITE,
    "sec-gpc": "1",
    "x-custom": "custom-secret-header",
  };
}
const MARKERS = ["secret-cookie-value", "GA1.1", "SecretAgentMarker", "secret-ref", "abc123", "custom-secret-header", "www.example.org"];

interface Call {
  url: unknown;
  init: RequestInit;
}
function fetchDouble() {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify({ version: "1", status: "ineligible", recorded: false }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { calls, fetch: fn as unknown as typeof fetch };
}

/** The exact outbound header set, read the way a runtime would (Headers), plus the raw init shape. */
function expectExplicitHeaders(call: Call, visitorIp: string, endpoint: string) {
  // A plain URL string and a plain RequestInit: never a Request object (which would carry its own headers).
  expect(typeof call.url).toBe("string");
  expect(call.url).toBe(`${RESOLVER}${endpoint}`);
  expect(Object.keys(call.init).sort()).toEqual(["body", "headers", "method", "redirect", "signal"]);
  expect(call.init.headers).not.toBeInstanceOf(Headers);
  expect(Object.getPrototypeOf(call.init.headers)).toBe(Object.prototype);
  expect(call.init.headers).toEqual(EXPECTED);
  const sent = new Headers(call.init.headers);
  expect([...sent.keys()].sort()).toEqual(EXPECTED_NAMES);
  for (const [, value] of sent) {
    expect(value).not.toBe(visitorIp);
    expect(value.toLowerCase()).not.toContain(visitorIp.toLowerCase());
    for (const m of MARKERS) expect(value).not.toContain(m);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRuntimeCache();
});

describe("outbound headers are built from scratch (G4-I8, code-side evidence for T5)", () => {
  it.each(["198.51.100.23", "2001:db8::1234"])("entrance path: a request carrying the visitor IP (%s) in every hostile header -> exactly authorization, content-type, accept", async (visitorIp) => {
    const r = fetchDouble();
    const results: DeliveryResult[] = [];
    const mw = createIdrServerMiddleware({ resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", trustPolicy: { mode: "cloudflare" }, allowDocumentationRanges: true, fetch: r.fetch, onDeliveryResult: (x) => void results.push(x) });
    const request = new Request(`${SITE}/pricing?utm_medium=email`, {
      headers: { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", ...hostile(visitorIp) },
    });
    const { pending } = withWaitUntil(request);
    await mw({ request, next: async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) });
    await Promise.all(pending);
    expect(results).toEqual([expect.objectContaining({ outcome: "delivered" })]);
    expect(r.calls).toHaveLength(1);
    expectExplicitHeaders(r.calls[0]!, visitorIp, "/v1/entrances");
    // The entrance body carries the IP by contract (entrance.v1 `ip`), selected by the trust policy, and nothing else
    // from the request headers.
    const body = JSON.parse(String(r.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body["ip"]).toBe(visitorIp);
    const rest = JSON.stringify({ ...body, ip: undefined });
    expect(rest).not.toContain(visitorIp);
    for (const m of [...MARKERS, "GB", "203.0.113.9"]) expect(rest).not.toContain(m);
  });

  it.each(["198.51.100.23", "2001:db8::1234"])("event path: a collector POST carrying the visitor IP (%s) in every hostile header -> exactly authorization, content-type, accept, and no IP anywhere", async (visitorIp) => {
    const r = fetchDouble();
    const results: DeliveryResult[] = [];
    const route = createCollectorRoute({ resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", allow: ["cta_click"], consent: "not_required", fetch: r.fetch, onDeliveryResult: (x) => void results.push(x) });
    // Sec-GPC: 1 would (rightly) refuse the event, so the event path carries Sec-GPC: 0.
    const headers = { ...hostile(visitorIp), "sec-gpc": "0", "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8" };
    const event = { v: 1, event_id: "evtOutboundHeaders0001", occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), type: "conversion_intent", name: "cta_click", path: "/pricing", consent: "not_required" };
    const request = new Request(`${SITE}/idr/e`, { method: "POST", headers, body: JSON.stringify(event) });
    const { pending } = withWaitUntil(request);
    expect((await route({ request })).status).toBe(204);
    await Promise.all(pending);
    expect(results).toEqual([expect.objectContaining({ outcome: "delivered" })]);
    expect(r.calls).toHaveLength(1);
    expectExplicitHeaders(r.calls[0]!, visitorIp, "/v1/events");
    const bodyText = String(r.calls[0]!.init.body);
    expect(bodyText).not.toContain(visitorIp);
    for (const m of [...MARKERS, "GB", "203.0.113.9"]) expect(bodyText).not.toContain(m);
  });

  it("checkConnectivity (no incoming request): the same three headers", async () => {
    const r = fetchDouble();
    expect((await checkConnectivity({ resolverUrl: RESOLVER, token: TEST_TOKEN, websiteId: "example-site", trustPolicy: { mode: "none" }, fetch: r.fetch })).ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.init.headers).toEqual(EXPECTED);
  });

  it("over a real socket (Node's fetch): the runtime adds only its own transport headers, none with a visitor value", async () => {
    const visitorIp = "198.51.100.23";
    const fx = await startResolver({ kind: "ok" });
    try {
      const shared = { resolverUrl: fx.url, allowInsecureHttp: true, token: TEST_TOKEN, websiteId: "example-site" };
      const mw = createIdrServerMiddleware({ ...shared, trustPolicy: { mode: "cloudflare" }, allowDocumentationRanges: true });
      const nav = new Request(`${SITE}/pricing`, { headers: { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", ...hostile(visitorIp) } });
      const w1 = withWaitUntil(nav);
      await mw({ request: nav, next: async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) });
      await Promise.all(w1.pending);
      const route = createCollectorRoute({ ...shared, allow: ["cta_click"], consent: "not_required" });
      const event = { v: 1, event_id: "evtOutboundHeaders0002", occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), type: "conversion_intent", name: "cta_click", path: "/pricing", consent: "not_required" };
      const post = new Request(`${SITE}/idr/e`, { method: "POST", headers: { ...hostile(visitorIp), "sec-gpc": "0", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(event) });
      const w2 = withWaitUntil(post);
      expect((await route({ request: post })).status).toBe(204);
      await Promise.all(w2.pending);

      expect(fx.captured.map((c) => c.url)).toEqual(["/v1/entrances", "/v1/events"]);
      // Transport headers Node's fetch (undici) adds by itself. A Worker runtime adds its own: see the T5 caveat above.
      const RUNTIME_ADDED = ["accept-encoding", "accept-language", "connection", "content-length", "host", "sec-fetch-mode", "user-agent"];
      for (const c of fx.captured) {
        const names = Object.keys(c.headers).sort();
        for (const n of EXPECTED_NAMES) expect(names).toContain(n);
        expect(names.filter((n) => !EXPECTED_NAMES.includes(n) && !RUNTIME_ADDED.includes(n))).toEqual([]);
        for (const n of ["cf-connecting-ip", "x-real-ip", "x-forwarded-for", "forwarded", "true-client-ip", "cf-ipcountry", "cookie", "referer", "origin", "sec-gpc", "x-custom"]) expect(names).not.toContain(n);
        const values = Object.values(c.headers).flat().join("\n");
        expect(values).not.toContain(visitorIp);
        for (const m of MARKERS) expect(values).not.toContain(m);
        // The browser's user agent is not forwarded; at most the runtime's own.
        expect(String(c.headers["user-agent"] ?? "")).not.toContain("Mozilla");
      }
    } finally {
      await fx.close();
    }
  });

  it("source tripwire: the only outbound fetch is delivery.ts attempt(), with a three-key header literal, and no module clones a request or its headers", () => {
    const srcDir = resolve(import.meta.dirname, "../src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    const code = (f: string) => readFileSync(join(srcDir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const calls: string[] = [];
    for (const f of files) {
      const text = code(f);
      for (const m of text.matchAll(/\b(?:fetch|doFetch)\s*\(/g)) calls.push(`${f}:${m[0]}`);
      expect(text, `${f} constructs a Request`).not.toMatch(/\bnew\s+Request\s*\(/);
      expect(text, `${f} constructs Headers`).not.toMatch(/\bnew\s+Headers\s*\(/);
      expect(text, `${f} clones`).not.toMatch(/\.clone\s*\(/);
      expect(text, `${f} spreads or forwards request headers`).not.toMatch(/\.\.\.\s*(?:request|req|args\.request)\b|headers\s*:\s*(?:request|req)\b|(?:request|req)\.headers\s*[,)}]/);
    }
    expect(calls).toEqual(["delivery.ts:doFetch("]);
    const delivery = code("delivery.ts");
    expect(delivery).not.toMatch(/\brequest\b/);
    expect(delivery).toContain('headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },');
  });
});
