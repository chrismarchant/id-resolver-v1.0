/**
 * Wire allowlist of reporting-feed.v1 (docs/GUARDRAILS.md G6). The feed is
 * what leaves the resolver (B) for the private Insights project (C): every
 * key it may carry is listed here explicitly, per object, and nothing else is
 * accepted. Keys are compared as exact sets, so an extra key (an IP, a
 * fingerprint, an observation reference, eligibility, a header) and a missing
 * key are both violations. Changing a list is a contract change
 * (docs/contracts/reporting-feed.v1.md), never a test fix.
 */

export const FEED_ENVELOPE_KEYS = ["contract", "has_more", "items", "next_cursor", "scope", "version"] as const;
export const FEED_SCOPE_KEYS = ["installation_id", "website_id"] as const;
export const FEED_OBSERVATION_KEYS = [
  "acquisition",
  "company_id",
  "domain",
  "entrance_contract",
  "method",
  "observation_id",
  "observed_at",
  "organisation_name",
  "page_key",
  "type",
] as const;
export const FEED_TOMBSTONE_KEYS = ["company_id", "erased_at", "tombstone_id", "type"] as const;
/** 410 cursor_expired: no items, no scope. */
export const FEED_EXPIRED_KEYS = ["error", "version"] as const;

function keyDiff(where: string, obj: unknown, allowed: readonly string[]): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [`${where}: not an object`];
  const keys = Object.keys(obj);
  const out: string[] = [];
  for (const k of keys) if (!allowed.includes(k)) out.push(`${where}: unexpected key ${k}`);
  for (const k of allowed) if (!keys.includes(k)) out.push(`${where}: missing key ${k}`);
  return out;
}

/** Every violation of the wire allowlist in one 200 feed page, or a 410 body; [] = clean. */
export function feedWireViolations(body: unknown): string[] {
  if (body !== null && typeof body === "object" && "error" in body) return keyDiff("expired", body, FEED_EXPIRED_KEYS);
  const out = keyDiff("envelope", body, FEED_ENVELOPE_KEYS);
  if (out.some((v) => v.endsWith("not an object"))) return out;
  const b = body as Record<string, unknown>;
  out.push(...keyDiff("scope", b["scope"], FEED_SCOPE_KEYS));
  if (!Array.isArray(b["items"])) return [...out, "items: not an array"];
  b["items"].forEach((item, i) => {
    const type = item !== null && typeof item === "object" ? (item as Record<string, unknown>)["type"] : undefined;
    if (type === "observation") out.push(...keyDiff(`items[${i}] observation`, item, FEED_OBSERVATION_KEYS));
    else if (type === "company_erased") out.push(...keyDiff(`items[${i}] company_erased`, item, FEED_TOMBSTONE_KEYS));
    else out.push(`items[${i}]: unknown item type`);
  });
  return out;
}

/**
 * Relations and columns the feed query must never touch: the IP resolution
 * cache (fingerprint-keyed visitor data), any fingerprint or key-version
 * column, the caller's observation references and their deduplication table,
 * and the browser events (never associated with companies, owner decision D4).
 */
export const FEED_SQL_FORBIDDEN: ReadonlyArray<RegExp> = [
  /\bip_resolution_cache\b/i,
  /fingerprint/i,
  /\bkey_version\b/i,
  /observation_ref/i,
  /\bbrowser_events\b/i,
  /\beligibility\b/i,
  /\breservation_token\b/i,
];

/** The forbidden identifiers the SQL text references (comments included: they must not even be named). */
export function feedSqlViolations(sql: string): string[] {
  return FEED_SQL_FORBIDDEN.filter((re) => re.test(sql)).map(String);
}
