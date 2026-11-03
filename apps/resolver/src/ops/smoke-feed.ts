/**
 * Reading the reporting feed (reporting-feed.v1, GET /v1/reporting/observations)
 * for the development smoke test (src/ops/smoke.ts): every page, with the
 * contract's exact page and item shape checked, and the raw page texts kept
 * in memory so a caller can prove that something (an address, an event
 * page_key or event_id) appears nowhere in the feed. Nothing is printed.
 */
import type { HttpAnswer } from "./smoke-http.js";
import { parse } from "./smoke-http.js";

/** The reporting-feed.v1 wire shape (src/contracts/reporting-feed.ts), exactly. */
export const FEED_PAGE_KEYS = ["contract", "has_more", "items", "next_cursor", "scope", "version"] as const;
export const FEED_SCOPE_KEYS = ["installation_id", "website_id"] as const;
export const FEED_OBSERVATION_KEYS = ["acquisition", "company_id", "domain", "entrance_contract", "method", "observation_id", "observed_at", "organisation_name", "page_key", "type"] as const;
export const FEED_TOMBSTONE_KEYS = ["company_id", "erased_at", "tombstone_id", "type"] as const;

const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys]);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The shape problems of one 200 page, as fixed codes (never a value): the
 * page keys, version/contract, scope keys, and each item's exact key set for
 * its type. An empty list means the page has exactly the contract's shape.
 */
export function feedPageShapeProblems(body: Record<string, unknown> | undefined): string[] {
  if (body === undefined) return ["page_not_json_object"];
  const problems: string[] = [];
  if (!sameKeys(body, FEED_PAGE_KEYS)) problems.push("page_keys");
  if (body["version"] !== "1") problems.push("version");
  if (body["contract"] !== "reporting-feed.v1") problems.push("contract");
  if (!isObject(body["scope"]) || !sameKeys(body["scope"], FEED_SCOPE_KEYS)) problems.push("scope_keys");
  if (typeof body["next_cursor"] !== "string") problems.push("next_cursor");
  if (typeof body["has_more"] !== "boolean") problems.push("has_more");
  if (!Array.isArray(body["items"])) {
    problems.push("items");
    return problems;
  }
  for (const it of body["items"] as unknown[]) {
    if (!isObject(it)) problems.push("item_not_object");
    else if (it["type"] === "observation") {
      if (!sameKeys(it, FEED_OBSERVATION_KEYS)) problems.push("observation_keys");
    } else if (it["type"] === "company_erased") {
      if (!sameKeys(it, FEED_TOMBSTONE_KEYS)) problems.push("tombstone_keys");
    } else problems.push("item_type");
  }
  return [...new Set(problems)];
}

export interface FeedRead {
  /** Every page answered 200. */
  ok: boolean;
  /** Status of the first non-200 page, or 200. */
  status: number;
  pages: number;
  items: Record<string, unknown>[];
  /** Distinct shape problem codes over all pages (empty = exact contract shape). */
  shapeProblems: string[];
  /** True when any `needle` occurs anywhere in any page's raw text. */
  includes(needle: string): boolean;
}

/** Pages through the whole feed from the start (at most `maxPages` pages of `limit` items). */
export async function readFeed(get: (query: string) => Promise<HttpAnswer>, opts: { maxPages?: number; limit?: number } = {}): Promise<FeedRead> {
  const maxPages = opts.maxPages ?? 50;
  const limit = opts.limit ?? 500;
  const texts: string[] = [];
  const items: Record<string, unknown>[] = [];
  const problems = new Set<string>();
  let ok = true;
  let status = 200;
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await get(after ? `?after=${encodeURIComponent(after)}&limit=${limit}` : `?limit=${limit}`);
    if (r.status !== 200) {
      ok = false;
      status = r.status;
      break;
    }
    texts.push(r.text);
    const body = parse(r.text);
    for (const p of feedPageShapeProblems(body)) problems.add(p);
    const pageItems = Array.isArray(body?.["items"]) ? (body!["items"] as unknown[]) : [];
    for (const it of pageItems) if (isObject(it)) items.push(it);
    after = typeof body?.["next_cursor"] === "string" ? (body["next_cursor"] as string) : undefined;
    if (body?.["has_more"] !== true || after === undefined) break;
  }
  return { ok, status, pages: texts.length, items, shapeProblems: [...problems].sort(), includes: (needle: string) => texts.some((t) => t.includes(needle)) };
}
