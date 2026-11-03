import { describe, expect, it } from "vitest";
import { buildEntrance, createCollectorRoute, createIdrServerMiddleware, DEFAULT_COLLECTOR_PATH, isEligible, resolveConfig, type EligibilityRules } from "../src/index.js";
import { BROWSER_HEADERS, req, TEST_TOKEN } from "./helpers.js";

type Row = { name: string; path?: string; headers?: Record<string, string>; method?: string; rules?: EligibilityRules; base?: boolean; expect: true | string };

const rows: Row[] = [
  { name: "plain browser navigation", expect: true },
  { name: "navigation with query string", path: "/pricing?plan=pro&utm_source=x", expect: true },
  { name: "root", path: "/", expect: true },
  { name: "deep route", path: "/blog/2026/hello-world", expect: true },
  { name: "Safari-style Accept", headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }, expect: true },
  { name: "no Sec-Fetch headers (older browsers)", base: false, headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0" }, expect: true },

  { name: "POST", method: "POST", expect: "method" },
  { name: "HEAD", method: "HEAD", expect: "method" },
  { name: "OPTIONS", method: "OPTIONS", expect: "method" },
  { name: "PUT", method: "PUT", expect: "method" },
  { name: "websocket upgrade", headers: { upgrade: "websocket" }, expect: "upgrade" },

  { name: "Sec-Fetch-Dest iframe", headers: { "sec-fetch-dest": "iframe" }, expect: "fetch_dest" },
  { name: "Sec-Fetch-Dest empty (fetch/XHR)", headers: { "sec-fetch-dest": "empty" }, expect: "fetch_dest" },
  { name: "Sec-Fetch-Dest script", headers: { "sec-fetch-dest": "script" }, expect: "fetch_dest" },
  { name: "Sec-Fetch-Dest image", headers: { "sec-fetch-dest": "image" }, expect: "fetch_dest" },
  { name: "Sec-Fetch-Mode cors", headers: { "sec-fetch-mode": "cors" }, expect: "fetch_mode" },
  { name: "Sec-Fetch-Mode no-cors", headers: { "sec-fetch-mode": "no-cors" }, expect: "fetch_mode" },
  { name: "Sec-Fetch-Mode same-origin", headers: { "sec-fetch-mode": "same-origin" }, expect: "fetch_mode" },
  { name: "Accept JSON", headers: { accept: "application/json" }, expect: "accept" },
  { name: "Accept wildcard only (curl default)", headers: { accept: "*/*" }, expect: "accept" },
  { name: "Accept image", headers: { accept: "image/avif,image/webp,*/*" }, expect: "accept" },

  { name: "Purpose: prefetch", headers: { purpose: "prefetch" }, expect: "prefetch" },
  { name: "Purpose: prerender", headers: { purpose: "prerender" }, expect: "prefetch" },
  { name: "Sec-Purpose: prefetch", headers: { "sec-purpose": "prefetch" }, expect: "prefetch" },
  { name: "Sec-Purpose: prefetch;prerender", headers: { "sec-purpose": "prefetch;prerender" }, expect: "prefetch" },
  { name: "X-Moz: prefetch", headers: { "x-moz": "prefetch" }, expect: "prefetch" },
  { name: "X-Purpose: preview", headers: { "x-purpose": "preview" }, expect: "prefetch" },

  { name: "no User-Agent", base: false, headers: { accept: "text/html" }, expect: "no_user_agent" },
  { name: "empty User-Agent", headers: { "user-agent": " " }, expect: "no_user_agent" },

  { name: "asset .js", path: "/assets/app-1a2b3c.js", expect: "internal_path" },
  { name: "asset .css", path: "/styles/site.css", expect: "asset" },
  { name: "asset .png", path: "/img/logo.PNG", expect: "asset" },
  { name: "asset .woff2", path: "/fonts/inter.woff2", expect: "asset" },
  { name: "asset .map", path: "/x/main.js.map", expect: "asset" },
  { name: "favicon", path: "/favicon.ico", expect: "internal_path" },
  { name: "robots.txt", path: "/robots.txt", expect: "internal_path" },
  { name: "sitemap.xml", path: "/sitemap.xml", expect: "internal_path" },
  { name: "sitemap index", path: "/sitemap-0.xml", expect: "internal_path" },
  { name: "manifest", path: "/site.webmanifest", expect: "asset" },
  { name: "pdf", path: "/docs/guide.pdf", expect: "asset" },
  { name: ".well-known", path: "/.well-known/security.txt", expect: "internal_path" },
  { name: "cdn-cgi", path: "/cdn-cgi/challenge-platform/scripts/jsd/main.js", expect: "internal_path" },

  { name: "TanStack server function", path: "/_serverFn/abc123", expect: "server_fn" },
  { name: "TanStack server function (lower-case)", path: "/_serverfn/abc123", expect: "server_fn" },
  { name: "TanStack server route namespace", path: "/_server/x", expect: "server_fn" },
  { name: "server function header", headers: { "x-tsr-serverFn": "true" }, expect: "server_fn" },
  { name: "_build", path: "/_build/assets/a.js", expect: "internal_path" },
  { name: "dunder internal", path: "/__debug", expect: "internal_path" },

  { name: "api root", path: "/api", expect: "api_path" },
  { name: "api path", path: "/api/users/1", expect: "api_path" },
  { name: "API upper-case", path: "/API/v2/x", expect: "api_path" },
  { name: "path that merely starts with api (/apiary)", path: "/apiary", expect: true },
  { name: "path /apis-overview", path: "/apis-overview", expect: true },

  { name: "health", path: "/health", expect: "health_path" },
  { name: "healthz", path: "/healthz", expect: "health_path" },
  { name: "readyz", path: "/readyz", expect: "health_path" },
  { name: "livez", path: "/livez", expect: "health_path" },
  { name: "ping", path: "/ping", expect: "health_path" },
  { name: "health subpath", path: "/health/db", expect: "health_path" },
  { name: "page named healthcare", path: "/healthcare", expect: true },
  { name: "page named liveblog", path: "/liveblog", expect: true },

  { name: "exclude pattern (prefix)", path: "/admin/users", rules: { excludePaths: ["/admin/*"] }, expect: "excluded_path" },
  { name: "exclude pattern (exact)", path: "/thanks", rules: { excludePaths: ["/thanks"] }, expect: "excluded_path" },
  { name: "exclude exact does not match longer path", path: "/thanks/more", rules: { excludePaths: ["/thanks"] }, expect: true },
  { name: "exclude pattern (regex)", path: "/preview/abc", rules: { excludePaths: [/^\/preview\//] }, expect: "excluded_path" },
  { name: "include list admits match", path: "/pricing", rules: { includePaths: ["/pricing", "/blog/*"] }, expect: true },
  { name: "include list admits prefix", path: "/blog/post", rules: { includePaths: ["/pricing", "/blog/*"] }, expect: true },
  { name: "include list rejects others", path: "/careers", rules: { includePaths: ["/pricing", "/blog/*"] }, expect: "not_included_path" },
  { name: "exclude wins over include", path: "/blog/draft", rules: { includePaths: ["/blog/*"], excludePaths: ["/blog/draft"] }, expect: "excluded_path" },
  { name: "extra bot pattern", headers: { "user-agent": "Mozilla/5.0 AcmeInternalProbe/1.0" }, rules: { extraBotPatterns: [/AcmeInternalProbe/] }, expect: "bot_or_monitor" },
  { name: "global regex lastIndex does not leak between calls", path: "/x", rules: { excludePaths: [/x/g] }, expect: "excluded_path" },
];

const BOT_UAS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +https://example.com/claudebot)",
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
  "UptimeRobot/2.0 (+http://www.uptimerobot.com/)",
  "Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)",
  "curl/8.5.0",
  "Wget/1.21.4",
  "python-requests/2.32.0",
  "python-httpx/0.27",
  "Go-http-client/2.0",
  "okhttp/4.12.0",
  "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
  "axios/1.7.2",
  "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 Chrome-Lighthouse",
  "Mozilla/5.0 (compatible; Datadog Synthetic Monitor)",
  "Mozilla/5.0 (compatible; Site24x7)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Twitterbot/1.0",
  "WhatsApp/2.23",
  "Mozilla/5.0 (compatible; Bytespider)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 Applebot/0.1",
  "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)",
  "Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
  "Cloudflare-Traffic-Manager/1.0",
  "Cloudflare-Healthchecks/1.0",
  "Mozilla/5.0 (compatible; Prerender)",
  "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
  "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)",
];

const HUMAN_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
];

describe("tsa-1 eligibility", () => {
  it.each(rows)("$name", (row) => {
    const request = req(row.path ?? "/pricing", row.headers ?? {}, { ...(row.method ? { method: row.method } : {}), ...(row.base === false ? { base: false } : {}) });
    const r = isEligible(request, row.rules);
    if (row.expect === true) expect(r).toEqual({ eligible: true, ruleSet: "tsa-1" });
    else expect(r).toEqual({ eligible: false, reason: row.expect });
  });

  it.each(BOT_UAS)("bot or monitor: %s", (ua) => {
    expect(isEligible(req("/pricing", { "user-agent": ua }))).toEqual({ eligible: false, reason: "bot_or_monitor" });
  });

  it.each(HUMAN_UAS)("human browser: %s", (ua) => {
    expect(isEligible(req("/pricing", { "user-agent": ua }))).toEqual({ eligible: true, ruleSet: "tsa-1" });
  });

  it("reads only metadata: eligibility never touches the body or cookies", () => {
    const request = req("/pricing", { cookie: "session=abc" });
    expect(isEligible(request).eligible).toBe(true);
    expect(request.bodyUsed).toBe(false);
  });

  it("the shared header fixture is itself eligible (guards the other test files)", () => {
    expect(isEligible(new Request("https://www.example.com/", { headers: BROWSER_HEADERS })).eligible).toBe(true);
  });
});

describe("tsa-1 eligibility: the collector path is never eligible (G5-D-F1)", () => {
  // A realistic browser navigation: every other rule would admit it.
  const nav = (path: string, method = "GET") => req(path, {}, { method });

  it("the default collector path /idr/e, without any configuration", () => {
    expect(isEligible(nav("/idr/e"))).toEqual({ eligible: false, reason: "collector_path" });
    expect(isEligible(nav("/idr/e"), {})).toEqual({ eligible: false, reason: "collector_path" });
    expect(isEligible(nav("/idr/e"), undefined, undefined)).toEqual({ eligible: false, reason: "collector_path" });
    expect(DEFAULT_COLLECTOR_PATH).toBe("/idr/e");
  });

  // Checked before the method rule, on its own: the exclusion does not rely on "method" (non-GET) to hold.
  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("%s to the collector path: collector_path, not method", (method) => {
    expect(isEligible(nav("/idr/e", method))).toEqual({ eligible: false, reason: "collector_path" });
  });

  // Every spelling a router could dispatch to the collector route (TanStack Router: trailing slashes trimmed, static
  // segments matched case-insensitively, percent-encoding decoded), plus deliberate over-exclusion of the same path.
  it.each([
    ["trailing slash", "/idr/e/"],
    ["several trailing slashes", "/idr/e///"],
    ["upper case", "/IDR/E"],
    ["mixed case with trailing slash", "/Idr/E/"],
    ["percent-encoded last segment", "/idr/%65"],
    ["percent-encoded, lower-case hex", "/%69dr/e"],
    ["every character percent-encoded", "/%69%64%72/%65"],
    ["percent-encoded upper case", "/%49DR/%45"],
    ["encoded separator %2F (over-excluded)", "/idr%2Fe"],
    ["encoded separator %2f (over-excluded)", "/idr%2fe"],
    ["encoded trailing slash", "/idr/e%2F"],
    ["encoded backslash separator (over-excluded)", "/idr%5Ce"],
    ["duplicate leading slash (kept by the URL parser)", "//idr/e"],
    ["triple leading slash", "///idr/e"],
    ["duplicate inner slash (over-excluded)", "/idr//e"],
    ["dot segment (resolved by the URL parser)", "/idr/./e"],
    ["parent segment (resolved by the URL parser)", "/x/../idr/e"],
    ["encoded dot segment (resolved by the URL parser)", "/idr/%2e/e"],
    ["backslash (a separator for http URLs)", "/idr\\e"],
    ["query string", "/idr/e?utm_medium=email"],
    ["fragment", "/idr/e#top"],
  ])("variant: %s (%s)", (_n, path) => {
    expect(isEligible(nav(path))).toEqual({ eligible: false, reason: "collector_path" });
    expect(isEligible(nav(path, "HEAD"))).toEqual({ eligible: false, reason: "collector_path" });
  });

  // Never an unrelated page: no prefix match, no suffix match.
  it.each([
    "/idr/ex",
    "/idr/e-mail",
    "/idr/e.html",
    "/idr",
    "/idr/",
    "/idr/e/x",
    "/idr/f",
    "/idre",
    "/xidr/e",
    "/e",
    "/idr/e%20",
    "/idr/e;x",
    "/idr/%66",
    "/blog/idr/e",
  ])("non-match stays eligible: %s", (path) => {
    expect(isEligible(nav(path))).toEqual({ eligible: true, ruleSet: "tsa-1" });
  });

  it("other exclusions keep their own reason (api_path is not turned into collector_path)", () => {
    expect(isEligible(nav("/api/idr/e"))).toEqual({ eligible: false, reason: "api_path" });
    expect(isEligible(nav("/pricing", "POST"))).toEqual({ eligible: false, reason: "method" });
    expect(isEligible(nav("/pricing", "HEAD"))).toEqual({ eligible: false, reason: "method" });
  });

  it("includePaths cannot re-admit the collector path, and excludePaths is not needed for it", () => {
    expect(isEligible(nav("/idr/e"), { includePaths: ["/idr/e", "/idr/*"] })).toEqual({ eligible: false, reason: "collector_path" });
    expect(isEligible(nav("/idr/e"), { excludePaths: ["/idr/e"] })).toEqual({ eligible: false, reason: "collector_path" });
  });

  it("a custom collectorPath replaces the default, with the same variants", () => {
    const custom = "/t/collect";
    for (const path of ["/t/collect", "/T/Collect/", "/t/%63ollect", "//t/collect"]) {
      expect(isEligible(nav(path), {}, custom)).toEqual({ eligible: false, reason: "collector_path" });
    }
    for (const path of ["/t/collected", "/t", "/t/collect/x"]) expect(isEligible(nav(path), {}, custom)).toEqual({ eligible: true, ruleSet: "tsa-1" });
    // The default path is an ordinary page once the collector lives elsewhere.
    expect(isEligible(nav("/idr/e"), {}, custom)).toEqual({ eligible: true, ruleSet: "tsa-1" });
    // A configured trailing slash or upper case is normalised.
    expect(isEligible(nav("/t/collect"), {}, "/T/Collect/")).toEqual({ eligible: false, reason: "collector_path" });
  });

  it("buildEntrance and resolveConfig apply the collectorPath option (default and custom)", () => {
    const withIp = (path: string) => req(path, { "x-client-ip": "198.51.100.23" });
    const options = { resolverUrl: "https://resolver.example.com", token: TEST_TOKEN, websiteId: "example-site", trustPolicy: { mode: "header", name: "x-client-ip" } as const, allowDocumentationRanges: true };
    expect(buildEntrance(withIp("/idr/e"), options)).toEqual({ ok: false, stage: "eligibility", reason: "collector_path" });
    expect(buildEntrance(withIp("/pricing"), options).ok).toBe(true);
    expect(buildEntrance(withIp("/t/collect/"), { ...options, collectorPath: "/t/collect" })).toEqual({ ok: false, stage: "eligibility", reason: "collector_path" });
    expect(buildEntrance(withIp("/idr/e"), { ...options, collectorPath: "/t/collect" }).ok).toBe(true);
    expect(resolveConfig(options).collectorPath).toBe("/idr/e");
    expect(resolveConfig({ ...options, collectorPath: "/T/Collect/" }).collectorPath).toBe("/t/collect");
  });

  const INVALID: Array<[string, unknown]> = [
    ["empty", ""],
    ["relative", "idr/e"],
    ["root only", "/"],
    ["root with trailing slash", "//"],
    ["protocol-relative", "//idr/e"],
    ["backslash host", "/\\idr/e"],
    ["absolute URL", "https://www.example.com/idr/e"],
    ["wildcard", "/idr/*"],
    ["trailing wildcard", "/idr/e*"],
    ["query string", "/idr/e?x=1"],
    ["fragment", "/idr/e#x"],
    ["percent-encoding", "/idr/%65"],
    ["empty inner segment", "/idr//e"],
    ["dot segment", "/idr/./e"],
    ["parent segment", "/idr/../e"],
    ["whitespace", "/idr e"],
    ["control character", "/idr/e\n"],
    ["too long (257 characters)", "/" + "a".repeat(256)],
    ["number", 42],
    ["object", { path: "/idr/e" }],
  ];
  it.each(INVALID)("an invalid collectorPath (%s) is rejected at configuration, without echoing it", (_n, value) => {
    const options = { resolverUrl: "https://resolver.example.com", token: TEST_TOKEN, websiteId: "example-site", trustPolicy: { mode: "none" } as const, collectorPath: value as string };
    let message = "";
    try {
      resolveConfig(options);
    } catch (e) {
      message = (e as Error).message;
    }
    // One fixed message for every invalid value: it never echoes what was configured.
    expect(message).toBe("idr-tanstack: collectorPath must be a plain same-origin path such as /idr/e (no query string, fragment, wildcard, percent-encoding, empty or dot segment; at most 256 characters)");
    expect(() => createIdrServerMiddleware(options)).toThrow(/collectorPath/);
    expect(() => createCollectorRoute({ ...options, allow: ["cta_click"] })).toThrow(/collectorPath/);
    expect(() => isEligible(nav("/pricing"), {}, value as string)).toThrow(/collectorPath/);
  });

  it("the longest accepted collectorPath is 256 characters", () => {
    const longest = "/" + "a".repeat(255);
    expect(isEligible(nav(longest), {}, longest)).toEqual({ eligible: false, reason: "collector_path" });
  });

  it("matching is linear: 16 KB adversarial paths are classified in under 20 ms", () => {
    const paths = ["/" + "/".repeat(16_000) + "idr/e", "/idr" + "%2F".repeat(5_000) + "e", "/" + "%".repeat(16_000), "/" + "%41%".repeat(4_000) + "/idr/e"];
    const t0 = performance.now();
    const reasons = paths.map((p) => {
      const r = isEligible(nav(p));
      return r.eligible ? "eligible" : r.reason;
    });
    expect(performance.now() - t0).toBeLessThan(20);
    expect(reasons.slice(0, 2)).toEqual(["collector_path", "collector_path"]);
    expect(reasons[2]).toBe("eligible");
  });
});
