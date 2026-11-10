// Shared daily load for append-only reporting tables (bot visits, browser
// events): once a day, the first run after DAILY_SETTLE_MINUTES past midnight
// UTC (when the table has not been written since midnight UTC) reads the last
// N complete UTC days from the resolver and replaces each of those day
// partitions with WRITE_TRUNCATE. Re-loading a day replaces it, so nothing is
// duplicated, and days older than the window are kept (full history in
// BigQuery, beyond the resolver's retention window).
import { FeedError } from "./feed.mjs";

/** A row may reach the resolver up to 5 minutes after it happened; wait this long after midnight UTC. */
export const DAILY_SETTLE_MINUTES = 15;
/** The resolver serves at most 1000 rows a page. */
export const DAILY_PAGE_SIZE = 1_000;
const DAY_MS = 86_400_000;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,128}$/;

const startOfUtcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Whether today's daily load is due: at least DAILY_SETTLE_MINUTES after
 * midnight UTC, and the table not written since midnight UTC.
 * Returns { due: true } or { due: false, reason }.
 */
export function dailyDue(now, lastModifiedMs) {
  const midnight = startOfUtcDay(now);
  if (now.getTime() < midnight + DAILY_SETTLE_MINUTES * 60_000) return { due: false, reason: "before_settle_time" };
  if (Number.isFinite(lastModifiedMs) && lastModifiedMs >= midnight) return { due: false, reason: "already_synced_today" };
  return { due: true };
}

/** The last `days` complete UTC days before today, oldest first, as YYYY-MM-DD. */
export function completeDays(now, days) {
  const today = startOfUtcDay(now);
  return Array.from({ length: days }, (_, i) => isoDay(today - (days - i) * DAY_MS));
}

/**
 * Reads every row of the given inclusive UTC days from a paged reporting route
 * ({version, scope, items, next_cursor}), following the cursor. `parsePage`
 * validates one page and returns its items. Returns null when the resolver does
 * not serve the route (HTTP 404 on the first page).
 */
export async function readDailyPages(cfg, { path, label, parsePage, from, to, fetch = globalThis.fetch, timeoutMs = 15_000, maxPages = 2_000 }) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${cfg.reportingUrl}${path}`);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("limit", String(DAILY_PAGE_SIZE));
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new FeedError(`reporting ${label} request failed: ${e?.name ?? "error"}`);
    }
    if (res.status === 404 && page === 0) return null;
    if (!res.ok) throw new FeedError(`reporting ${label} answered HTTP ${res.status}`, res.status);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new FeedError(`reporting ${label} returned invalid JSON`);
    }
    if (!isObject(body) || body.version !== "1") throw new FeedError(`${label} response has an unexpected version`);
    if (!isObject(body.scope) || body.scope.website_id !== cfg.websiteId) throw new FeedError(`${label} response is for a different website`);
    if (!Array.isArray(body.items)) throw new FeedError(`${label} response has no items array`);
    if (body.next_cursor !== null && (typeof body.next_cursor !== "string" || !CURSOR_RE.test(body.next_cursor))) throw new FeedError(`${label} response has an invalid next_cursor`);
    items.push(...parsePage(body, { from, to }));
    if (body.next_cursor === null) return items;
    cursor = body.next_cursor;
  }
  throw new FeedError(`reporting ${label} did not finish within ${maxPages} pages`);
}

/** The instant range [from 00:00Z, to + 1 day 00:00Z) of inclusive UTC days, in ms. */
export function dayBounds({ from, to }) {
  return { lo: Date.parse(`${from}T00:00:00.000Z`), hi: Date.parse(`${to}T00:00:00.000Z`) + DAY_MS };
}

/** BigQuery rows grouped by the UTC day of `timeKey` (YYYY-MM-DD), in the order read, each with synced_at. */
export function rowsByDay(items, timeKey, syncedAt) {
  const byDay = new Map();
  for (const item of items) {
    const day = item[timeKey].slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ ...item, synced_at: syncedAt });
  }
  return byDay;
}

export function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
