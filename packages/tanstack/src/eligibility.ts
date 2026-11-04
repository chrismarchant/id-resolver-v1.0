import { DEFAULT_COLLECTOR_PATH, isCollectorPath, resolveCollectorPath } from "./collector-path.js";
import { ELIGIBILITY_RULE_SET_ID } from "./types.js";

/** A path pattern: a RegExp, an exact path, or a prefix ending in `*` (e.g. `/admin/*`). */
export type PathPattern = string | RegExp;

export interface EligibilityRules {
  /** When set, only paths matching one of these are eligible. */
  includePaths?: readonly PathPattern[];
  /** Paths matching any of these are never eligible. */
  excludePaths?: readonly PathPattern[];
  /** Extra user-agent patterns treated as bots/monitors, added to the built-in set. */
  extraBotPatterns?: readonly RegExp[];
}

export type IneligibleReason =
  | "collector_path"
  | "method"
  | "bad_url"
  | "upgrade"
  | "server_fn"
  | "internal_path"
  | "asset"
  | "api_path"
  | "health_path"
  | "excluded_path"
  | "not_included_path"
  | "prefetch"
  | "fetch_dest"
  | "fetch_mode"
  | "accept"
  | "no_user_agent"
  | "bot_or_monitor";

export type EligibilityResult = { eligible: true; ruleSet: typeof ELIGIBILITY_RULE_SET_ID } | { eligible: false; reason: IneligibleReason };

const ASSET_EXTENSION = /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|txt|xml|json|webmanifest|pdf|zip|gz|mp4|webm|mp3|wav|ogg|wasm)$/i;
/** TanStack Start / Nitro / platform internals, matched on a path-segment boundary. */
const INTERNAL_PREFIXES = ["/_server", "/_build", "/_tsr", "/_nitro", "/_vercel", "/assets", "/.well-known", "/cdn-cgi"];
/** Internal names matched as a leading string (`/_serverFn/<id>`, `/__x`, `/sitemap-1.xml`, `/favicon.ico`, `/robots.txt`). */
const INTERNAL_LEADING = /^\/(?:__|_serverfn|sitemap|favicon|robots\.txt)/i;
const API_PREFIXES = ["/api"];
const HEALTH_PREFIXES = ["/health", "/healthz", "/healthcheck", "/ready", "/readyz", "/live", "/livez", "/ping", "/_health"];

// Substring matches (no word boundaries): "Googlebot", "GPTBot" and "ClaudeBot"
// embed the token mid-word. Extends the V0.1 expression with HTTP libraries,
// monitoring, SEO tools and preview fetchers. A match only skips the
// entrance report; the visitor still gets the normal page.
const BOT_UA =
  /(?:bot\b|bot\/|bot[;)\s]|crawl|spider|slurp|curl\/|wget|python-requests|python-urllib|aiohttp|httpx|httpclient|http-client|go-http-client|okhttp|libwww|node-fetch|undici|axios|java\/|apache-httpclient|postman|insomnia|scrapy|phantomjs|puppeteer|playwright|monitor|uptime|pingdom|statuscake|site24x7|nagios|zabbix|prometheus|datadog|newrelic|healthcheck|health-check|headless|lighthouse|pagespeed|gtmetrix|webpagetest|facebookexternalhit|prerender|googlebot|googleother|google-inspectiontool|bingbot|bingpreview|adsbot|mediapartners|feedfetcher|facebot|meta-externalagent|gptbot|claudebot|anthropic-ai|chatgpt-user|oai-searchbot|perplexitybot|cohere-ai|youbot|diffbot|duckduckbot|applebot|yandex|baiduspider|bytespider|petalbot|ccbot|amazonbot|ia_archiver|archive\.org|semrush|ahrefs|mj12bot|dotbot|dataforseo|seokicks|serpstat|screaming frog|linkedinbot|twitterbot|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|cloudflare-)/i;

function prefixMatch(path: string, prefixes: readonly string[]): boolean {
  const p = path.toLowerCase();
  return prefixes.some((x) => p === x || p.startsWith(x + "/"));
}

function matchesPattern(path: string, pattern: PathPattern): boolean {
  if (typeof pattern === "string") {
    return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
  }
  pattern.lastIndex = 0;
  return pattern.test(path);
}

function pathOf(request: Request): string | null {
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

/**
 * Rule set `tsa-1`: decides whether a request is a human-style document
 * navigation worth reporting. Only request metadata is read; nothing is stored.
 * Fails closed (ineligible) on anything unexpected.
 *
 * `collectorPath` (default `/idr/e`, the documented collector route) is never
 * eligible, for any method (G5-D-F1). It is checked first, on its own, so it does
 * not depend on the method rule. An invalid `collectorPath` throws.
 */
export function isEligible(request: Request, rules: EligibilityRules = {}, collectorPath: string = DEFAULT_COLLECTOR_PATH): EligibilityResult {
  const no = (reason: IneligibleReason): EligibilityResult => ({ eligible: false, reason });
  const collectorKey = resolveCollectorPath(collectorPath);
  const path = pathOf(request);
  if (path !== null && isCollectorPath(path, collectorKey)) return no("collector_path");
  if (request.method !== "GET") return no("method");
  if (path === null) return no("bad_url");
  const h = request.headers;
  if (h.has("upgrade")) return no("upgrade");
  if (h.has("x-tsr-serverfn")) return no("server_fn");

  if (/^\/_server(?:fn)?(?:\/|$)/i.test(path)) return no("server_fn");
  if (prefixMatch(path, API_PREFIXES)) return no("api_path");
  if (prefixMatch(path, HEALTH_PREFIXES)) return no("health_path");
  if (prefixMatch(path, INTERNAL_PREFIXES) || INTERNAL_LEADING.test(path)) return no("internal_path");
  if (ASSET_EXTENSION.test(path)) return no("asset");
  if (rules.excludePaths?.some((p) => matchesPattern(path, p))) return no("excluded_path");
  if (rules.includePaths && rules.includePaths.length > 0 && !rules.includePaths.some((p) => matchesPattern(path, p))) return no("not_included_path");

  const purpose = (h.get("purpose") ?? "").toLowerCase();
  const secPurpose = (h.get("sec-purpose") ?? "").toLowerCase();
  const xPurpose = (h.get("x-purpose") ?? "").toLowerCase();
  const xMoz = (h.get("x-moz") ?? "").toLowerCase();
  if (/prefetch|prerender|preview/.test(purpose) || /prefetch|prerender/.test(secPurpose) || xPurpose === "preview" || /prefetch|prerender/.test(xPurpose) || /prefetch|prerender/.test(xMoz)) return no("prefetch");

  const dest = h.get("sec-fetch-dest");
  if (dest !== null && dest.trim().toLowerCase() !== "document") return no("fetch_dest");
  const mode = h.get("sec-fetch-mode");
  if (mode !== null && mode.trim().toLowerCase() !== "navigate") return no("fetch_mode");
  const accept = h.get("accept");
  if (accept !== null && !accept.toLowerCase().includes("text/html")) return no("accept");

  const ua = h.get("user-agent");
  if (ua === null || ua.trim() === "") return no("no_user_agent");
  if (BOT_UA.test(ua) || rules.extraBotPatterns?.some((re) => ((re.lastIndex = 0), re.test(ua)))) return no("bot_or_monitor");
  return { eligible: true, ruleSet: ELIGIBILITY_RULE_SET_ID };
}
