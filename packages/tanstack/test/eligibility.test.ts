import { describe, expect, it } from "vitest";
import { isEligible, type EligibilityRules } from "../src/index.js";
import { BROWSER_HEADERS, req } from "./helpers.js";

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
