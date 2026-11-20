/**
 * The watch-only source adapters (src/shadow/ipapi.ts, src/shadow/iplocate.ts)
 * with a fake fetch: request shape (the key never in a URL), the allowlisted
 * signals, every error class, timeouts, oversize and malformed bodies and
 * redirects. Documentation addresses and example domains only.
 */
import { describe, expect, it } from "vitest";
import { createIpapiAdapter, IPAPI_URL } from "../../src/shadow/ipapi.js";
import { createIplocateAdapter, IPLOCATE_BASE_URL } from "../../src/shadow/iplocate.js";
import type { ApiSourceAdapter, ApiSourceOutcome } from "../../src/shadow/types.js";

const KEY = "test-shadow-key-0123456789";
const IP = "203.0.113.10";
const IP6 = "2001:db8::10";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch that never answers until its signal aborts (then rejects like the real fetch). */
const hangingFetch = fakeFetch(
  (call) =>
    new Promise<Response>((_, reject) => {
      const signal = call.init.signal!;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
);

const lookup = (a: ApiSourceAdapter, ip = IP, timeoutMs = 1_000): Promise<ApiSourceOutcome> => a.lookup(ip, { signal: AbortSignal.timeout(timeoutMs) });

const IPAPI_BUSINESS = {
  ip: IP,
  rir: "TEST",
  is_bogon: false,
  is_mobile: false,
  is_satellite: false,
  is_crawler: false,
  is_datacenter: false,
  is_tor: false,
  is_proxy: false,
  is_vpn: false,
  is_abuser: false,
  company: { name: "Example Corp Ltd", abuser_score: "0 (Very Low)", domain: "www.Example.com", type: "business", network: "203.0.113.0 - 203.0.113.255" },
  abuse: { name: "Example Abuse Desk", email: "abuse@example.com" },
  asn: { asn: 64496, abuser_score: "0", route: "203.0.113.0/24", descr: "EXAMPLE-AS", country: "xa", active: true, org: "Example Transit Inc", domain: "example.net", abuse: "abuse@example.net", type: "isp" },
  location: { city: "Example City", latitude: 1.5, longitude: 2.5 },
};

const IPLOCATE_BUSINESS = {
  ip: IP,
  country: "Exampleland",
  city: "Example City",
  latitude: 1.5,
  longitude: 2.5,
  asn: { asn: "AS64496", route: "203.0.113.0/24", netname: "EXAMPLE-NET", name: "Example Transit Inc", country_code: "XA", domain: "example.net", type: "isp", rir: "TEST" },
  privacy: { is_abuser: false, is_anonymous: false, is_bogon: false, is_hosting: false, is_icloud_relay: false, is_proxy: false, is_tor: false, is_vpn: false },
  company: { name: "Example Corp Ltd", domain: "example.com", country_code: "XA", type: "business" },
  abuse: { email: "abuse@example.net" },
};

const FORBIDDEN = [IP, "Example City", "Exampleland", "Example Transit Inc", "abuse@", "EXAMPLE-NET", "203.0.113.0/24", "latitude"];
function assertClean(o: ApiSourceOutcome): void {
  const s = JSON.stringify(o);
  for (const f of FORBIDDEN) expect(s).not.toContain(f);
  expect(s).not.toContain(KEY);
}

describe("ipapi.is adapter", () => {
  it("POSTs {q, key} as JSON to https://api.ipapi.is (the key never in the URL), redirect refused", async () => {
    const f = fakeFetch(() => json(200, IPAPI_BUSINESS));
    const a = createIpapiAdapter({ apiKey: KEY, fetchImpl: f });
    const o = await lookup(a);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(IPAPI_URL);
    expect(IPAPI_URL).toBe("https://api.ipapi.is");
    expect(call.url).not.toContain(KEY);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({ q: IP, key: KEY });
    expect(o).toEqual({
      kind: "ok",
      signals: { companyName: "Example Corp Ltd", companyDomain: "example.com", companyType: "business", asnType: "isp", mobile: false, hosting: false, anonymous: false },
    });
    assertClean(o);
  });

  it("reads the mobile, data-centre and anonymity flags", async () => {
    const cases: Array<[Record<string, unknown>, Partial<Record<"mobile" | "hosting" | "anonymous", boolean>>]> = [
      [{ is_mobile: true }, { mobile: true }],
      [{ is_datacenter: true, datacenter: { datacenter: "Example Cloud", network: "203.0.113.0/24" } }, { hosting: true }],
      [{ is_vpn: true, vpn: { service: "Example VPN" } }, { anonymous: true }],
      [{ is_proxy: true }, { anonymous: true }],
      [{ is_tor: true }, { anonymous: true }],
      [{ is_crawler: true, is_satellite: true, is_abuser: true }, {}],
    ];
    for (const [flags, expected] of cases) {
      const a = createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, { ...IPAPI_BUSINESS, ...flags })) });
      const o = await lookup(a);
      expect(o.kind).toBe("ok");
      if (o.kind === "ok") expect(o.signals).toMatchObject({ mobile: false, hosting: false, anonymous: false, ...expected });
      assertClean(o);
    }
  });

  it("a company that is not an object (the keyless answer) is no company; bad types read as absent", async () => {
    const keyless = createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, { ...IPAPI_BUSINESS, company: "Example Corp Ltd" })) });
    expect(await lookup(keyless)).toMatchObject({ kind: "ok", signals: { companyName: null, companyDomain: null, companyType: null, asnType: "isp" } });
    const odd = createIpapiAdapter({
      apiKey: KEY,
      fetchImpl: fakeFetch(() => json(200, { company: { name: 42, domain: "not a domain", type: "Business" }, asn: "x", is_mobile: "yes" })),
    });
    expect(await lookup(odd)).toEqual({ kind: "ok", signals: { companyName: null, companyDomain: null, companyType: "business", asnType: null, mobile: false, hosting: false, anonymous: false } });
  });

  it.each([
    [403, { error_code: "ERR_FORBIDDEN_INVALID_API_KEY" }, "auth"],
    [401, {}, "auth"],
    [429, { error_code: "ERR_QUOTA_EXCEEDED" }, "quota"],
    [429, {}, "quota"],
    [402, { error_code: "ERR_FREE_TIER_EXHAUSTED" }, "quota"],
    [500, { error_code: "ERR_UNEXPECTED_SERVER_ERROR" }, "error"],
    [503, {}, "error"],
    [404, {}, "error"],
  ])("HTTP %i %j -> %s", async (status, body, kind) => {
    const a = createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(status, body)) });
    expect(await lookup(a)).toEqual({ kind });
  });

  it("a 200 carrying an error code maps like the error", async () => {
    const a = createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, { error_code: "ERR_QUOTA_EXCEEDED" })) });
    expect(await lookup(a)).toEqual({ kind: "quota" });
  });

  it("timeout, network failure, redirect, oversize and malformed bodies", async () => {
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: hangingFetch }), IP, 50)).toEqual({ kind: "timeout" });
    const network = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: network }))).toEqual({ kind: "error" });
    // fetch with redirect: "error" rejects on a 3xx; a 3xx that reaches the adapter is not a 2xx either.
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://example.org/" } })) }))).toEqual({
      kind: "error",
    });
    const big = { ...IPAPI_BUSINESS, filler: "x".repeat(70_000) };
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, big)) }))).toEqual({ kind: "error" });
    const declared = fakeFetch(() => new Response("{}", { status: 200, headers: { "content-length": "999999" } }));
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: declared }))).toEqual({ kind: "error" });
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response("not json", { status: 200 })) }))).toEqual({ kind: "error" });
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, [1, 2])) }))).toEqual({ kind: "error" });
  });

  it("a fetch that throws synchronously never escapes", async () => {
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await lookup(createIpapiAdapter({ apiKey: KEY, fetchImpl: throwing }))).toEqual({ kind: "error" });
  });
});

describe("IPLocate adapter", () => {
  it("GETs /api/lookup/<ip> with the key in X-API-Key only, redirect refused", async () => {
    const f = fakeFetch(() => json(200, IPLOCATE_BUSINESS));
    const a = createIplocateAdapter({ apiKey: KEY, fetchImpl: f });
    const o = await lookup(a);
    const call = f.calls[0]!;
    expect(call.url).toBe(`${IPLOCATE_BASE_URL}${IP}`);
    expect(IPLOCATE_BASE_URL).toBe("https://iplocate.io/api/lookup/");
    expect(call.url).not.toContain(KEY);
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("error");
    expect((call.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(o).toEqual({
      kind: "ok",
      signals: { companyName: "Example Corp Ltd", companyDomain: "example.com", companyType: "business", asnType: "isp", mobile: false, hosting: false, anonymous: false },
    });
    assertClean(o);
    await lookup(a, IP6);
    expect(f.calls[1]!.url).toBe(`${IPLOCATE_BASE_URL}${IP6}`);
  });

  it("reads the privacy flags and the hosting object; never a mobile flag", async () => {
    const privacy = IPLOCATE_BUSINESS.privacy;
    const cases: Array<[Record<string, unknown>, Partial<Record<"hosting" | "anonymous", boolean>>]> = [
      [{ privacy: { ...privacy, is_hosting: true } }, { hosting: true }],
      [{ hosting: { provider: "Example Cloud", domain: "example.net", network: "203.0.113.0/24" } }, { hosting: true }],
      [{ privacy: { ...privacy, is_vpn: true } }, { anonymous: true }],
      [{ privacy: { ...privacy, is_proxy: true } }, { anonymous: true }],
      [{ privacy: { ...privacy, is_tor: true } }, { anonymous: true }],
      [{ privacy: { ...privacy, is_icloud_relay: true } }, { anonymous: true }],
      [{ privacy: { ...privacy, is_anonymous: true } }, { anonymous: true }],
      [{ privacy: { ...privacy, is_abuser: true, is_bogon: true } }, {}],
    ];
    for (const [patch, expected] of cases) {
      const o = await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, { ...IPLOCATE_BUSINESS, ...patch })) }));
      expect(o.kind).toBe("ok");
      if (o.kind === "ok") expect(o.signals).toMatchObject({ mobile: false, hosting: false, anonymous: false, ...expected });
      assertClean(o);
    }
  });

  it("an absent company leaves the ASN type to decide", async () => {
    const { company: _c, ...noCompany } = IPLOCATE_BUSINESS;
    const o = await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, noCompany)) }));
    expect(o).toEqual({ kind: "ok", signals: { companyName: null, companyDomain: null, companyType: null, asnType: "isp", mobile: false, hosting: false, anonymous: false } });
  });

  it.each([
    [401, { error: "Invalid API key" }, "auth"],
    [403, {}, "auth"],
    [429, {}, "quota"],
    [500, {}, "error"],
    [400, { error: "Invalid IP address" }, "error"],
  ])("HTTP %i -> %s", async (status, body, kind) => {
    expect(await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(status, body)) }))).toEqual({ kind });
  });

  it("timeout, network failure, oversize and malformed bodies; a non-canonical address is never sent", async () => {
    expect(await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: hangingFetch }), IP, 50)).toEqual({ kind: "timeout" });
    expect(await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => Promise.reject(new TypeError("redirect"))) }))).toEqual({ kind: "error" });
    expect(await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => json(200, { ...IPLOCATE_BUSINESS, filler: "x".repeat(70_000) })) }))).toEqual({
      kind: "error",
    });
    expect(await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: fakeFetch(() => new Response("<html>", { status: 200 })) }))).toEqual({ kind: "error" });
    const f = fakeFetch(() => json(200, IPLOCATE_BUSINESS));
    expect(await lookup(createIplocateAdapter({ apiKey: KEY, fetchImpl: f }), "203.0.113.10/../../x")).toEqual({ kind: "error" });
    expect(f.calls).toHaveLength(0);
  });
});
