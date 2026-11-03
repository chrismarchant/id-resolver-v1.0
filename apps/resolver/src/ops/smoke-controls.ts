/**
 * The smoke test's conditional access to the runtime kill switch
 * (deployment_controls, migration 0001), for src/ops/smoke-kill-switch.ts.
 *
 * The controls repository (src/db/controls-repo.ts) offers a boolean read
 * and an unconditional upsert, which is right for an operator command but
 * lets a smoke restore overwrite an engagement made by someone else during
 * the run (Gate 4 review G4-L3). These three parameterised statements stay in
 * the ops layer and touch the one row of this installation only:
 *   - READ: the switch and the reason stored with it;
 *   - ENGAGE_IF_RELEASED: engages only if the row is absent or released, in
 *     one statement (no read-then-write window);
 *   - RELEASE_IF_HELD: compare-and-set; releases only if the row is engaged
 *     with exactly the given reason (this smoke run's own).
 * Errors are reduced to a sanitised code (guarded): no statement text or
 * parameter value can reach the output.
 */
import { guarded, type Pool } from "../db/pool.js";
import type { KillSwitchControls, KillSwitchReading } from "./smoke-kill-switch.js";

/** $1 installation. */
export const READ_SWITCH_SQL = "SELECT enrichment_enabled, reason FROM deployment_controls WHERE installation_id = $1::text";

/** $1 installation, $2 reason. One row affected = this statement engaged the switch. */
export const ENGAGE_IF_RELEASED_SQL = `
INSERT INTO deployment_controls (installation_id, enrichment_enabled, reason, updated_at)
VALUES ($1::text, false, $2::text, now())
ON CONFLICT (installation_id) DO UPDATE SET
  enrichment_enabled = false,
  reason = EXCLUDED.reason,
  updated_at = EXCLUDED.updated_at
WHERE deployment_controls.enrichment_enabled = true`;

/** $1 installation, $2 the engage reason that must still be stored, $3 the restore reason. One row affected = released by this statement. */
export const RELEASE_IF_HELD_SQL = `
UPDATE deployment_controls
SET enrichment_enabled = true, reason = $3::text, updated_at = now()
WHERE installation_id = $1::text AND enrichment_enabled = false AND reason = $2::text`;

export function createSmokeKillSwitchControls(pool: Pick<Pool, "query">, installationId: string): KillSwitchControls {
  return {
    async read(): Promise<KillSwitchReading> {
      return guarded(undefined, async () => {
        const res = await pool.query<{ enrichment_enabled: boolean; reason: string | null }>(READ_SWITCH_SQL, [installationId]);
        const row = res.rows[0];
        // Absent row == enabled == released.
        if (!row) return { state: "released", reason: null };
        return { state: row.enrichment_enabled ? "released" : "engaged", reason: row.reason };
      });
    },
    async engageIfReleased(reason: string): Promise<boolean> {
      return guarded(undefined, async () => ((await pool.query(ENGAGE_IF_RELEASED_SQL, [installationId, reason])).rowCount ?? 0) === 1);
    },
    async releaseIfHeld(engageReason: string, restoreReason: string): Promise<boolean> {
      return guarded(undefined, async () => ((await pool.query(RELEASE_IF_HELD_SQL, [installationId, engageReason, restoreReason])).rowCount ?? 0) === 1);
    },
  };
}
