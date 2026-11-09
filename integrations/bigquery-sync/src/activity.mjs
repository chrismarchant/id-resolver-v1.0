// Daily activity counts (reporting-activity.v1, GET /v1/reporting/activity):
// visits the website sent to the resolver, each visit's outcome, lookups and
// company visits per usage period. Counts only: no address, company or visitor.
import { FeedError } from "./feed.mjs";

export const ACTIVITY_PATH = "/v1/reporting/activity";
/** The resolver accepts at most 366 days per request (inclusive). */
export const ACTIVITY_WINDOW_DAYS = 366;

export const OUTCOMES = ["qualified", "no_match", "excluded", "unknown", "pending", "ineligible", "disabled", "uncertain", "unavailable"];
const COUNTS = ["visits_submitted", "cache_hits", "provider_lookups", "domains_found", "charged_lookups", "company_visits", "company_first_visits"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_MS = 86_400_000;

export const ACTIVITY_SCHEMA = [
  { name: "period_start", type: "DATE", mode: "REQUIRED", description: "First day of the usage period (UTC)" },
  { name: "period", type: "STRING", mode: "REQUIRED", description: "day or month (the resolver's USAGE_PERIOD)" },
  { name: "visits_submitted", type: "INTEGER", mode: "REQUIRED", description: "Page entrances the website sent to the resolver" },
  ...OUTCOMES.map((o) => ({ name: `outcome_${o}`, type: "INTEGER", mode: "REQUIRED", description: `Entrances whose final status was ${o}` })),
  { name: "cache_hits", type: "INTEGER", mode: "REQUIRED", description: "Entrances answered from the cache, with no provider call" },
  { name: "provider_lookups", type: "INTEGER", mode: "REQUIRED", description: "Provider (Enrich) calls" },
  { name: "domains_found", type: "INTEGER", mode: "REQUIRED", description: "Provider calls that returned a domain (company or network owner)" },
  { name: "charged_lookups", type: "INTEGER", mode: "REQUIRED", description: "Provider calls holding a charge slot (charged or possibly charged)" },
  { name: "company_visits", type: "INTEGER", mode: "REQUIRED", description: "Company observations recorded" },
  { name: "company_first_visits", type: "INTEGER", mode: "REQUIRED", description: "Of those, the company's first observation" },
  { name: "company_returning_visits", type: "INTEGER", mode: "REQUIRED", description: "company_visits - company_first_visits" },
  { name: "synced_at", type: "TIMESTAMP", mode: "REQUIRED", description: "When this sync run wrote the row (UTC)" },
];

/** The request window: the last ACTIVITY_WINDOW_DAYS UTC days, ending today. */
export function activityWindow(now) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (ACTIVITY_WINDOW_DAYS - 1) * DAY_MS);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * Reads the activity for the window. Returns null when the resolver does not
 * serve the route yet (HTTP 404), so the visit sync can run on an older build.
 */
export async function readActivity(cfg, { fetch = globalThis.fetch, now = () => new Date(), timeoutMs = 15_000 } = {}) {
  const { from, to } = activityWindow(now());
  const url = new URL(`${cfg.reportingUrl}${ACTIVITY_PATH}`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new FeedError(`reporting activity request failed: ${e?.name ?? "error"}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new FeedError(`reporting activity answered HTTP ${res.status}`, res.status);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new FeedError("reporting activity returned invalid JSON");
  }
  return parseActivity(body, cfg.websiteId);
}

export function parseActivity(body, websiteId) {
  if (!isObject(body) || body.version !== "1") throw new FeedError("activity response has an unexpected version");
  if (!isObject(body.scope) || body.scope.website_id !== websiteId) throw new FeedError("activity response is for a different website");
  if (body.period !== "day" && body.period !== "month") throw new FeedError("activity response has an unknown period");
  if (!Array.isArray(body.items)) throw new FeedError("activity response has no items array");
  const keyRe = body.period === "day" ? DAY_RE : MONTH_RE;
  let previous = "";
  const items = body.items.map((item, index) => {
    if (!isObject(item) || typeof item.period_key !== "string" || !keyRe.test(item.period_key) || !isDate(item.period_key, body.period)) {
      throw new FeedError(`activity item ${index} has an invalid period_key`);
    }
    if (item.period_key <= previous) throw new FeedError(`activity item ${index} is out of order`);
    previous = item.period_key;
    if (!isObject(item.outcomes) || !OUTCOMES.every((o) => isCount(item.outcomes[o]))) throw new FeedError(`activity item ${index} has invalid outcomes`);
    if (!COUNTS.every((c) => isCount(item[c]))) throw new FeedError(`activity item ${index} has an invalid count`);
    return {
      period_key: item.period_key,
      outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, item.outcomes[o]])),
      ...Object.fromEntries(COUNTS.map((c) => [c, item[c]])),
    };
  });
  return { period: body.period, items };
}

/** One BigQuery row per usage period, in key order. */
export function toActivityRows(activity, syncedAt) {
  return activity.items.map((item) => ({
    period_start: activity.period === "day" ? item.period_key : `${item.period_key}-01`,
    period: activity.period,
    visits_submitted: item.visits_submitted,
    ...Object.fromEntries(OUTCOMES.map((o) => [`outcome_${o}`, item.outcomes[o]])),
    cache_hits: item.cache_hits,
    provider_lookups: item.provider_lookups,
    domains_found: item.domains_found,
    charged_lookups: item.charged_lookups,
    company_visits: item.company_visits,
    company_first_visits: item.company_first_visits,
    // Best-effort counters: never let a lost increment make this negative.
    company_returning_visits: Math.max(0, item.company_visits - item.company_first_visits),
    synced_at: syncedAt,
  }));
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isDate(key, period) {
  const day = period === "day" ? key : `${key}-01`;
  const t = Date.parse(`${day}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}
