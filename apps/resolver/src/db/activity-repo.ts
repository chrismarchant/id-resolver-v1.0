/**
 * Durable company activity (implements ActivityRepository).
 *
 * recordObservation runs ONE short transaction, serialised per company by a
 * row lock on the companies row, so "previously observed" is decided against
 * committed state even under concurrent first observations, and the
 * deduplication record, the observation insert, the scope stats and the
 * registry timestamp move together or not at all.
 *
 * Idempotency is enforced by company_observation_refs, a minimal durable
 * record per accepted reference that outlives observation retention: a
 * repeated reference in its scope changes nothing and returns the answer the
 * original request received, whether or not its observation row still exists.
 *
 * Nothing in this module receives or stores an IP, a fingerprint, a provider
 * payload or a header.
 */
import type { ActivityRepository, RecordObservationInput, RecordObservationResult } from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

/** Serialises observers of one company; also proves the company exists. */
export const LOCK_COMPANY_SQL = `SELECT id FROM companies WHERE id = $1::bigint FOR UPDATE`;

/**
 * The deduplication record. previously_seen is decided here, under the lock,
 * against committed stats; the primary key rejects a repeated reference.
 */
export const INSERT_REF_SQL = `
INSERT INTO company_observation_refs (installation_id, website_id, observation_ref, company_id, observed_at, previously_seen)
SELECT $1::text, $2::text, $3::text, $4::bigint, $5::timestamptz,
       EXISTS (SELECT 1 FROM company_scope_stats
               WHERE installation_id = $1::text AND website_id = $2::text AND company_id = $4::bigint)
ON CONFLICT (installation_id, website_id, observation_ref) DO NOTHING
RETURNING previously_seen`;

export const INSERT_OBSERVATION_SQL = `
INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source)
VALUES ($1::text, $2::text, $3::bigint, $4::timestamptz, $5::text, $6::text)
RETURNING id`;

/**
 * Lifetime stats plus the identity of the earliest observation
 * (first_observation_ref): replaced only by a strictly earlier observed_at;
 * on an equal instant the earlier ACCEPTED observation keeps it (acceptance
 * is serialised per company by the row lock). Persisted here, so pruning the
 * observation rows never moves the identity to a survivor.
 */
export const UPSERT_STATS_SQL = `
INSERT INTO company_scope_stats (installation_id, website_id, company_id, first_observed_at, last_observed_at, observation_count, first_observation_ref)
VALUES ($1::text, $2::text, $3::bigint, $4::timestamptz, $4::timestamptz, 1, $5::text)
ON CONFLICT (installation_id, website_id, company_id) DO UPDATE SET
  first_observation_ref = CASE WHEN EXCLUDED.first_observed_at < company_scope_stats.first_observed_at
                               THEN EXCLUDED.first_observation_ref ELSE company_scope_stats.first_observation_ref END,
  first_observed_at = LEAST(company_scope_stats.first_observed_at, EXCLUDED.first_observed_at),
  last_observed_at = GREATEST(company_scope_stats.last_observed_at, EXCLUDED.last_observed_at),
  observation_count = company_scope_stats.observation_count + 1`;

/** Registry-level "accepted activity" timestamp. */
export const TOUCH_COMPANY_SQL = `
UPDATE companies SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz) WHERE id = $1::bigint`;

/** The surviving deduplication record for a repeated reference; the observation row may already be pruned. */
export const EXISTING_REF_SQL = `
SELECT r.company_id, r.previously_seen, o.id AS observation_id
FROM company_observation_refs r
LEFT JOIN company_observations o
  ON o.installation_id = r.installation_id AND o.website_id = r.website_id AND o.observation_ref = r.observation_ref
WHERE r.installation_id = $1::text AND r.website_id = $2::text AND r.observation_ref = $3::text`;

/** Bounded retention delete of observation rows only, oldest first (then lowest id); deduplication records and stats stay. Skips rows locked by writers. */
export const PRUNE_OBSERVATIONS_SQL = `
DELETE FROM company_observations
WHERE ctid IN (
  SELECT ctid FROM company_observations
  WHERE observed_at < $1::timestamptz
  ORDER BY observed_at ASC, id ASC
  LIMIT $2::integer
  FOR UPDATE SKIP LOCKED)
RETURNING 1`;

const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createActivityRepository(pool: Pool, logger?: Logger): ActivityRepository {
  return {
    async recordObservation(input: RecordObservationInput): Promise<RecordObservationResult> {
      if (!REF_PATTERN.test(input.observationRef)) throw new DbError("INVALID_REF");
      if (!Number.isSafeInteger(input.companyId) || input.companyId < 1) throw new DbError("INVALID_COMPANY");
      if (input.source !== "cache" && input.source !== "provider") throw new DbError("INVALID_SOURCE");
      const scopeParams = [input.scope.installationId, input.scope.websiteId];
      return guarded(logger, async () => {
        const client = await pool.connect();
        let failed = false;
        try {
          await client.query("BEGIN");
          try {
            const lock = await client.query(LOCK_COMPANY_SQL, [input.companyId]);
            if (lock.rowCount !== 1) throw new DbError("NO_COMPANY");
            const ref = await client.query<{ previously_seen: boolean }>(INSERT_REF_SQL, [
              ...scopeParams,
              input.observationRef,
              input.companyId,
              input.observedAt,
            ]);
            const accepted = ref.rows[0];
            if (!accepted) {
              // Reference already used in this scope (observation row present or pruned): nothing changes.
              await client.query("ROLLBACK");
              const existing = await client.query<{ company_id: string; previously_seen: boolean; observation_id: string | null }>(EXISTING_REF_SQL, [
                ...scopeParams,
                input.observationRef,
              ]);
              const e = existing.rows[0];
              if (!e) throw new DbError("REF_RACE");
              return {
                kind: "duplicate",
                observationId: e.observation_id === null ? null : Number(e.observation_id),
                previouslySeen: e.previously_seen,
                sameCompany: Number(e.company_id) === input.companyId,
              };
            }
            const ins = await client.query<{ id: string }>(INSERT_OBSERVATION_SQL, [
              ...scopeParams,
              input.companyId,
              input.observedAt,
              input.observationRef,
              input.source,
            ]);
            await client.query(UPSERT_STATS_SQL, [...scopeParams, input.companyId, input.observedAt, input.observationRef]);
            await client.query(TOUCH_COMPANY_SQL, [input.companyId, input.observedAt]);
            await client.query("COMMIT");
            return { kind: "recorded", observationId: Number(ins.rows[0]!.id), previouslySeen: accepted.previously_seen };
          } catch (err) {
            failed = true;
            await client.query("ROLLBACK").catch(() => undefined);
            throw err;
          }
        } finally {
          // A failed transaction (including a client-side query timeout) may
          // leave the connection mid-statement: discard it instead of reusing it.
          client.release(failed);
        }
      });
    },

    async pruneObservationsBefore(cutoff, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new DbError("INVALID_LIMIT");
      return guarded(logger, async () => {
        const res = await pool.query(PRUNE_OBSERVATIONS_SQL, [cutoff, limit]);
        return res.rowCount ?? 0;
      });
    },
  };
}
