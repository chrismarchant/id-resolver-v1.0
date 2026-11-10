/**
 * Bot visit persistence, contract bot-visit.v1. Every statement here reads or
 * writes `bot_visits` and nothing else: never the fingerprint cache, the
 * company, observation or activity tables, the feed or browser_events
 * (test/integration/bot-visits-api.test.ts checks the statements issued).
 *
 * Idempotency: one row per (installation_id, website_id, visit_id). The insert
 * is a single INSERT ... ON CONFLICT DO NOTHING, so a retried delivery is
 * stored once; exactly one caller sees `true`.
 *
 * Reading: one deployment scope, observed_at in [from, to), keyset-paginated
 * on (observed_at, id) through bot_visits_report_idx.
 *
 * Retention: bounded batches, oldest first by the resolver's own received_at
 * clock, skipping rows a concurrent writer holds locked. The table has no
 * trigger, so a batch never moves the feed's retention watermark.
 */
import type { BotCategory, BotVisitCursor, BotVisitRecord, BotVisitRepository, StoredBotVisit } from "../contracts/bot-visit.js";
import type { Logger } from "../log/index.js";
import { DbError, guarded, type Pool } from "./pool.js";

export const MAX_BOT_VISIT_PRUNE_BATCH = 100_000;
/** Rows per read: the reporting route asks for at most 1000 plus one look-ahead row. */
export const MAX_BOT_VISIT_PAGE = 1_001;

/** $1 installation, $2 website, $3 visit_id, $4 observed_at, $5 page_key, $6 bot_name, $7 bot_category, $8 user_agent_family. */
export const INSERT_BOT_VISIT_SQL = `
INSERT INTO bot_visits (installation_id, website_id, visit_id, observed_at, page_key, bot_name, bot_category, user_agent_family)
VALUES ($1::text, $2::text, $3::text, $4::timestamptz, $5::text, $6::text, $7::text, $8::text)
ON CONFLICT (installation_id, website_id, visit_id) DO NOTHING
RETURNING 1`;

const LIST_COLUMNS = "id, observed_at, page_key, bot_name, bot_category, user_agent_family";

/** $1 installation, $2 website, $3 from, $4 to, $5 limit. */
export const LIST_BOT_VISITS_SQL = `
SELECT ${LIST_COLUMNS} FROM bot_visits
WHERE installation_id = $1::text AND website_id = $2::text
  AND observed_at >= $3::timestamptz AND observed_at < $4::timestamptz
ORDER BY observed_at ASC, id ASC
LIMIT $5::integer`;

/** $1 installation, $2 website, $3 from, $4 to, $5 limit, $6 cursor observed_at, $7 cursor id. */
export const LIST_BOT_VISITS_AFTER_SQL = `
SELECT ${LIST_COLUMNS} FROM bot_visits
WHERE installation_id = $1::text AND website_id = $2::text
  AND observed_at >= $3::timestamptz AND observed_at < $4::timestamptz
  AND (observed_at, id) > ($6::timestamptz, $7::bigint)
ORDER BY observed_at ASC, id ASC
LIMIT $5::integer`;

/** $1 cutoff, $2 batch size. */
export const PRUNE_BOT_VISITS_SQL = `
DELETE FROM bot_visits
WHERE ctid IN (
  SELECT ctid FROM bot_visits
  WHERE received_at < $1::timestamptz
  ORDER BY received_at ASC, id ASC
  LIMIT $2::integer
  FOR UPDATE SKIP LOCKED)
RETURNING 1`;

interface BotVisitRow {
  id: string | number;
  observed_at: Date;
  page_key: string;
  bot_name: string;
  bot_category: BotCategory;
  user_agent_family: string;
}

const validDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

export function createBotVisitRepository(pool: Pick<Pool, "query">, logger?: Logger): BotVisitRepository {
  return {
    async record(v: BotVisitRecord): Promise<boolean> {
      return guarded(logger, async () => {
        const res = await pool.query(INSERT_BOT_VISIT_SQL, [v.installationId, v.websiteId, v.visitId, v.observedAt, v.pageKey, v.botName, v.botCategory, v.userAgentFamily]);
        return (res.rowCount ?? 0) === 1;
      });
    },
    async list(scope, range, page): Promise<StoredBotVisit[]> {
      if (!validDate(range.from) || !validDate(range.to)) throw new DbError("INVALID_RANGE");
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MAX_BOT_VISIT_PAGE) throw new DbError("INVALID_LIMIT");
      const after: BotVisitCursor | undefined = page.after;
      if (after && (!validDate(after.observedAt) || !Number.isSafeInteger(after.id) || after.id < 0)) throw new DbError("INVALID_CURSOR");
      return guarded(logger, async () => {
        const base = [scope.installationId, scope.websiteId, range.from, range.to, page.limit];
        const res = after
          ? await pool.query<BotVisitRow>(LIST_BOT_VISITS_AFTER_SQL, [...base, after.observedAt, after.id])
          : await pool.query<BotVisitRow>(LIST_BOT_VISITS_SQL, base);
        return res.rows.map((r) => ({
          id: Number(r.id),
          observedAt: r.observed_at,
          pageKey: r.page_key,
          botName: r.bot_name,
          botCategory: r.bot_category,
          userAgentFamily: r.user_agent_family,
        }));
      });
    },
    async pruneBefore(cutoff: Date, limit: number): Promise<number> {
      if (!validDate(cutoff)) throw new DbError("INVALID_CUTOFF");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOT_VISIT_PRUNE_BATCH) throw new DbError("INVALID_LIMIT");
      return guarded(logger, async () => {
        const res = await pool.query(PRUNE_BOT_VISITS_SQL, [cutoff, limit]);
        return res.rowCount ?? 0;
      });
    },
  };
}
