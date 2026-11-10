// Bot and crawler visits (bot-visit.v1, GET /v1/reporting/bot-visits): one row
// per request from a known bot, with its time, page_key, bot name and category
// and one product token. No address, user agent, cookie or company.
//
// Daily: the step runs in the first job run after 00:15 UTC each day (the table
// has not been written since midnight UTC) and loads the last BQ_BOT_VISITS_DAYS
// complete UTC days, each into its own day partition with WRITE_TRUNCATE. A
// re-run replaces those days instead of adding duplicates, and days older than
// the window are kept, so the table holds the full history, not only the
// resolver's retention window.
import { DAILY_PAGE_SIZE, DAILY_SETTLE_MINUTES, completeDays, dailyDue, dayBounds, isObject, readDailyPages, rowsByDay } from "./daily.mjs";
import { FeedError } from "./feed.mjs";

export const BOT_VISITS_PATH = "/v1/reporting/bot-visits";
export const BOT_VISITS_PAGE_SIZE = DAILY_PAGE_SIZE;
export const BOT_VISITS_SETTLE_MINUTES = DAILY_SETTLE_MINUTES;

const CATEGORIES = new Set(["ai_crawler", "search_engine", "seo_tool", "social_preview", "monitoring", "other"]);
const BOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const FAMILY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const PAGE_KEY_RE = /^\/[^?#\s\u0000-\u001f\u007f]*$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const BOT_VISITS_SCHEMA = [
  { name: "observed_at", type: "TIMESTAMP", mode: "REQUIRED", description: "When the bot requested the page (UTC)" },
  { name: "page_key", type: "STRING", mode: "REQUIRED", description: "Page path only (no query string); identifiers replaced as for company visits" },
  { name: "bot_name", type: "STRING", mode: "REQUIRED", description: "Bot name from the website's bot list, e.g. GPTBot, Googlebot, Generic crawler" },
  { name: "bot_category", type: "STRING", mode: "REQUIRED", description: "ai_crawler, search_engine, seo_tool, social_preview, monitoring or other" },
  { name: "user_agent_family", type: "STRING", mode: "REQUIRED", description: "The product token that identified the bot, without its version" },
  { name: "synced_at", type: "TIMESTAMP", mode: "REQUIRED", description: "When this sync run wrote the row (UTC)" },
];

/** Whether today's daily load is due (see daily.mjs). */
export const botVisitsDue = dailyDue;
/** The last `days` complete UTC days before today, oldest first. */
export const botVisitDays = completeDays;

/**
 * Reads every visit observed on the given inclusive UTC days, following the
 * cursor. Returns null when the resolver does not serve the route (HTTP 404).
 */
export function readBotVisits(cfg, { from, to, fetch = globalThis.fetch, timeoutMs, maxPages } = {}) {
  return readDailyPages(cfg, {
    path: BOT_VISITS_PATH,
    label: "bot visits",
    parsePage: (body, range) => parseBotVisitsPage(body, cfg.websiteId, range).items,
    from,
    to,
    fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
  });
}

export function parseBotVisitsPage(body, websiteId, { from, to }) {
  if (!isObject(body) || body.version !== "1") throw new FeedError("bot visits response has an unexpected version");
  if (!isObject(body.scope) || body.scope.website_id !== websiteId) throw new FeedError("bot visits response is for a different website");
  if (!Array.isArray(body.items)) throw new FeedError("bot visits response has no items array");
  if (body.next_cursor !== null && (typeof body.next_cursor !== "string" || !CURSOR_RE.test(body.next_cursor))) throw new FeedError("bot visits response has an invalid next_cursor");
  const { lo, hi } = dayBounds({ from, to });
  const items = body.items.map((item, index) => {
    if (!isObject(item)) throw new FeedError(`bot visit ${index} is not an object`);
    const t = typeof item.observed_at === "string" ? Date.parse(item.observed_at) : Number.NaN;
    if (!Number.isFinite(t) || t < lo || t >= hi) throw new FeedError(`bot visit ${index} has an invalid observed_at`);
    if (typeof item.page_key !== "string" || item.page_key.length > 1024 || !PAGE_KEY_RE.test(item.page_key)) throw new FeedError(`bot visit ${index} has an invalid page_key`);
    if (typeof item.bot_name !== "string" || !BOT_NAME_RE.test(item.bot_name)) throw new FeedError(`bot visit ${index} has an invalid bot_name`);
    if (!CATEGORIES.has(item.bot_category)) throw new FeedError(`bot visit ${index} has an invalid bot_category`);
    if (typeof item.user_agent_family !== "string" || !FAMILY_RE.test(item.user_agent_family)) throw new FeedError(`bot visit ${index} has an invalid user_agent_family`);
    return {
      observed_at: new Date(t).toISOString(),
      page_key: item.page_key,
      bot_name: item.bot_name,
      bot_category: item.bot_category,
      user_agent_family: item.user_agent_family,
    };
  });
  return { items, nextCursor: body.next_cursor };
}

/** BigQuery rows grouped by UTC day (YYYY-MM-DD), in the order read. */
export function toBotVisitRowsByDay(items, syncedAt) {
  return rowsByDay(items, "observed_at", syncedAt);
}
