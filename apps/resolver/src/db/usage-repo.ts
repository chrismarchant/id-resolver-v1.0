import {
  USAGE_COUNTERS,
  type ProviderAttemptReservation,
  type UsageCounter,
  type UsageRepository,
  type UsageScope,
  type UsageSnapshot,
} from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

/**
 * Atomic cap + kill-switch reservation. Both the INSERT path (first attempt of
 * a period) and the UPDATE path (ON CONFLICT) enforce the cap and the switch.
 * Under READ COMMITTED the conflicting row is locked and the WHERE is
 * re-evaluated against the latest committed value, so concurrent callers can
 * never exceed the cap. The increment is never rolled back.
 */
export const RESERVE_PROVIDER_ATTEMPT_SQL = `
INSERT INTO usage_periods (installation_id, website_id, period_key, provider_attempts, updated_at)
SELECT $1::text, $2::text, $3::text, 1, now()
WHERE $4::bigint > 0
  AND COALESCE((SELECT enrichment_enabled FROM deployment_controls WHERE installation_id = $1::text), true)
ON CONFLICT (installation_id, website_id, period_key) DO UPDATE SET
  provider_attempts = usage_periods.provider_attempts + 1,
  updated_at = now()
WHERE usage_periods.provider_attempts < $4::bigint
  AND COALESCE((SELECT enrichment_enabled FROM deployment_controls WHERE installation_id = $1::text), true)
RETURNING provider_attempts`;

export const ADD_CREDITS_SQL = `
INSERT INTO usage_periods (installation_id, website_id, period_key, provider_credits_reported, provider_credits_estimated, updated_at)
VALUES ($1::text, $2::text, $3::text, $4::bigint, $5::bigint, now())
ON CONFLICT (installation_id, website_id, period_key) DO UPDATE SET
  provider_credits_reported = usage_periods.provider_credits_reported + EXCLUDED.provider_credits_reported,
  provider_credits_estimated = usage_periods.provider_credits_estimated + EXCLUDED.provider_credits_estimated,
  updated_at = now()`;

/** `counter` is validated against USAGE_COUNTERS before being used as an identifier. */
export function incrementSql(counter: UsageCounter): string {
  if (!(USAGE_COUNTERS as readonly string[]).includes(counter)) throw new DbError("INVALID_COUNTER");
  return `
INSERT INTO usage_periods (installation_id, website_id, period_key, ${counter}, updated_at)
VALUES ($1::text, $2::text, $3::text, $4::bigint, now())
ON CONFLICT (installation_id, website_id, period_key) DO UPDATE SET
  ${counter} = usage_periods.${counter} + EXCLUDED.${counter},
  updated_at = now()`;
}

const SNAPSHOT_SQL = `
SELECT ${USAGE_COUNTERS.join(", ")}, provider_credits_reported, provider_credits_estimated
FROM usage_periods
WHERE installation_id = $1 AND website_id = $2 AND period_key = $3`;

function nonNegativeInt(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new DbError("INVALID_DELTA");
  return n;
}

export function createUsageRepository(pool: Pool, logger?: Logger): UsageRepository {
  return {
    async reserveProviderAttempt(scope: UsageScope, cap: number): Promise<ProviderAttemptReservation> {
      if (!Number.isSafeInteger(cap) || cap < 0) throw new DbError("INVALID_CAP");
      return guarded(logger, async () => {
        const params = [scope.installationId, scope.websiteId, scope.periodKey, cap];
        const res = await pool.query(RESERVE_PROVIDER_ATTEMPT_SQL, params);
        if ((res.rowCount ?? 0) > 0) return "reserved";
        const ctl = await pool.query<{ enrichment_enabled: boolean }>(
          "SELECT enrichment_enabled FROM deployment_controls WHERE installation_id = $1",
          [scope.installationId],
        );
        return ctl.rows[0]?.enrichment_enabled === false ? "disabled" : "cap_exhausted";
      });
    },

    async increment(scope, counter, delta = 1) {
      const sql = incrementSql(counter);
      const d = nonNegativeInt(delta);
      if (d === 0) return;
      await guarded(logger, async () => {
        await pool.query(sql, [scope.installationId, scope.websiteId, scope.periodKey, d]);
      });
    },

    async addProviderCredits(scope, credits) {
      const reported = nonNegativeInt(credits.reported ?? 0);
      const estimated = nonNegativeInt(credits.estimated ?? 0);
      if (reported === 0 && estimated === 0) return;
      await guarded(logger, async () => {
        await pool.query(ADD_CREDITS_SQL, [scope.installationId, scope.websiteId, scope.periodKey, reported, estimated]);
      });
    },

    async snapshot(scope): Promise<UsageSnapshot> {
      return guarded(logger, async () => {
        const res = await pool.query<Record<string, string>>(SNAPSHOT_SQL, [
          scope.installationId,
          scope.websiteId,
          scope.periodKey,
        ]);
        const row = res.rows[0];
        const num = (k: string): number => (row ? Number(row[k]) : 0);
        const snap = { periodKey: scope.periodKey } as UsageSnapshot;
        for (const c of USAGE_COUNTERS) snap[c] = num(c);
        snap.providerCreditsReported = num("provider_credits_reported");
        snap.providerCreditsEstimated = num("provider_credits_estimated");
        return snap;
      });
    },
  };
}
