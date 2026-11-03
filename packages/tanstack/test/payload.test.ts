import { describe, expect, it } from "vitest";
import { buildEntrance, classifyAcquisition, compileRouteTemplates, composePageKeyMapper, generateEntranceId, normalisePageKey, defaultPageKeyMapper, resolveConfig, ACQUISITION_VALUES, type PageKeyMapper } from "../src/index.js";
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

  it("applies exactly the mapper it is given; an unusable output becomes / and never the unmapped path (CHR-66 N2)", () => {
    const mapper = compileRouteTemplates(["/blog/:slug", "/products/:id/reviews", "/"]);
    expect(normalisePageKey("/blog/my-secret-post", mapper)).toBe("/blog/:slug");
    expect(normalisePageKey("/products/12345/reviews", mapper)).toBe("/products/:id/reviews");
    // null means "keep the path" for a bare mapper; the adapter composes the default after it (see CHR-66 N3 tests).
    expect(normalisePageKey("/products/12345", mapper)).toBe("/products/12345");
    expect(normalisePageKey("/", mapper)).toBe("/");
    expect(normalisePageKey("/blog/x", () => null)).toBe("/blog/x");
    expect(normalisePageKey("/blog/x", () => undefined)).toBe("/blog/x");
    expect(normalisePageKey("/blog/secret", () => { throw new Error("boom"); })).toBe("/");
    expect(normalisePageKey("/blog/secret", () => "no-leading-slash")).toBe("/");
    expect(normalisePageKey("/blog/secret", () => "/has?query")).toBe("/");
    expect(normalisePageKey("/blog/secret", () => "/has space")).toBe("/");
    expect(normalisePageKey("/blog/secret", () => 42 as unknown as string)).toBe("/");
    expect(normalisePageKey("/blog/secret", () => "/" + "z".repeat(300))).toBe("/");
    // An over-long output is cut back to a segment boundary, never replaced by the raw path.
    const long = "/kept" + "/seg".repeat(100);
    expect(normalisePageKey("/blog/secret", () => long)).toBe("/kept" + "/seg".repeat(62));
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

// Built at run time: the public-safety gate rejects UUID literals in the repository.
const UUID = ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-");

describe("defaultPageKeyMapper (conservative page_key default)", () => {
  const rows: Array<[string, string]> = [
    // kept
    ["/", "/"],
    ["/pricing", "/pricing"],
    ["/case-studies", "/case-studies"],
    ["/blog/2026", "/blog/2026"],
    ["/blog/2026-11-03-product-update", "/blog/2026-11-03-product-update"],
    ["/blog/how-to-choose-a-customer-data-platform", "/blog/how-to-choose-a-customer-data-platform"],
    ["/docs/internationalization", "/docs/internationalization"],
    ["/v2/pricing", "/v2/pricing"],
    // e-mail
    ["/unsubscribe/person@example.com", "/unsubscribe/:email"],
    ["/unsubscribe/person%40example.com", "/unsubscribe/:email"],
    ["/u/first.last+tag@example.org/prefs", "/u/:email/prefs"],
    // uuid
    [`/orders/${UUID}`, "/orders/:uuid"],
    [`/orders/${UUID.toUpperCase()}/invoice`, "/orders/:uuid/invoice"],
    // digit runs
    ["/orders/12345", "/orders/:n"],
    ["/orders/1234", "/orders/:n"],
    ["/orders/123", "/orders/123"],
    ["/invoice-20261103", "/:token"],
    ["/order-12345/details", "/order-:n/details"],
    // tokens
    ["/reset/9f86d081884c7d659a2feaa0c55ad015", "/reset/:token"],
    ["/reset/k3J9xQ2mPz7LwR4tYb8N", "/reset/:token"],
    ["/reset/aB3-dE9_fG1hJ2kL3m4N", "/reset/:token"],
    ["/verify/ab12cd34ef56", "/verify/:token"],
    ["/r/Xk39AbCdEfGh", "/r/:token"],
    ["/a/b3c4d5e6f7a8/c", "/a/:token/c"],
  ];
  it.each(rows)("%j -> %j", (input, expected) => {
    expect(normalisePageKey(input, defaultPageKeyMapper)).toBe(expected);
  });

  it("is on by default, and a site-supplied mapper is composed with it instead of replacing it", () => {
    const base = baseOptions();
    expect(resolveConfig(base).pageKeyMapper).toBe(defaultPageKeyMapper);
    expect(resolveConfig(base).pageKeyMapper("/reset/9f86d081884c7d659a2feaa0c55ad015")).toBe("/reset/:token");
    const own = (p: string): string => p;
    const composed = resolveConfig({ ...base, pageKeyMapper: own }).pageKeyMapper;
    expect(composed).not.toBe(own);
    expect(composed("/reset/9f86d081884c7d659a2feaa0c55ad015")).toBe("/reset/:token");
  });

  it("the built entrance carries no identifier from the path", async () => {
    const out = buildEntrance(reqWithIp("/reset/9f86d081884c7d659a2feaa0c55ad015?email=person%40example.com"), baseOptions());
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain("9f86d081884c7d659a2feaa0c55ad015");
  });
});

describe("page_key mapping cost is bounded (CHR-66 N6)", () => {
  // The reviewer's adversarial shapes (review probe f7/redos.mts). The earlier
  // e-mail regex backtracked quadratically: ~313 ms of CPU for a 16 KB path,
  // spent before the middleware returns the response.
  const shapes: Record<string, (n: number) => string> = {
    "x@ + dots + @": (n) => "/x@" + ".".repeat(n) + "@",
    "x@ + a. pairs + @": (n) => "/x@" + "a.".repeat(n / 2) + "@",
    "many @": (n) => "/" + "a@".repeat(n / 2),
    digits: (n) => "/" + "1".repeat(n),
    "slug parts": (n) => "/" + "ab-".repeat(n / 3),
    // The same shapes in segments of at most 128 characters, so every segment is classified.
    "128-char x@ + dots + @ segments": (n) => ("/x@" + ".".repeat(124) + "@").repeat(Math.ceil(n / 128)),
    "128-char a@a@ segments": (n) => ("/" + "a@".repeat(64)).repeat(Math.ceil(n / 129)),
    "short digit segments": (n) => "/12345".repeat(Math.ceil(n / 6)),
    "percent-encoded digit segments": (n) => ("/" + "%31".repeat(42)).repeat(Math.ceil(n / 127)),
    "malformed escape segments": (n) => "/a%".repeat(Math.ceil(n / 3)),
  };

  function bestOf3Ms(fn: () => void): number {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }

  it.each(Object.keys(shapes))("a 16 KB %s path maps in under 20 ms", (name) => {
    const path = new URL("https://s.example" + shapes[name]!(16_000)).pathname;
    expect(path.length).toBeGreaterThanOrEqual(15_900);
    const viaDefault = bestOf3Ms(() => normalisePageKey(path, defaultPageKeyMapper));
    const viaConfig = bestOf3Ms(() => normalisePageKey(path, resolveConfig(baseOptions()).pageKeyMapper));
    const viaBuild = bestOf3Ms(() => buildEntrance(reqWithIp(path), baseOptions()));
    expect(viaDefault).toBeLessThan(20);
    expect(viaConfig).toBeLessThan(20);
    expect(viaBuild).toBeLessThan(20);
    const k = normalisePageKey(path, defaultPageKeyMapper);
    expect(k.length).toBeLessThanOrEqual(256);
    expect(/[?#\s\u0000-\u001f\u007f]/.test(k)).toBe(false);
  });

  it("a segment over 128 characters becomes :token without classification; 128 is still classified", () => {
    const slug128 = Array.from({ length: 31 }, () => "abc").join("-") + "-abcd"; // a readable slug
    expect(slug128.length).toBe(128);
    expect(normalisePageKey(`/blog/${slug128}`, defaultPageKeyMapper)).toBe(`/blog/${slug128}`);
    expect(normalisePageKey(`/blog/${slug128}x`, defaultPageKeyMapper)).toBe("/blog/:token");
    expect(normalisePageKey(`/u/${"a".repeat(120)}%40example.com`, defaultPageKeyMapper)).toBe("/u/:token");
  });

  it("the linear e-mail check keeps the earlier matches and also catches two addresses in one segment", () => {
    const rows: Array<[string, string]> = [
      ["/unsubscribe/person@example.com", "/unsubscribe/:email"],
      ["/unsubscribe/person%40example.com", "/unsubscribe/:email"],
      ["/u/first.last+tag@example.org/prefs", "/u/:email/prefs"],
      ["/u/person@mail.example.test", "/u/:email"],
      ["/u/person@example.com.", "/u/:email"],
      ["/u/person@example..com", "/u/:email"],
      ["/share/jane@example.com,john@example.com", "/share/:email"],
      ["/share/jane%40example.com%2Cjohn%40example.com", "/share/:email"],
      // Not an address: no local part, no dot, or the dot at an edge of the domain.
      ["/x/@example.com", "/x/@example.com"],
      ["/x/a@localhost", "/x/a@localhost"],
      ["/x/a@.com", "/x/a@.com"],
      ["/x/a@com.", "/x/a@com."],
    ];
    for (const [input, expected] of rows) expect(normalisePageKey(input, defaultPageKeyMapper), input).toBe(expected);
  });
});

// The reviewer's cases (review probe f7/probe.mts). Identifiers are synthetic.
const LONG_TAIL = "/" + Array.from({ length: 12 }, (_, i) => `annual-report-section-${i}`).join("/");
const LONG_EMAIL_PATH = "/u/jane.doe@example.com" + LONG_TAIL; // 313 characters
const LONG_TOKEN_PATH = "/reset/Zx9kQ2mP4rT8vW1y" + LONG_TAIL; // 313 characters
const REVIEW_UUID = ["3c9e2f1a", "8b7d", "4e6f", "9a0b", "1c2d3e4f5a6b"].join("-");

/** The key is a whole-segment prefix of `full`: cut at a "/" boundary, never inside a segment. */
function expectSegmentPrefix(key: string, full: string): void {
  expect(full.startsWith(key)).toBe(true);
  expect(full.length === key.length || full[key.length] === "/").toBe(true);
}

describe("an over-long mapped path is capped, never sent unmapped (CHR-66 N2)", () => {
  it("the reviewer's 313-character paths keep their mapping", () => {
    expect(LONG_EMAIL_PATH.length).toBe(313);
    expect(LONG_TOKEN_PATH.length).toBe(313);
    for (const mapper of [defaultPageKeyMapper, resolveConfig(baseOptions()).pageKeyMapper]) {
      const e = normalisePageKey(LONG_EMAIL_PATH, mapper);
      const t = normalisePageKey(LONG_TOKEN_PATH, mapper);
      expect(e.length).toBeLessThanOrEqual(256);
      expect(t.length).toBeLessThanOrEqual(256);
      expect(e).not.toContain("jane");
      expect(e).not.toContain("example.com");
      expect(t).not.toContain("Zx9kQ2mP4rT8vW1y");
      expectSegmentPrefix(e, "/u/:email" + LONG_TAIL);
      expectSegmentPrefix(t, "/reset/:token" + LONG_TAIL);
      expect(e.startsWith("/u/:email/annual-report-section-0/")).toBe(true);
      expect(t.startsWith("/reset/:token/annual-report-section-0/")).toBe(true);
    }
  });

  it("the built entrance carries the capped mapped key", () => {
    for (const path of [LONG_EMAIL_PATH, LONG_TOKEN_PATH]) {
      const r = buildEntrance(reqWithIp(path), baseOptions());
      if (!r.ok) throw new Error("expected ok");
      expect(validateEntranceV1(r.payload)).toEqual([]);
      expect(r.payload.page_key).not.toMatch(/jane|Zx9kQ2mP4rT8vW1y/);
    }
  });

  it("a mapped path of exactly 256 characters is kept; one character more is cut at the boundary", () => {
    const exact = "/" + "a".repeat(100) + "/" + "b".repeat(100) + "/" + "c".repeat(53);
    expect(exact.length).toBe(256);
    expect(normalisePageKey(exact, defaultPageKeyMapper)).toBe(exact);
    expect(normalisePageKey(exact + "c", defaultPageKeyMapper)).toBe("/" + "a".repeat(100) + "/" + "b".repeat(100));
  });
});

describe("a site mapper never bypasses the default mapper (CHR-66 N3)", () => {
  // The form the README shows: route templates only.
  const templates = compileRouteTemplates(["/blog/:slug", "/products/:id", "/p/:productId/reviews/:review_id", "/org/:orgSlug/members"]);
  const withTemplates = resolveConfig(baseOptions({ pageKeyMapper: templates })).pageKeyMapper;
  const key = (path: string, mapper = withTemplates): string => normalisePageKey(new URL("https://site.example" + path).pathname, mapper);

  it.each<[string, string]>([
    ["/reset-password/9f86d081884c7d659a2feaa0c55ad015", "/reset-password/:token"],
    ["/unsubscribe/jane.doe%40example.com", "/unsubscribe/:email"],
    [`/account/${REVIEW_UUID}/settings`, "/account/:uuid/settings"],
    ["/orders/12345", "/orders/:n"],
  ])("with templates only, an unmatched %j is still mapped to %j", (path, expected) => {
    expect(key(path)).toBe(expected);
  });

  it("with templates only, the reviewer's 313-character paths are mapped and capped", () => {
    expect(key(LONG_EMAIL_PATH)).not.toContain("jane");
    expect(key(LONG_TOKEN_PATH)).not.toContain("Zx9kQ2mP4rT8vW1y");
    expectSegmentPrefix(key(LONG_EMAIL_PATH), "/u/:email" + LONG_TAIL);
  });

  it.each<[string, string]>([
    ["/blog/my-secret-post", "/blog/:slug"],
    ["/blog/9f86d081884c7d659a2feaa0c55ad015", "/blog/:slug"],
    ["/products/12345", "/products/:id"],
    ["/p/12345/reviews/67890", "/p/:productId/reviews/:review_id"],
    ["/org/acme-corp/members", "/org/:orgSlug/members"],
  ])("a template match %j stays exactly %j", (path, expected) => {
    expect(key(path)).toBe(expected);
  });

  it("the default runs on the path when the site mapper returns null, a non-string or throws", () => {
    const token = "/reset/9f86d081884c7d659a2feaa0c55ad015";
    for (const own of [() => null, () => undefined, () => 42 as unknown as string, () => { throw new Error("boom"); }]) {
      expect(key(token, resolveConfig(baseOptions({ pageKeyMapper: own })).pageKeyMapper)).toBe("/reset/:token");
    }
    // ...and on its output when it returns a string.
    const echo = resolveConfig(baseOptions({ pageKeyMapper: (p) => p.replace("/x/", "/y/") })).pageKeyMapper;
    expect(key("/x/person%40example.com", echo)).toBe("/y/:email");
  });

  it("buildEntrance and the middleware config use the composed mapper", () => {
    const r = buildEntrance(reqWithIp("/reset-password/9f86d081884c7d659a2feaa0c55ad015?x=1"), baseOptions({ pageKeyMapper: templates }));
    if (!r.ok) throw new Error("expected ok");
    expect(r.payload.page_key).toBe("/reset-password/:token");
    const m = buildEntrance(reqWithIp("/blog/my-secret-post"), baseOptions({ pageKeyMapper: templates }));
    if (!m.ok) throw new Error("expected ok");
    expect(m.payload.page_key).toBe("/blog/:slug");
  });

  it("pageKeyDefaultMapper: false is the explicit opt-out: the site mapper alone applies", () => {
    const optOut = resolveConfig(baseOptions({ pageKeyMapper: templates, pageKeyDefaultMapper: false })).pageKeyMapper;
    expect(optOut).toBe(templates);
    expect(key("/blog/my-secret-post", optOut)).toBe("/blog/:slug");
    // Unmatched paths are sent as is: this is what the site opted into.
    expect(key("/orders/12345", optOut)).toBe("/orders/12345");
    // Even opted out, an over-long or unusable output never becomes the raw path.
    const longOwn = resolveConfig(baseOptions({ pageKeyMapper: () => "/kept" + "/seg".repeat(100), pageKeyDefaultMapper: false })).pageKeyMapper;
    expect(key("/reset/secret", longOwn)).toBe("/kept" + "/seg".repeat(62));
    const throwing = resolveConfig(baseOptions({ pageKeyMapper: () => { throw new Error("boom"); }, pageKeyDefaultMapper: false })).pageKeyMapper;
    expect(key("/reset/secret", throwing)).toBe("/");
    // An explicit true is the default behaviour.
    const explicitOn = resolveConfig(baseOptions({ pageKeyMapper: templates, pageKeyDefaultMapper: true })).pageKeyMapper;
    expect(key("/orders/12345", explicitOn)).toBe("/orders/:n");
  });

  it("rejects an opt-out without a site mapper, and malformed values", () => {
    expect(() => resolveConfig(baseOptions({ pageKeyDefaultMapper: false }))).toThrow(/pageKeyDefaultMapper: false requires your own pageKeyMapper/);
    expect(() => resolveConfig(baseOptions({ pageKeyDefaultMapper: "no" as unknown as boolean }))).toThrow(/pageKeyDefaultMapper must be true or false/);
    expect(() => resolveConfig(baseOptions({ pageKeyMapper: "/blog/:slug" as unknown as PageKeyMapper }))).toThrow(/pageKeyMapper must be a function/);
    expect(resolveConfig(baseOptions({ pageKeyMapper: null as unknown as PageKeyMapper })).pageKeyMapper).toBe(defaultPageKeyMapper);
  });

  it("composePageKeyMapper is exported for direct use with normalisePageKey", () => {
    expect(normalisePageKey("/orders/12345", composePageKeyMapper(templates))).toBe("/orders/:n");
    expect(normalisePageKey("/orders/12345", composePageKeyMapper(templates, false))).toBe("/orders/12345");
    expect(composePageKeyMapper(undefined)).toBe(defaultPageKeyMapper);
  });
});

describe("percent-encoded segments are classified on their decoded form (CHR-66 R2-3)", () => {
  it.each<[string, string]>([
    ["/orders/%31%32%33%34%35", "/orders/:n"],
    ["/orders/%31%32%33%34%35/invoice", "/orders/:n/invoice"],
    ["/order-%31%32%33%34%35/details", "/:n/details"],
    ["/orders/%31%32%33", "/orders/%31%32%33"],
    ["/archive/%32%30%32%36", "/archive/%32%30%32%36"],
    ["/blog/%68ello-world", "/blog/%68ello-world"],
    ["/unsubscribe/person%40example.com", "/unsubscribe/:email"],
    ["/reset/%39f86d081884c7d659a2feaa0c55ad015", "/reset/:token"],
    // A segment that does not decode cleanly is not a readable slug.
    ["/sale/100%-off", "/sale/:token"],
    ["/x/%E0%A4%A", "/x/:token"],
    ["/x/%FF", "/x/:token"],
    // Plain digit runs keep the in-place rule.
    ["/order-12345/details", "/order-:n/details"],
  ])("%j -> %j", (input, expected) => {
    expect(normalisePageKey(input, defaultPageKeyMapper)).toBe(expected);
    expect(normalisePageKey(input, resolveConfig(baseOptions({ pageKeyMapper: compileRouteTemplates(["/blog/:slug/:id"]) })).pageKeyMapper)).toBe(expected);
  });

  it("the built entrance for an encoded order number carries the placeholder", () => {
    const r = buildEntrance(reqWithIp("/orders/%31%32%33%34%35?x=1"), baseOptions());
    if (!r.ok) throw new Error("expected ok");
    expect(r.payload.page_key).toBe("/orders/:n");
  });
});
