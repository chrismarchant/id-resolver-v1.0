/**
 * Leak scanning helpers for adversarial tests: assert that no forbidden
 * token (test IPs, secrets, provider-only fields) appears in logs, database
 * contents, HTTP responses or files written during a test.
 */
import type { Pool } from "pg";

export const FORBIDDEN_PROVIDER_FIELDS = ["ipRange", "ipIsp", "latitude", "longitude", "timezone", "ipUsageType", "city", "region"];

export async function dumpDatabaseText(pool: Pool): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  const parts: string[] = [];
  for (const { table_name } of tables.rows) {
    const rows = await pool.query(`SELECT to_jsonb(t) AS j FROM "${table_name}" t`);
    for (const r of rows.rows as Array<{ j: unknown }>) parts.push(JSON.stringify(r.j));
  }
  return parts.join("\n");
}

export function findLeaks(haystack: string, needles: string[]): string[] {
  return needles.filter((n) => n.length > 0 && haystack.includes(n));
}

/** Variants of an IPv4/IPv6 literal that a leak could take (plain, JSON-escaped, URL-encoded). */
export function ipVariants(ip: string): string[] {
  return [ip, encodeURIComponent(ip), JSON.stringify(ip).slice(1, -1), ip.replace(/\./g, "\\u002e")];
}

/** The complete key set of an entrance.v1 success body (owner decision D2). */
export const ENTRANCE_RESPONSE_KEYS = ["recorded", "source", "status", "version"] as const;
/** The complete key set of an error body. */
export const ERROR_RESPONSE_KEYS = ["error", "version"] as const;

/**
 * Markers of company data or request echo that must never appear in a
 * website-facing response (D2): company identity, the internal company id,
 * provider qualification, and the caller's own idempotency key or context.
 */
export const COMPANY_DATA_MARKERS = [
  "company",
  "domain",
  "organisation",
  "qualification",
  "resolved_at",
  "previously_seen",
  "observation_ref",
  "entrance_id",
  "page_key",
  "fingerprint",
];

/**
 * Problems with a raw /v1/entrances response body: any key outside the
 * contract's exact key set, any company-data marker, and any of `needles`
 * (test IPs and their variants, domains, organisation names, secrets).
 */
export function entranceResponseProblems(raw: string, needles: string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["body is not JSON"];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ["body is not an object"];
  const keys = Object.keys(parsed).sort();
  const expected: readonly string[] = "error" in parsed ? ERROR_RESPONSE_KEYS : ENTRANCE_RESPONSE_KEYS;
  const problems: string[] = [];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) problems.push(`unexpected keys: ${keys.join(",")}`);
  return [...problems, ...findLeaks(raw, [...needles, ...COMPANY_DATA_MARKERS])];
}
