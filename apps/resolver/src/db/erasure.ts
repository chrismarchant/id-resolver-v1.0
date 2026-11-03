/**
 * Company erasure (reporting-feed.v1 tombstones; `npm run ops:erase-company`).
 *
 * ONE transaction, explicitly READ COMMITTED:
 *
 *   1. lock the companies row FOR UPDATE. Every observation writer takes a
 *      lock on that row first (ActivityRepository.recordObservation locks it
 *      FOR UPDATE; any insert referencing it takes FOR KEY SHARE through the
 *      foreign key), so from here on no new observation, deduplication record
 *      or stats row of this company can be written, and the cache commit's
 *      company upsert waits too;
 *   2. write one tombstone per scope that knows the company (stats, refs or
 *      observations). Each tombstone carries this transaction's txid E (taken
 *      by the row lock in step 1), so it sorts after every observation of the
 *      company that a consumer can ever be served: an observation with
 *      txid < E sorts before it, and one with txid > E can be served only once
 *      the horizon passes E, i.e. after this transaction ended, by which time
 *      step 3 has deleted it (or, on abort, there is no tombstone);
 *   3. delete the observations, deduplication records and scope stats, then the
 *      cache rows linked to the company (the fingerprint-to-company link), then
 *      the company row itself. Each statement takes a fresh snapshot after the
 *      lock (READ COMMITTED), so rows committed before the lock are all seen;
 *      REPEATABLE READ would read a snapshot from before the lock wait and fail
 *      or miss rows. The watermark trigger (migration 0006) sees the tombstones
 *      of this transaction and does NOT treat these deletes as retention;
 *   4. COMMIT. Nothing identifying the company remains: not the domain, the
 *      name, any observation context, any cache row pointing at it.
 *
 * Re-observation after erasure: the companies row is gone, so the next
 * qualified resolution of the same domain creates a NEW company id (bigserial,
 * never reused). Its observations are ordinary feed items positioned by their
 * own transactions; they may sort before or after the tombstone (a writer that
 * obtained its txid before the erasure and waited on the lock sorts before).
 * The tombstone applies only to the erased company_id, so the consumer's
 * projection is the same either way. To prevent re-identification entirely,
 * add the domain to DENIED_DOMAINS before erasing.
 *
 * Nothing here logs or returns the domain.
 */
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

export type EraseTarget = { domain: string } | { companyId: number };

export interface EraseResult {
  /** False when no company matched (nothing changed, no tombstone written). */
  erased: boolean;
  companyId: number | null;
  tombstones: number;
  observations: number;
  refs: number;
  stats: number;
  cacheRows: number;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const LOCK_COMPANY_BY_DOMAIN_SQL = `SELECT id FROM companies WHERE domain = $1::text FOR UPDATE`;
export const LOCK_COMPANY_BY_ID_SQL = `SELECT id FROM companies WHERE id = $1::bigint FOR UPDATE`;

/** One tombstone per scope that knows the company, in a stable order. txid and erased_at are set by the database. */
export const INSERT_TOMBSTONES_SQL = `
INSERT INTO feed_tombstones (installation_id, website_id, company_id)
SELECT s.installation_id, s.website_id, $1::bigint
FROM (
  SELECT installation_id, website_id FROM company_scope_stats WHERE company_id = $1::bigint
  UNION
  SELECT installation_id, website_id FROM company_observation_refs WHERE company_id = $1::bigint
  UNION
  SELECT installation_id, website_id FROM company_observations WHERE company_id = $1::bigint
) s
ORDER BY s.installation_id, s.website_id
RETURNING id`;

export const DELETE_OBSERVATIONS_SQL = `DELETE FROM company_observations WHERE company_id = $1::bigint`;
export const DELETE_REFS_SQL = `DELETE FROM company_observation_refs WHERE company_id = $1::bigint`;
export const DELETE_STATS_SQL = `DELETE FROM company_scope_stats WHERE company_id = $1::bigint`;
export const DELETE_CACHE_ROWS_SQL = `DELETE FROM ip_resolution_cache WHERE company_id = $1::bigint`;
export const DELETE_COMPANY_SQL = `DELETE FROM companies WHERE id = $1::bigint`;

export const DEFAULT_ERASURE_STATEMENT_TIMEOUT_MS = 30_000;

function normaliseTarget(target: EraseTarget): { kind: "domain"; domain: string } | { kind: "id"; companyId: number } {
  if ("domain" in target) {
    const domain = typeof target.domain === "string" ? target.domain.trim().toLowerCase().replace(/\.$/, "") : "";
    if (!DOMAIN_PATTERN.test(domain)) throw new DbError("INVALID_DOMAIN");
    return { kind: "domain", domain };
  }
  if (!Number.isSafeInteger(target.companyId) || target.companyId < 1) throw new DbError("INVALID_COMPANY");
  return { kind: "id", companyId: target.companyId };
}

export async function eraseCompany(
  pool: Pool,
  target: EraseTarget,
  opts: { logger?: Logger; statementTimeoutMs?: number } = {},
): Promise<EraseResult> {
  const t = normaliseTarget(target);
  const timeoutMs = opts.statementTimeoutMs ?? DEFAULT_ERASURE_STATEMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) throw new DbError("INVALID_TIMEOUT");
  return guarded(opts.logger, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        // Bounds every statement (including the lock wait) of this transaction;
        // while it is open the feed is held back at its txid.
        await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
        const lock =
          t.kind === "domain"
            ? await client.query<{ id: string }>(LOCK_COMPANY_BY_DOMAIN_SQL, [t.domain])
            : await client.query<{ id: string }>(LOCK_COMPANY_BY_ID_SQL, [t.companyId]);
        const row = lock.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return { erased: false, companyId: null, tombstones: 0, observations: 0, refs: 0, stats: 0, cacheRows: 0 };
        }
        const companyId = Number(row.id);
        const tomb = await client.query(INSERT_TOMBSTONES_SQL, [companyId]);
        const obs = await client.query(DELETE_OBSERVATIONS_SQL, [companyId]);
        const refs = await client.query(DELETE_REFS_SQL, [companyId]);
        const stats = await client.query(DELETE_STATS_SQL, [companyId]);
        const cache = await client.query(DELETE_CACHE_ROWS_SQL, [companyId]);
        const company = await client.query(DELETE_COMPANY_SQL, [companyId]);
        if (company.rowCount !== 1) throw new DbError("ERASE_RACE");
        await client.query("COMMIT");
        return {
          erased: true,
          companyId,
          tombstones: tomb.rowCount ?? 0,
          observations: obs.rowCount ?? 0,
          refs: refs.rowCount ?? 0,
          stats: stats.rowCount ?? 0,
          cacheRows: cache.rowCount ?? 0,
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    } finally {
      client.release();
    }
  });
}
