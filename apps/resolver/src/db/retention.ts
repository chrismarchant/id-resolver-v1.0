/**
 * Observation retention as a bounded synchronisation buffer (owner decision
 * D3, reporting-feed.v1 "Retention").
 *
 * Each batch is ONE statement that deletes at most `limit` observations
 * observed before the cutoff, oldest first by (observed_at, id), skipping rows
 * a concurrent writer holds locked. The scope's pruned-through feed watermark
 * is advanced by the statement-level AFTER DELETE trigger installed by
 * migration 0006, which fires inside this same statement: the delete and the
 * watermark therefore commit together or not at all, and a feed reader's
 * snapshot sees both or neither. The trigger (not this module) is the single
 * mechanism, so every other deletion path (the inherited
 * ActivityRepository.pruneObservationsBefore, FK cascades, manual statements)
 * is covered too: no observation can leave the feed silently.
 *
 * Retention never writes a tombstone: it is not an erasure. Companies, scope
 * stats, deduplication records and tombstones are never pruned here.
 *
 * A consumer whose cursor lies strictly before the watermark receives 410
 * cursor_expired. Deleting by observed_at rather than by feed position is
 * safe: the watermark is the HIGHEST deleted position, so no item above it
 * was ever removed by retention, whatever order the batch took.
 */
import { FEED_KIND_OBSERVATION, type FeedPosition } from "../contracts/reporting-feed.js";
import type { ObservationScope } from "../contracts/db.js";
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

export const MAX_RETENTION_BATCH = 100_000;
const DAY_MS = 86_400_000;

/** $1 cutoff, $2 batch size. The watermark trigger fires at the end of this statement. */
export const PRUNE_FEED_OBSERVATIONS_SQL = `
DELETE FROM company_observations
WHERE ctid IN (
  SELECT ctid FROM company_observations
  WHERE observed_at < $1::timestamptz
  ORDER BY observed_at ASC, id ASC
  LIMIT $2::integer
  FOR UPDATE SKIP LOCKED)
RETURNING 1`;

const WATERMARK_SQL = `
SELECT pruned_through_txid::text AS txid, pruned_through_id::text AS id
FROM feed_retention_watermarks
WHERE installation_id = $1::text AND website_id = $2::text`;

export interface FeedRetention {
  /** One bounded batch: deletes at most `limit` observations observed before `cutoff`. Returns rows deleted. */
  pruneBefore(cutoff: Date, limit: number): Promise<number>;
  /** Repeats bounded batches until one deletes nothing or `maxBatches` ran. */
  pruneAllBefore(cutoff: Date, opts: { batch: number; maxBatches?: number }): Promise<{ deleted: number; batches: number }>;
  /** The scope's retention watermark (always an observation position), or null when nothing was ever pruned. */
  watermark(scope: ObservationScope): Promise<FeedPosition | null>;
}

/** Cutoff for a retention window of `days` whole days before `now`. */
export function retentionCutoff(now: Date, days: number): Date {
  if (!Number.isSafeInteger(days) || days < 1) throw new DbError("INVALID_RETENTION");
  return new Date(now.getTime() - days * DAY_MS);
}

function checkBatch(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETENTION_BATCH) throw new DbError("INVALID_LIMIT");
  return limit;
}

export function createFeedRetention(pool: Pool, logger?: Logger): FeedRetention {
  const pruneBefore = async (cutoff: Date, limit: number): Promise<number> => {
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new DbError("INVALID_CUTOFF");
    checkBatch(limit);
    return guarded(logger, async () => {
      const res = await pool.query(PRUNE_FEED_OBSERVATIONS_SQL, [cutoff, limit]);
      return res.rowCount ?? 0;
    });
  };
  return {
    pruneBefore,
    async pruneAllBefore(cutoff, opts) {
      const maxBatches = opts.maxBatches ?? Number.MAX_SAFE_INTEGER;
      let deleted = 0;
      let batches = 0;
      while (batches < maxBatches) {
        const n = await pruneBefore(cutoff, opts.batch);
        if (n === 0) break;
        deleted += n;
        batches += 1;
      }
      if (deleted > 0) logger?.info("observation_prune", { rows: deleted, count: batches });
      return { deleted, batches };
    },
    async watermark(scope) {
      return guarded(logger, async () => {
        const res = await pool.query<{ txid: string; id: string }>(WATERMARK_SQL, [scope.installationId, scope.websiteId]);
        const r = res.rows[0];
        return r ? { txid: BigInt(r.txid), kind: FEED_KIND_OBSERVATION, id: BigInt(r.id) } : null;
      });
    },
  };
}
