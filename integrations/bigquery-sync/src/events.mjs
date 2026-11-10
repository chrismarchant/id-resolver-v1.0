// Browser events (event.v1, GET /v1/reporting/events): consent-gated page
// events from the website's own collector (page views, scroll depth, engaged
// time, tagged clicks, form starts and submits). One row per event: its time,
// page_key, type, name and consent. No identifier of any kind (no session,
// visitor, cookie, address or company): owner decision D4. Loaded daily into
// day partitions, like bot visits (daily.mjs).
import { dayBounds, isObject, readDailyPages, rowsByDay } from "./daily.mjs";
import { FeedError } from "./feed.mjs";

export const EVENTS_PATH = "/v1/reporting/events";

const TYPES = new Set(["page_view", "engagement", "conversion_intent"]);
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const CONSENTS = new Set(["granted", "not_required"]);
const PAGE_KEY_RE = /^\/[^?#\s\u0000-\u001f\u007f]*$/;

export const EVENTS_SCHEMA = [
  { name: "occurred_at", type: "TIMESTAMP", mode: "REQUIRED", description: "When the event happened in the browser (UTC)" },
  { name: "page_key", type: "STRING", mode: "REQUIRED", description: "Page path only (no query string); identifiers replaced as for company visits" },
  { name: "event_type", type: "STRING", mode: "REQUIRED", description: "page_view, engagement or conversion_intent" },
  { name: "event_name", type: "STRING", mode: "REQUIRED", description: "e.g. page_view, scroll_50, scroll_90, engaged_30s, cta_click, form_start, form_submit" },
  { name: "consent", type: "STRING", mode: "REQUIRED", description: "granted (or not_required where the site's policy needs none)" },
  { name: "synced_at", type: "TIMESTAMP", mode: "REQUIRED", description: "When this sync run wrote the row (UTC)" },
];

/** Validates one page's items and keeps exactly the reporting columns, renamed for BigQuery. */
export function parseEventItems(items, { from, to }) {
  const { lo, hi } = dayBounds({ from, to });
  return items.map((item, index) => {
    if (!isObject(item)) throw new FeedError(`browser event ${index} is not an object`);
    const t = typeof item.occurred_at === "string" ? Date.parse(item.occurred_at) : Number.NaN;
    if (!Number.isFinite(t) || t < lo || t >= hi) throw new FeedError(`browser event ${index} has an invalid occurred_at`);
    if (typeof item.page_key !== "string" || item.page_key.length > 1024 || !PAGE_KEY_RE.test(item.page_key)) throw new FeedError(`browser event ${index} has an invalid page_key`);
    if (!TYPES.has(item.type)) throw new FeedError(`browser event ${index} has an invalid type`);
    if (typeof item.name !== "string" || !NAME_RE.test(item.name)) throw new FeedError(`browser event ${index} has an invalid name`);
    if (!CONSENTS.has(item.consent)) throw new FeedError(`browser event ${index} has an invalid consent`);
    return { occurred_at: new Date(t).toISOString(), page_key: item.page_key, event_type: item.type, event_name: item.name, consent: item.consent };
  });
}

/** Reads every event of the given inclusive UTC days. Returns null when the resolver does not serve the route (HTTP 404). */
export function readEvents(cfg, { from, to, fetch = globalThis.fetch } = {}) {
  return readDailyPages(cfg, { path: EVENTS_PATH, label: "browser events", parsePage: (body, range) => parseEventItems(body.items, range), from, to, fetch });
}

/** BigQuery rows grouped by UTC day of occurred_at, each with synced_at. */
export function toEventRowsByDay(items, syncedAt) {
  return rowsByDay(items, "occurred_at", syncedAt);
}
