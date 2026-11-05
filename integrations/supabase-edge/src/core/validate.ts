import type { FeedItem, FeedPage } from "./types.ts";

const DEC_ID = /^[0-9]{1,19}$/;

// str and optStr bound in UTF-16 code units. They are used only for fields the
// resolver restricts to ASCII (domain, method, timestamps, cursor, acquisition,
// entrance_contract), where code units and code points are the same count.
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function optStr(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && v.length <= max ? v : undefined;
}

/**
 * Length in Unicode code points, the unit the resolver bounds text in
 * (`Array.from(value).length`; PostgreSQL `char_length`), not UTF-16 code
 * units (`String.length`, which counts a character outside the Basic
 * Multilingual Plane, such as an emoji, twice).
 */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/** optStr with the bound in code points: for the fields the resolver itself bounds in code points. */
function optStrCodePoints(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && codePointLength(v) <= max ? v : undefined;
}

export const PAGE_KEY_MAX_CODE_POINTS = 256;
const PAGE_KEY_FORBIDDEN = /[?#\s\p{Cc}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The resolver's own page_key rule, exactly (apps/resolver/src/contracts/api.ts
 * isValidPageKey; the CHECK of its migration 0005): 1-256 code points, a
 * leading '/', no '?', '#', whitespace, control character or lone surrogate.
 * Every page_key the resolver stores and serves passes it.
 */
export function isResolverPageKey(value: string): boolean {
  if (!value.startsWith("/") || LONE_SURROGATE.test(value) || PAGE_KEY_FORBIDDEN.test(value)) return false;
  const length = codePointLength(value);
  return length >= 1 && length <= PAGE_KEY_MAX_CODE_POINTS;
}

/**
 * page_key of an observation (docs/GUARDRAILS.md G5): absent or null is null;
 * a string that passes the resolver's rule is kept; a string that fails it
 * (too long in code points, a query string, ...) is not a reason to reject
 * the page: it is replaced by null and counted, never forwarded, exactly as
 * idr_apply_feed_page treats it (which re-checks what reaches it). Anything
 * that is not a string is a contract violation (undefined).
 */
function pageKeyOf(v: unknown): { value: string | null; cleared: boolean } | undefined {
  if (v === null || v === undefined) return { value: null, cleared: false };
  if (typeof v !== "string") return undefined;
  return isResolverPageKey(v) ? { value: v, cleared: false } : { value: null, cleared: true };
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function validTimestamp(v: string): boolean {
  return !Number.isNaN(Date.parse(v));
}

/**
 * Validates one feed page against reporting-feed.v1 and projects it onto the
 * whitelisted fields. Unknown item types are dropped (forward compatibility);
 * unknown fields are never forwarded to the store.
 * Returns null when the page violates the contract.
 */
export function parseFeedPage(body: unknown, installationId: string): FeedPage | null {
  if (!isRecord(body)) return null;
  if (body["version"] !== "1" || body["contract"] !== "reporting-feed.v1") return null;
  const scope = body["scope"];
  if (!isRecord(scope) || scope["installation_id"] !== installationId) return null;
  const nextCursor = str(body["next_cursor"], 4096);
  if (nextCursor === null || typeof body["has_more"] !== "boolean") return null;
  const raw = body["items"];
  if (!Array.isArray(raw)) return null;

  const items: FeedItem[] = [];
  let pageKeysCleared = 0;
  for (const it of raw) {
    if (!isRecord(it)) return null;
    if (it["type"] === "observation") {
      const id = it["observation_id"];
      const company = it["company_id"];
      const domain = str(it["domain"], 253);
      const observedAt = str(it["observed_at"], 64);
      const method = str(it["method"], 32);
      // The resolver caps organisation_name in code points (200, resolution/qualify.ts); so does this bound.
      const orgName = optStrCodePoints(it["organisation_name"], 512);
      const pageKey = pageKeyOf(it["page_key"]);
      const acquisition = optStr(it["acquisition"], 32);
      const ec = optStr(it["entrance_contract"], 40);
      if (
        typeof id !== "string" || !DEC_ID.test(id) ||
        typeof company !== "number" || !Number.isSafeInteger(company) ||
        domain === null || observedAt === null || !validTimestamp(observedAt) || method === null ||
        orgName === undefined || pageKey === undefined || acquisition === undefined || ec === undefined
      ) return null;
      if (pageKey.cleared) pageKeysCleared++;
      items.push({
        type: "observation",
        observation_id: id,
        company_id: company,
        domain,
        organisation_name: orgName,
        observed_at: observedAt,
        method,
        page_key: pageKey.value,
        acquisition,
        entrance_contract: ec,
      });
    } else if (it["type"] === "company_erased") {
      const id = it["tombstone_id"];
      const company = it["company_id"];
      const erasedAt = str(it["erased_at"], 64);
      if (
        typeof id !== "string" || !DEC_ID.test(id) ||
        typeof company !== "number" || !Number.isSafeInteger(company) ||
        erasedAt === null || !validTimestamp(erasedAt)
      ) return null;
      items.push({ type: "company_erased", tombstone_id: id, company_id: company, erased_at: erasedAt });
    }
    // Unknown item types are ignored on purpose.
  }
  return { items, nextCursor, hasMore: body["has_more"], pageKeysCleared };
}

export interface SummaryCounts {
  observations: number;
  observedCompanies: number;
}

export function parseSummary(body: unknown, installationId: string): SummaryCounts | null {
  if (!isRecord(body) || body["version"] !== "1") return null;
  const scope = body["scope"];
  if (!isRecord(scope) || scope["installation_id"] !== installationId) return null;
  const o = body["observations"];
  const c = body["observed_companies"];
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) return null;
  if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) return null;
  return { observations: o, observedCompanies: c };
}
