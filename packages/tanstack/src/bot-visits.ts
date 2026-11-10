import { isCollectorPath } from "./collector-path.js";
import { resolveDelivery, type ResolvedDelivery, type ResolverDeliveryOptions } from "./config.js";
import { deliverBotVisit } from "./delivery.js";
import { matchBot, type BotMatch } from "./known-bots.js";
import { formatOccurredAt, generateEntranceId, normalisePageKey } from "./payload.js";
import { fire, scheduleDelivery, skipped, type InFlight } from "./schedule.js";
import { BOT_VISIT_CONTRACT, type BotVisitPayload } from "./types.js";

/**
 * Options of `createBotVisitMiddleware`: the same resolver, delivery and `page_key` options as the entrance
 * middleware (pass the same values), without a trust policy (no IP is ever read) and without a blocking mode (a bot
 * visit never holds the page).
 */
export type BotVisitOptions = Omit<ResolverDeliveryOptions, "onUnsupportedBackground" | "blockingBudgetMs">;

export interface BotVisitMiddlewareArgs<R> {
  request: Request;
  next: (...args: never[]) => R | Promise<R>;
}

/** Framework internals, never a visit: server functions, build output and platform paths. */
const INTERNAL_PATH = /^\/(?:_server(?:fn)?|_build|_tsr|_nitro|_vercel|assets|cdn-cgi)(?:\/|$)/i;
/** Page resources (scripts, styles, images, fonts, media). Text discovery files such as robots.txt, sitemap.xml and llms.txt are kept. */
const RESOURCE_EXTENSION = /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|wasm|zip|gz|pdf)$/i;

function responseOf(result: unknown): Response | undefined {
  if (result instanceof Response) return result;
  const r = (result as { response?: unknown } | null | undefined)?.response;
  return r instanceof Response ? r : undefined;
}

/** A served visit: 2xx, or 304 (a crawler revalidating its copy). Redirects and errors are not recorded. Unknown shapes are. */
function isServed(result: unknown): boolean {
  const res = responseOf(result);
  if (!res) return true;
  return (res.status >= 200 && res.status <= 299) || res.status === 304;
}

type Skip = "method" | "bad_url" | "collector_path" | "internal_path" | "resource" | "not_served";

function skipReason(request: Request, path: string | null, collectorPath: string): Skip | null {
  if (path !== null && isCollectorPath(path, collectorPath)) return "collector_path";
  if (request.method !== "GET" && request.method !== "HEAD") return "method";
  if (path === null) return "bad_url";
  if (request.headers.has("x-tsr-serverfn") || INTERNAL_PATH.test(path)) return "internal_path";
  if (RESOURCE_EXTENSION.test(path)) return "resource";
  return null;
}

function pathOf(request: Request): string | null {
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

/**
 * Server request middleware for TanStack Start that records visits from known bots and crawlers for reporting.
 * Register it before the entrance middleware:
 *
 *   createStart(() => ({ requestMiddleware: [bots, idr] }))
 *
 * For every request it reads only the method, the URL path and the `User-Agent` header, and matches the user agent
 * against the bot list (`KNOWN_BOTS`, known-bots.ts). Anything that is not a known bot passes through with nothing
 * sent and nothing changed: the request, the next middleware (the entrance middleware included) and the response are
 * exactly as without this middleware.
 *
 * A known bot's GET or HEAD request that the site answers with 2xx or 304 is sent to the resolver as one
 * `bot-visit.v1` row: the time, the `page_key` (path only, mapped exactly like entrances), the bot's name and
 * category, and the one product token that identified it (`user_agent_family`). Never the IP, the full user agent,
 * cookies or any other header. Server functions, framework internals, page resources (scripts, styles, images, fonts)
 * and the collector route are not recorded; robots.txt, sitemaps and llms.txt are.
 *
 * Sending never slows the page: it is scheduled after `next()` returns, through `waitUntil` where one exists (one
 * retry), detached on long-lived Node processes, and dropped on an edge isolate with neither. More than `maxInFlight`
 * sends in flight are dropped. Errors never reach the page. `onDeliveryResult` hears about every bot request (never
 * about other requests) with the same non-identifying result shape as the entrance middleware.
 */
export function createBotVisitMiddleware(options: BotVisitOptions | (() => BotVisitOptions)) {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error("idr-tanstack: createBotVisitMiddleware must only run on the server");
  }
  const resolve = (o: BotVisitOptions): ResolvedDelivery => ({ ...resolveDelivery(o), onUnsupportedBackground: "drop" });
  let cfg: ResolvedDelivery | null = typeof options === "function" ? null : resolve(options);
  let lazyState: "pending" | "failed" = "pending";
  const inFlight: InFlight = { n: 0 };

  function config(): ResolvedDelivery | null {
    if (cfg) return cfg;
    if (lazyState === "failed" || typeof options !== "function") return null;
    let raw: BotVisitOptions | undefined;
    try {
      raw = options();
      cfg = resolve(raw);
      return cfg;
    } catch {
      lazyState = "failed";
      const hook = typeof raw?.onDeliveryResult === "function" ? raw.onDeliveryResult : undefined;
      void fire(hook, skipped("config_invalid", Date.now()));
      return null;
    }
  }

  async function record(request: Request, bot: BotMatch, result: unknown, started: number): Promise<void> {
    const c = config();
    if (!c) return;
    const path = pathOf(request);
    const skip = skipReason(request, path, c.collectorPath) ?? (isServed(result) ? null : "not_served");
    if (skip !== null || path === null) {
      void fire(c.onDeliveryResult, skipped(`bot:${skip ?? "bad_url"}`, started));
      return;
    }
    const payload: BotVisitPayload = {
      contract: BOT_VISIT_CONTRACT,
      website_id: c.websiteId,
      visit_id: generateEntranceId(),
      occurred_at: formatOccurredAt(new Date(started)),
      page_key: normalisePageKey(path, c.pageKeyMapper),
      bot_name: bot.botName,
      bot_category: bot.botCategory,
      user_agent_family: bot.userAgentFamily,
    };
    await scheduleDelivery(request, c, inFlight, started, (mode, allowRetry, timeoutMs) => deliverBotVisit(c, payload, { mode, allowRetry, timeoutMs }));
  }

  return async function botVisitMiddleware<R>(args: BotVisitMiddlewareArgs<R>): Promise<R> {
    let bot: BotMatch | null = null;
    const started = Date.now();
    try {
      bot = matchBot(args.request.headers.get("user-agent"));
    } catch {
      bot = null;
    }
    const result = await (args.next as () => R | Promise<R>)();
    if (bot !== null) {
      try {
        await record(args.request, bot, result, started);
      } catch {
        // Never throws into the page.
      }
    }
    return result;
  };
}
