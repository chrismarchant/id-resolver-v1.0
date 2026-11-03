import type { EligibilityRules } from "./eligibility.js";
import { defaultPageKeyMapper, type PageKeyMapper } from "./payload.js";
import { validateTrustPolicy } from "./trust.js";
import type { TrustPolicy } from "./types.js";

/** Non-identifying outcome of one entrance report. It never contains an IP, token, URL, header or path. */
export interface DeliveryResult {
  /** `delivered`: resolver answered 200. `dropped`: attempted and lost (by design, never retried later). `skipped`: nothing was sent. */
  outcome: "delivered" | "dropped" | "skipped";
  /** Closed vocabulary, see README ("Delivery results"). */
  reason: string;
  /** How the work was scheduled relative to the page response. */
  mode: "wait_until" | "detached" | "blocking" | "none";
  attempts: number;
  httpStatus?: number;
  /** The resolver's `status` value on a 200 (non-identifying). */
  resolverStatus?: string;
  recorded?: boolean;
  durationMs: number;
}

export interface IdrOptions {
  /** Base URL of the resolver, e.g. `https://resolver.example.com`. `/v1/entrances` is appended. https required. */
  resolverUrl: string;
  /** Resolver bearer token (server-side secret, at least 32 characters). */
  token: string;
  /** Must equal the resolver's `WEBSITE_ID`. */
  websiteId: string;
  /** Required and explicit: see README "Choosing a trust policy". */
  trustPolicy: TrustPolicy;
  /** Per-attempt timeout. 250..10000, default 5000 (the resolver's own request deadline defaults to 4000). */
  timeoutMs?: number;
  /** One retry after `retryDelayMs`, only when a background context (`waitUntil`) is available. Default true. */
  retry?: boolean;
  /** 0..2000, default 250. */
  retryDelayMs?: number;
  /** Reports in flight at once per middleware instance; further entrances are dropped as `overload`. 1..500, default 50. */
  maxInFlight?: number;
  /**
   * What to do where no background context exists AND the runtime cannot be
   * assumed to outlive the response (Cloudflare Workers or another edge
   * isolate without `waitUntil`). `drop` (default) sends nothing; `await`
   * holds the response for at most `blockingBudgetMs`.
   */
  onUnsupportedBackground?: "drop" | "await";
  /** Only for `onUnsupportedBackground: "await"`. 50..1000, default 250: the maximum TTFB this package may add. */
  blockingBudgetMs?: number;
  eligibility?: EligibilityRules;
  /** Replaces the conservative default `page_key` mapper (identifier-like segments become `:email`, `:uuid`, `:n`, `:token`), e.g. `compileRouteTemplates(["/blog/:slug"])`. */
  pageKeyMapper?: PageKeyMapper;
  /** Host names of this site for the internal-navigation check. Default: the host of the request URL. */
  siteHosts?: readonly string[];
  /** Permit an http:// resolver URL. Local development only. */
  allowInsecureHttp?: boolean;
  /** Treat RFC 5737/3849 documentation IPs as public. Tests and local development only. */
  allowDocumentationRanges?: boolean;
  /** Receives non-identifying status for every handled request. Exceptions it throws are swallowed. */
  onDeliveryResult?: (result: DeliveryResult) => void | Promise<void>;
  /** Injectable fetch (tests). Default: global fetch. */
  fetch?: typeof fetch;
}

export interface ResolvedConfig {
  endpoint: string;
  token: string;
  websiteId: string;
  trustPolicy: TrustPolicy;
  timeoutMs: number;
  retry: boolean;
  retryDelayMs: number;
  maxInFlight: number;
  onUnsupportedBackground: "drop" | "await";
  blockingBudgetMs: number;
  eligibility: EligibilityRules;
  pageKeyMapper: PageKeyMapper;
  siteHosts: readonly string[] | undefined;
  allowDocumentationRanges: boolean;
  onDeliveryResult: ((result: DeliveryResult) => void | Promise<void>) | undefined;
  fetch: typeof fetch | undefined;
}

const WEBSITE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOKEN = /^[\x21-\x7e]{32,512}$/;

function intIn(name: string, v: number | undefined, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`idr-tanstack: ${name} must be an integer between ${min} and ${max}`);
  return v;
}

/**
 * Validates options and returns the resolved configuration. Error messages
 * never contain the token or the URL.
 */
export function resolveConfig(options: IdrOptions): ResolvedConfig {
  if (!options || typeof options !== "object") throw new Error("idr-tanstack: options are required");
  if (typeof options.token !== "string" || !TOKEN.test(options.token)) {
    throw new Error("idr-tanstack: token must be at least 32 printable characters without whitespace");
  }
  if (typeof options.websiteId !== "string" || !WEBSITE_ID.test(options.websiteId)) {
    throw new Error("idr-tanstack: websiteId must match ^[a-z0-9][a-z0-9-]{0,62}$");
  }
  let url: URL;
  try {
    url = new URL(String(options.resolverUrl));
  } catch {
    throw new Error("idr-tanstack: resolverUrl is not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowInsecureHttp === true)) {
    throw new Error("idr-tanstack: resolverUrl must use https (allowInsecureHttp permits http for local development only)");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("idr-tanstack: resolverUrl must not contain credentials, a query string or a fragment");
  }
  validateTrustPolicy(options.trustPolicy);
  const timeoutMs = intIn("timeoutMs", options.timeoutMs, 250, 10_000, 5_000);
  const blockingBudgetMs = intIn("blockingBudgetMs", options.blockingBudgetMs, 50, 1_000, 250);
  const onUnsupportedBackground = options.onUnsupportedBackground ?? "drop";
  if (onUnsupportedBackground !== "drop" && onUnsupportedBackground !== "await") throw new Error("idr-tanstack: onUnsupportedBackground must be drop or await");
  const base = url.pathname.replace(/\/+$/, "");
  return {
    endpoint: `${url.origin}${base}/v1/entrances`,
    token: options.token,
    websiteId: options.websiteId,
    trustPolicy: options.trustPolicy,
    timeoutMs,
    retry: options.retry !== false,
    retryDelayMs: intIn("retryDelayMs", options.retryDelayMs, 0, 2_000, 250),
    maxInFlight: intIn("maxInFlight", options.maxInFlight, 1, 500, 50),
    onUnsupportedBackground,
    blockingBudgetMs,
    eligibility: options.eligibility ?? {},
    pageKeyMapper: options.pageKeyMapper ?? defaultPageKeyMapper,
    siteHosts: options.siteHosts,
    allowDocumentationRanges: options.allowDocumentationRanges === true,
    onDeliveryResult: options.onDeliveryResult,
    fetch: options.fetch,
  };
}
