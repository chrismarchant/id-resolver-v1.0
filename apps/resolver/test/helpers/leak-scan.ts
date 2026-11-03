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
