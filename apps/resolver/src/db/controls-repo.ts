import type { ControlsRepository } from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { guarded, type Pool } from "./pool.js";

const MAX_REASON_CHARS = 500;

export const SET_CONTROL_SQL = `
INSERT INTO deployment_controls (installation_id, enrichment_enabled, reason, updated_at)
VALUES ($1::text, $2::boolean, $3::text, now())
ON CONFLICT (installation_id) DO UPDATE SET
  enrichment_enabled = EXCLUDED.enrichment_enabled,
  reason = EXCLUDED.reason,
  updated_at = EXCLUDED.updated_at`;

export function createControlsRepository(pool: Pool, logger?: Logger): ControlsRepository {
  return {
    async isEnrichmentEnabled(installationId) {
      return guarded(logger, async () => {
        const res = await pool.query<{ enrichment_enabled: boolean }>(
          "SELECT enrichment_enabled FROM deployment_controls WHERE installation_id = $1",
          [installationId],
        );
        // Absent row == enabled.
        return res.rows[0]?.enrichment_enabled ?? true;
      });
    },
    async setEnrichmentEnabled(installationId, enabled, reason) {
      await guarded(logger, async () => {
        await pool.query(SET_CONTROL_SQL, [installationId, enabled, reason.slice(0, MAX_REASON_CHARS)]);
      });
    },
  };
}
