import { randomBytes } from "node:crypto";
import type {
  CacheKey,
  CacheRepository,
  CacheRow,
  CacheStatus,
  CommitOutcome,
  CommitResult,
  ReservationResult,
} from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

/**
 * One-statement reservation, decided entirely by the database clock. Exactly
 * one concurrent caller can win while a lease is live: the conflicting row is
 * locked, and after the lock wait the WHERE is re-evaluated against the
 * committed row with clock_timestamp() at that moment, so every other caller
 * gets no row back. A result row is taken over only once expires_at has
 * passed by database time; a pending row only once its lease has.
 *
 * $1..$4 key, $5 lease length in ms, $6 token.
 */
export const RESERVE_SQL = `
INSERT INTO ip_resolution_cache
  (installation_id, website_id, key_version, ip_fingerprint,
   status, checked_at, expires_at, lease_expires_at, reservation_token, attempts)
VALUES ($1::text, $2::text, $3::integer, $4::bytea,
        'pending', clock_timestamp(), clock_timestamp(),
        clock_timestamp() + make_interval(secs => $5::integer / 1000.0), $6::text, 1)
ON CONFLICT (installation_id, website_id, key_version, ip_fingerprint) DO UPDATE SET
  status = 'pending',
  company_id = NULL,
  qualification_category = NULL,
  checked_at = EXCLUDED.checked_at,
  expires_at = EXCLUDED.expires_at,
  lease_expires_at = EXCLUDED.lease_expires_at,
  reservation_token = EXCLUDED.reservation_token,
  attempts = ip_resolution_cache.attempts + 1
WHERE (ip_resolution_cache.status <> 'pending' AND ip_resolution_cache.expires_at <= clock_timestamp())
   OR (ip_resolution_cache.status = 'pending' AND ip_resolution_cache.lease_expires_at <= clock_timestamp())
RETURNING reservation_token, lease_expires_at,
          (EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000)::double precision AS lease_remaining_ms`;

/** Row inspection with the liveness decisions made by the database clock in the same statement. */
const INSPECT_SQL = `
SELECT c.status, c.expires_at, c.checked_at, c.lease_expires_at, c.qualification_category,
       co.id AS company_id, co.domain, co.organisation_name,
       (c.status <> 'pending' AND c.expires_at > clock_timestamp()) AS fresh,
       (c.status = 'pending' AND c.lease_expires_at > clock_timestamp()) AS lease_live,
       (EXTRACT(EPOCH FROM (c.lease_expires_at - clock_timestamp())) * 1000)::double precision AS lease_remaining_ms
FROM ip_resolution_cache c
LEFT JOIN companies co ON co.id = c.company_id
WHERE c.installation_id = $1 AND c.website_id = $2 AND c.key_version = $3 AND c.ip_fingerprint = $4`;

const READ_FRESH_SQL = `${INSPECT_SQL}
  AND c.status <> 'pending' AND c.expires_at > clock_timestamp()`;

/**
 * Fenced commit, one short transaction (src/db/cache-repo.ts commitResolved):
 *
 *   1. ownership pre-check: token matches and the lease is live by the
 *      DATABASE clock (clock_timestamp(), the actual time of evaluation);
 *      otherwise nothing is written at all;
 *   2. company upsert (may wait for the companies row lock);
 *   3. lock the cache row, then read clock_timestamp() in a separate
 *      statement, so the ownership check is made after every lock wait with
 *      the real time rather than a statement-start or worker timestamp;
 *   4. the fenced write, guarded again by token and clock_timestamp();
 *   5. COMMIT only when step 4 updated the row; any failed check rolls the
 *      whole transaction back, so a lost fence leaves companies untouched
 *      (no renamed row, no orphan) and the cache row as it was.
 *
 * checkedAt is result metadata (checked_at, expires_at, first/last_seen_at
 * of a new company); it never decides ownership. Lock order is companies
 * then the cache row; the reservation statement locks the cache row only and
 * the activity transaction locks the companies row only, so no cycle exists.
 * Both the lease expiry and every comparison with it come from the database
 * clock, so worker clock offset plays no part in ownership.
 */
export const OWNERSHIP_SQL = `
SELECT (reservation_token = $5::text AND lease_expires_at > clock_timestamp()) AS owned
FROM ip_resolution_cache
WHERE installation_id = $1 AND website_id = $2 AND key_version = $3 AND ip_fingerprint = $4`;

/** On conflict only the organisation name is refreshed: last_seen_at moves with accepted observations. */
export const UPSERT_COMPANY_SQL = `
INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at)
VALUES ($1::text, $2::text, $3::timestamptz, $3::timestamptz)
ON CONFLICT (domain) DO UPDATE SET
  organisation_name = COALESCE(EXCLUDED.organisation_name, companies.organisation_name)
RETURNING id`;

export const LOCK_CACHE_ROW_SQL = `
SELECT reservation_token, lease_expires_at FROM ip_resolution_cache
WHERE installation_id = $1 AND website_id = $2 AND key_version = $3 AND ip_fingerprint = $4
FOR UPDATE`;

export const DB_CLOCK_SQL = `SELECT clock_timestamp() AS now`;

/**
 * $1..$4 key, $5 token, $6 status, $7 company id, $8 qualification category,
 * $9 checkedAt (metadata), $10 ttl in ms (expires_at is database time + ttl).
 */
export const FENCED_WRITE_SQL = `
UPDATE ip_resolution_cache SET
  status = $6::text,
  company_id = $7::bigint,
  qualification_category = $8::text,
  checked_at = $9::timestamptz,
  expires_at = clock_timestamp() + make_interval(secs => $10::integer / 1000.0),
  lease_expires_at = NULL,
  reservation_token = NULL
WHERE installation_id = $1 AND website_id = $2 AND key_version = $3 AND ip_fingerprint = $4
  AND reservation_token = $5::text
  AND lease_expires_at > clock_timestamp()
RETURNING company_id`;

/**
 * Release: immediately expired (epoch, independent of clock skew between
 * processes), fenced on the token. $1..$4 key, $5 token.
 */
export const RELEASE_SQL = `
UPDATE ip_resolution_cache SET
  status = 'unknown',
  company_id = NULL,
  qualification_category = NULL,
  expires_at = 'epoch'::timestamptz,
  lease_expires_at = NULL,
  reservation_token = NULL
WHERE installation_id = $1 AND website_id = $2 AND key_version = $3 AND ip_fingerprint = $4
  AND reservation_token = $5::text`;

/** Bounded prune by database time; never removes a live pending lease; skips rows locked by writers. */
export const PRUNE_SQL = `
DELETE FROM ip_resolution_cache
WHERE ctid IN (
  SELECT ctid FROM ip_resolution_cache
  WHERE expires_at <= clock_timestamp()
    AND (status <> 'pending' OR lease_expires_at <= clock_timestamp())
  LIMIT $1::integer
  FOR UPDATE SKIP LOCKED)
RETURNING 1`;

interface InspectRow {
  status: CacheStatus;
  expires_at: Date;
  checked_at: Date;
  lease_expires_at: Date | null;
  qualification_category: string | null;
  company_id: string | null;
  domain: string | null;
  organisation_name: string | null;
  fresh: boolean;
  lease_live: boolean;
  lease_remaining_ms: number | null;
}

function keyParams(key: CacheKey): [string, string, number, Buffer] {
  return [key.installationId, key.websiteId, key.keyVersion, key.ipFingerprint];
}

function toCacheRow(r: InspectRow): CacheRow {
  return {
    status: r.status as CacheRow["status"],
    company:
      r.domain === null
        ? null
        : { domain: r.domain, organisationName: r.organisation_name, qualificationCategory: r.qualification_category ?? "" },
    companyId: r.company_id === null ? null : Number(r.company_id),
    checkedAt: r.checked_at,
    expiresAt: r.expires_at,
  };
}

export function createCacheRepository(pool: Pool, logger?: Logger): CacheRepository {
  async function reserveOnce(key: CacheKey, leaseMs: number): Promise<ReservationResult | null> {
    const token = randomBytes(32).toString("hex");
    const won = await pool.query<{ reservation_token: string; lease_expires_at: Date; lease_remaining_ms: number }>(RESERVE_SQL, [
      ...keyParams(key),
      leaseMs,
      token,
    ]);
    const first = won.rows[0];
    if (first && first.reservation_token === token) {
      return { kind: "acquired", token, leaseExpiresAt: first.lease_expires_at, leaseRemainingMs: Math.max(0, Math.floor(first.lease_remaining_ms)) };
    }
    const cur = await pool.query<InspectRow>(INSPECT_SQL, keyParams(key));
    const row = cur.rows[0];
    if (!row) return null; // pruned between statements
    if (row.status === "pending") {
      if (row.lease_live && row.lease_expires_at !== null) {
        return { kind: "pending", leaseExpiresAt: row.lease_expires_at, leaseRemainingMs: Math.max(0, Math.floor(row.lease_remaining_ms ?? 0)) };
      }
      return null; // lease expired between statements
    }
    if (row.fresh) return { kind: "fresh", row: toCacheRow(row) };
    return null; // expired between statements
  }

  return {
    async readFresh(key) {
      return guarded(logger, async () => {
        const res = await pool.query<InspectRow>(READ_FRESH_SQL, keyParams(key));
        const row = res.rows[0];
        return row ? toCacheRow(row) : null;
      });
    },

    async reserve(key, opts) {
      if (!Number.isSafeInteger(opts.leaseMs) || opts.leaseMs < 1) throw new DbError("INVALID_LEASE");
      return guarded(logger, async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await reserveOnce(key, opts.leaseMs);
          if (r) return r;
        }
        // Row kept changing under us; let the caller treat it as busy for one lease length.
        const clock = await pool.query<{ now: Date }>(DB_CLOCK_SQL);
        return { kind: "pending", leaseExpiresAt: new Date(clock.rows[0]!.now.getTime() + opts.leaseMs), leaseRemainingMs: opts.leaseMs } as const;
      });
    },

    async commitResolved(key, token, outcome: CommitOutcome): Promise<CommitResult> {
      if ((outcome.status as string) === "pending") throw new DbError("INVALID_STATUS");
      if (!Number.isSafeInteger(outcome.ttlMs) || outcome.ttlMs < 0) throw new DbError("INVALID_TTL");
      return guarded(logger, async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          try {
            const pre = await client.query<{ owned: boolean | null }>(OWNERSHIP_SQL, [...keyParams(key), token]);
            if (pre.rows[0]?.owned !== true) {
              await client.query("ROLLBACK");
              return { kind: "lost_lease" };
            }
            let companyId: number | null = null;
            if (outcome.company) {
              const up = await client.query<{ id: string }>(UPSERT_COMPANY_SQL, [
                outcome.company.domain,
                outcome.company.organisationName,
                outcome.checkedAt,
              ]);
              companyId = Number(up.rows[0]!.id);
            }
            const lock = await client.query<{ reservation_token: string | null; lease_expires_at: Date | null }>(LOCK_CACHE_ROW_SQL, keyParams(key));
            const clock = await client.query<{ now: Date }>(DB_CLOCK_SQL);
            const row = lock.rows[0];
            const dbNow = clock.rows[0]!.now.getTime();
            const owned = row !== undefined && row.reservation_token === token && row.lease_expires_at !== null && row.lease_expires_at.getTime() > dbNow;
            if (!owned) {
              await client.query("ROLLBACK");
              return { kind: "lost_lease" };
            }
            const res = await client.query<{ company_id: string | null }>(FENCED_WRITE_SQL, [
              ...keyParams(key),
              token,
              outcome.status,
              companyId,
              outcome.company?.qualificationCategory ?? null,
              outcome.checkedAt,
              outcome.ttlMs,
            ]);
            if (res.rowCount !== 1) {
              await client.query("ROLLBACK");
              return { kind: "lost_lease" };
            }
            await client.query("COMMIT");
            const id = res.rows[0]?.company_id ?? null;
            return { kind: "committed", companyId: id === null ? null : Number(id) };
          } catch (err) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw err;
          }
        } finally {
          client.release();
        }
      });
    },

    async commit(key, token, outcome: CommitOutcome) {
      const r = await this.commitResolved(key, token, outcome);
      return r.kind;
    },

    async release(key, token) {
      await guarded(logger, async () => {
        await pool.query(RELEASE_SQL, [...keyParams(key), token]);
      });
    },

    async pruneExpired(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new DbError("INVALID_LIMIT");
      return guarded(logger, async () => {
        const res = await pool.query(PRUNE_SQL, [limit]);
        return res.rowCount ?? 0;
      });
    },
  };
}
