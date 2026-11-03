import { describe, expect, it } from "vitest";
import { buildEntrance, classifyAcquisition, compileRouteTemplates, generateEntranceId, normalisePageKey, ACQUISITION_VALUES } from "../src/index.js";
import { assemblePayload } from "../src/payload.js";
import { baseOptions, PUBLIC_IP, PUBLIC_IP_V6, reqWithIp, validateEntranceV1 } from "./helpers.js";

describe("normalisePageKey", () => {
  const rows: Array<[string, string]> = [
    ["/", "/"],
    ["/pricing", "/pricing"],
    ["/pricing/", "/pricing"],
    ["//pricing//enterprise//", "/pricing/enterprise"],
    ["/pricing?plan=pro", "/pricing"],
    ["/pricing#section", "/pricing"],
    ["/pricing?a=1#b", "/pricing"],
    ["https://www.example.com/blog/post?utm_source=x&email=person%40example.com", "/blog/post"],
    ["/a/./b/../c", "/a/c"],
    ["/caf%C3%A9", "/caf%C3%A9"],
    ["/with space", "/with%20space"],
    ["/tab\there", "/tabhere"],
    ["//evil.example.net/x", "/evil.example.net/x"],
    ["/a%3Fb", "/a%3Fb"],
    ["/a%23b", "/a%23b"],
    ["", "/"],
    ["https://", "/"],
  ];
  it.each(rows)("%j -> %j", (input, expected) => {
    expect(normalisePageKey(input)).toBe(expected);
  });

  it("never contains ?, #, whitespace or control characters, for hostile input", () => {
    const hostile = ["/a?b#c", "/a\u0000b", "/a\nb", "/a\u007fb", "/ nb", "/x y?z", "/%0d%0aX", "/\t", "\\\\evil\\path", "/a;b=c?d"];
    for (const h of hostile) {
      const k = normalisePageKey(h);
      expect(k.startsWith("/")).toBe(true);
      expect(/[?#\s\u0000-\u001f\u007f]/.test(k)).toBe(false);
      expect(k.length).toBeLessThanOrEqual(256);
    }
  });

  it("caps at 256 characters on a segment boundary", () => {
    const long = "/" + Array.from({ length: 80 }, (_, i) => `seg${i}`).join("/");
    const k = normalisePageKey(long);
    expect(k.length).toBeLessThanOrEqual(256);
    expect(long.startsWith(k)).toBe(true);
    expect(k.endsWith("/")).toBe(false);
    expect(normalisePageKey("/" + "a".repeat(400))).toBe("/");
  });

  it("applies a route-template mapper and falls back safely", () => {
    const mapper = compileRouteTemplates(["/blog/:slug", "/products/:id/reviews", "/"]);
    expect(normalisePageKey("/blog/my-secret-post", mapper)).toBe("/blog/:slug");
    expect(normalisePageKey("/products/12345/reviews", mapper)).toBe("/products/:id/reviews");
    expect(normalisePageKey("/products/12345", mapper)).toBe("/products/12345");
    expect(normalisePageKey("/", mapper)).toBe("/");
    expect(normalisePageKey("/blog/x", () => { throw new Error("boom"); })).toBe("/blog/x");
    expect(normalisePageKey("/blog/x", () => "no-leading-slash")).toBe("/blog/x");
    expect(normalisePageKey("/blog/x", () => "/has?query")).toBe("/blog/x");
    expect(normalisePageKey("/blog/x", () => "/" + "z".repeat(300))).toBe("/blog/x");
    expect(normalisePageKey("/blog/x", () => null)).toBe("/blog/x");
  });
});

describe("classifyAcquisition", () => {
  const site = ["www.example.com"];
  type Row = { name: string; referrer?: string | null; utm?: string | null; expect: (typeof ACQUISITION_VALUES)[number] };
  const rows: Row[] = [
    { name: "no referrer", expect: "direct" },
    { name: "empty referrer", referrer: "", expect: "direct" },
    { name: "internal exact host", referrer: "https://www.example.com/pricing", expect: "internal" },
    { name: "internal without www", referrer: "https://example.com/", expect: "internal" },
    { name: "internal beats utm_medium", referrer: "https://www.example.com/", utm: "cpc", expect: "internal" },
    { name: "google search", referrer: "https://www.google.com/", expect: "search" },
    { name: "google regional", referrer: "https://www.google.co.uk/", expect: "search" },
    { name: "bing", referrer: "https://www.bing.com/search?q=x", expect: "search" },
    { name: "duckduckgo", referrer: "https://duckduckgo.com/", expect: "search" },
    { name: "lookalike google host is a referral", referrer: "https://google.com.evil.example.net/", expect: "referral" },
    { name: "linkedin", referrer: "https://www.linkedin.com/feed/", expect: "social" },
    { name: "t.co", referrer: "https://t.co/abc", expect: "social" },
    { name: "reddit", referrer: "https://old.reddit.com/r/x", expect: "social" },
    { name: "webmail", referrer: "https://mail.google.com/mail/u/0/", expect: "email" },
    { name: "other site", referrer: "https://partner.example.org/page", expect: "referral" },
    { name: "http referrer", referrer: "http://partner.example.org/", expect: "referral" },
    { name: "garbage referrer", referrer: "not a url", expect: "unknown" },
    { name: "non-http referrer", referrer: "android-app://com.example.app", expect: "unknown" },
    { name: "utm cpc, no referrer", utm: "cpc", expect: "paid" },
    { name: "utm paid social overrides social referrer", referrer: "https://www.linkedin.com/", utm: "paid_social", expect: "paid" },
    { name: "utm email", utm: "email", expect: "email" },
    { name: "utm Email (case)", utm: " Email ", expect: "email" },
    { name: "utm social", utm: "social", expect: "social" },
    { name: "utm organic", utm: "organic", expect: "search" },
    { name: "utm referral", utm: "referral", expect: "referral" },
    { name: "unknown utm falls back to referrer", referrer: "https://www.bing.com/", utm: "weird", expect: "search" },
    { name: "unknown utm with no referrer is direct", utm: "weird", expect: "direct" },
    { name: "utm injection attempt is not echoed", utm: "cpc<script>", expect: "direct" },
  ];
  it.each(rows)("$name", (row) => {
    expect(classifyAcquisition({ referrer: row.referrer ?? null, siteHosts: site, utmMedium: row.utm ?? null })).toBe(row.expect);
  });

  it("only ever returns members of the closed enum, whatever the input", () => {
    const junk = ["", "x", "https://a.b", "javascript:alert(1)", "https://user:pw@example.net:8080/p?q#f", "\u0000", "a".repeat(5000), "https://" + "a".repeat(300) + ".example.com/"];
    for (const r of junk) for (const u of junk) {
      expect(ACQUISITION_VALUES).toContain(classifyAcquisition({ referrer: r, siteHosts: site, utmMedium: u }));
    }
  });
});

describe("entrance_id", () => {
  it("is 128-bit random base64url", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = generateEntranceId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(2000);
  });
});

describe("payload validated strictly against entrance.v1", () => {
  it("the validator rejects each class of violation (self-test)", () => {
    const good = assemblePayload({ websiteId: "example-site", ip: PUBLIC_IP, pageKey: "/x", acquisition: "direct" });
    expect(validateEntranceV1(good)).toEqual([]);
    const bad: Array<Record<string, unknown>> = [
      { ...good, extra: 1 }, { ...good, contract: "entrance.v2" }, { ...good, website_id: "Example" }, { ...good, ip: "" }, { ...good, entrance_id: "short" },
      { ...good, occurred_at: "2026-11-03 10:00:00" }, { ...good, page_key: "no-slash" }, { ...good, page_key: "/a?b" }, { ...good, acquisition: "other" }, { ...good, eligibility: "TSA" },
    ];
    for (const b of bad) expect(validateEntranceV1(b).length).toBeGreaterThan(0);
    const { ip: _ip, ...missing } = good;
    expect(validateEntranceV1(missing)).toContain("missing field ip");
  });

  it("buildEntrance output is valid for a spread of requests", () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ["/", PUBLIC_IP, {}],
      ["/pricing?plan=pro&email=person@example.com#x", PUBLIC_IP, { referer: "https://www.google.com/search?q=secret" }],
      ["/blog/a/b/c/", PUBLIC_IP_V6, { referer: "https://www.linkedin.com/" }],
      ["/x?utm_medium=cpc", PUBLIC_IP, {}],
      ["/" + "long/".repeat(80), PUBLIC_IP, {}],
    ];
    for (const [path, ip, headers] of cases) {
      const r = buildEntrance(reqWithIp(path, ip, headers), baseOptions());
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(validateEntranceV1(r.payload)).toEqual([]);
      expect(r.payload.eligibility).toBe("tsa-1");
      expect(r.payload.contract).toBe("entrance.v1");
      expect(r.payload.website_id).toBe("example-site");
    }
  });

  it("derives fields only from the request, and carries nothing else", () => {
    const r = buildEntrance(reqWithIp("/pricing?token=SECRETVALUE&email=person%40example.com", PUBLIC_IP, { referer: "https://www.google.com/search?q=SECRETQUERY", cookie: "sid=COOKIEVALUE", authorization: "Bearer HEADERSECRET" }), baseOptions());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = JSON.stringify(r.payload);
    for (const leak of ["SECRETVALUE", "person", "SECRETQUERY", "COOKIEVALUE", "HEADERSECRET", "Mozilla", "google"]) expect(text).not.toContain(leak);
    expect(Object.keys(r.payload).sort()).toEqual(["acquisition", "contract", "eligibility", "entrance_id", "ip", "occurred_at", "page_key", "website_id"]);
    expect(r.payload.page_key).toBe("/pricing");
    expect(r.payload.acquisition).toBe("search");
    expect(r.payload.ip).toBe(PUBLIC_IP);
  });

  it("occurred_at is now, whole-second UTC", () => {
    const before = Date.now();
    const r = buildEntrance(reqWithIp(), baseOptions());
    if (!r.ok) throw new Error("expected ok");
    const t = Date.parse(r.payload.occurred_at);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
    expect(r.payload.occurred_at.endsWith("Z")).toBe(true);
  });

  it("returns a closed rejection (no IP echo) for ineligible requests and untrusted IPs", () => {
    expect(buildEntrance(reqWithIp("/api/x"), baseOptions())).toEqual({ ok: false, stage: "eligibility", reason: "api_path" });
    expect(buildEntrance(reqWithIp("/pricing", "10.1.2.3"), baseOptions())).toEqual({ ok: false, stage: "ip", reason: "ip_non_public" });
    expect(buildEntrance(reqWithIp("/pricing", "198.51.100.7"), baseOptions({ allowDocumentationRanges: false }))).toEqual({ ok: false, stage: "ip", reason: "ip_non_public" });
  });

  it("uses siteHosts for the internal check", () => {
    const opts = baseOptions({ siteHosts: ["shop.example.com"] });
    const r = buildEntrance(reqWithIp("/p", PUBLIC_IP, { referer: "https://shop.example.com/cart" }), opts);
    if (!r.ok) throw new Error("expected ok");
    expect(r.payload.acquisition).toBe("internal");
  });
});
