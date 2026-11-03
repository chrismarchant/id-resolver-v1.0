/**
 * `npm run ops:erase-company -- --domain <domain>`
 * `npm run ops:erase-company -- --company-id <id>`
 *
 * Erases one company atomically (src/db/erasure.ts): its observations,
 * deduplication records, scope stats, linked cache rows and the company row,
 * and writes a `company_erased` tombstone into every scope's reporting feed
 * (reporting-feed.v1) so the client Insights consumer removes it too.
 *
 * Re-observation: a later qualified resolution of the same domain creates a
 * NEW company id; add the domain to DENIED_DOMAINS first to prevent that.
 *
 * Output is one JSON line with the company id and counts. The domain is never
 * printed. Exit code 0 also when nothing matched (`erased: false`).
 */
import { pathToFileURL } from "node:url";
import { createDb } from "../db/index.js";
import { eraseCompany, type EraseTarget } from "../db/erasure.js";
import { failOps, loadOpsConfig } from "./env.js";

const USAGE = "usage: ops:erase-company -- --domain <domain> | --company-id <id>";

export function parseEraseArgs(argv: string[]): EraseTarget {
  const domainAt = argv.indexOf("--domain");
  const idAt = argv.indexOf("--company-id");
  if ((domainAt === -1) === (idAt === -1)) throw new Error(USAGE);
  const known = new Set(["--domain", "--company-id"]);
  if (argv.length !== 2 || !known.has(argv[0] ?? "")) throw new Error(USAGE);
  const value = argv[1];
  if (value === undefined || value.startsWith("--") || value.trim().length === 0) throw new Error(USAGE);
  if (domainAt !== -1) return { domain: value };
  if (!/^[1-9]\d{0,15}$/.test(value)) throw new Error("--company-id must be a positive integer");
  return { companyId: Number(value) };
}

async function main(): Promise<void> {
  try {
    const target = parseEraseArgs(process.argv.slice(2));
    const cfg = loadOpsConfig();
    const db = createDb({ databaseUrl: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, max: 1 });
    try {
      const r = await eraseCompany(db.pool, target);
      console.log(
        JSON.stringify({
          erased: r.erased,
          company_id: r.companyId,
          tombstones: r.tombstones,
          observations_deleted: r.observations,
          refs_deleted: r.refs,
          stats_deleted: r.stats,
          cache_rows_deleted: r.cacheRows,
        }),
      );
    } finally {
      await db.close();
    }
  } catch (err) {
    failOps("ops:erase-company", err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
