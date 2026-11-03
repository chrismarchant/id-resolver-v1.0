/**
 * Browser event persistence, contract event.v1 (Gate 4, CHR-64; owner
 * decision D4). Every statement here reads or writes `browser_events` and
 * nothing else: never the fingerprint cache, the company, observation or
 * activity tables, or the feed. test/integration/events-isolation.test.ts
 * proves it with a statement-level spy and a role granted this table only.
 *
 * Idempotency: one row per (installation_id, website_id, event_id). The
 * insert is a single INSERT ... ON CONFLICT DO NOTHING, so concurrent repeats
 * of one event_id store it once; exactly one caller sees `true`.
 *
 * Retention: bounded batches, oldest first by the resolver's own received_at
 * clock, skipping rows a concurrent writer holds locked. The table has no
 * trigger, so a batch never moves the feed's retention watermark or writes a
 * tombstone.
 */
import type { BrowserEventRecord, EventRepository } from "../contracts/event.js";
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

export const MAX_EVENT_PRUNE_BATCH = 100_000;

/** $1 installation, $2 website, $3 event_id, $4 type, $5 name, $6 page_key, $7 consent, $8 occurred_at. origin and received_at take their defaults. */
export const INSERT_BROWSER_EVENT_SQL = `
INSERT INTO browser_events (installation_id, website_id, event_id, type, name, page_key, consent, occurred_at)
VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz)
ON CONFLICT (installation_id, website_id, event_id) DO NOTHING
RETURNING 1`;

/** $1 cutoff, $2 batch size. */
export const PRUNE_BROWSER_EVENTS_SQL = `
DELETE FROM browser_events
WHERE ctid IN (
  SELECT ctid FROM browser_events
  WHERE received_at < $1::timestamptz
  ORDER BY received_at ASC, id ASC
  LIMIT $2::integer
  FOR UPDATE SKIP LOCKED)
RETURNING 1`;

export function createEventRepository(pool: Pick<Pool, "query">, logger?: Logger): EventRepository {
  return {
    async record(e: BrowserEventRecord): Promise<boolean> {
      return guarded(logger, async () => {
        const res = await pool.query(INSERT_BROWSER_EVENT_SQL, [e.installationId, e.websiteId, e.eventId, e.type, e.name, e.pageKey, e.consent, e.occurredAt]);
        return (res.rowCount ?? 0) === 1;
      });
    },
    async pruneBefore(cutoff: Date, limit: number): Promise<number> {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new DbError("INVALID_CUTOFF");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PRUNE_BATCH) throw new DbError("INVALID_LIMIT");
      return guarded(logger, async () => {
        const res = await pool.query(PRUNE_BROWSER_EVENTS_SQL, [cutoff, limit]);
        return res.rowCount ?? 0;
      });
    },
  };
}
