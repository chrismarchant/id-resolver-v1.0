-- 0007: reporting-feed.v1 immutability guards (CHR-66 F5). Forward-only:
-- 0001-0006 are unchanged; this migration only adds trigger functions and
-- triggers.
--
-- The feed (src/db/reporting-repo.ts) serves an observation or a tombstone
-- once and a consumer applies it idempotently; it never re-reads it. So an
-- item that has been served must never change or disappear without a feed
-- event: the only legitimate ways out are a DELETE of observations (which
-- the 0006 statement trigger turns into a retention watermark, or which an
-- erasure announces with its tombstone). 0006 pinned the position (txid, id)
-- and the scope. The independent review found the remaining gaps:
--
--   1. company_observations: an UPDATE could move a served observation to
--      another company or rewrite its context, with no feed event. Every
--      served column is now immutable. (Together with 0006 that is every
--      column; an observation can only be inserted or deleted.)
--   2. feed_tombstones: a DELETE silently un-announced an erasure. Tombstones
--      are now append-only: UPDATE and DELETE are rejected.
--   3. TRUNCATE fires no row or DELETE trigger, so it bypassed the watermark.
--      TRUNCATE of company_observations or feed_tombstones is rejected.
--   4. feed_retention_watermarks: deleting the watermark (or moving it back)
--      would let a consumer behind pruned data continue silently instead of
--      receiving 410. It can now only move forward, and cannot be deleted or
--      truncated.
--
-- Unaffected: inserts; retention batches, the inherited activity prune,
-- FK cascades and manual DELETEs of observations (each still advances the
-- watermark); erasure (src/db/erasure.ts inserts tombstones and deletes
-- observations, never updates either).
--
-- Out-of-band bypass, by design of PostgreSQL: a session with
-- `session_replication_role = replica` fires none of these triggers (nor the
-- 0006 ones). Setting it needs superuser (or an explicit GRANT SET on the
-- parameter), and ALTER TABLE ... DISABLE TRIGGER needs table ownership; the
-- service never does either. It is reserved for test resets
-- (test/helpers/db.ts resetTestDb) and documented break-glass maintenance;
-- any such use against a live deployment must be followed by a full
-- resynchronisation of every feed consumer.

-- Rejects the operation outright (statement-level TRUNCATE, row-level
-- UPDATE/DELETE of append-only tables).
CREATE OR REPLACE FUNCTION feed_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: served feed items are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------
-- 1. company_observations: served columns are immutable. The 0006 trigger
--    (company_observations_feed_position) still guards txid, id and scope.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION feed_observation_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.page_key IS DISTINCT FROM OLD.page_key
     OR NEW.acquisition IS DISTINCT FROM OLD.acquisition
     OR NEW.entrance_contract IS DISTINCT FROM OLD.entrance_contract
     OR NEW.eligibility IS DISTINCT FROM OLD.eligibility
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.observation_ref IS DISTINCT FROM OLD.observation_ref THEN
    RAISE EXCEPTION 'served observation columns are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS company_observations_feed_immutable ON company_observations;
CREATE TRIGGER company_observations_feed_immutable
  BEFORE UPDATE ON company_observations
  FOR EACH ROW EXECUTE FUNCTION feed_observation_immutable();

-- ---------------------------------------------------------------------------
-- 2. feed_tombstones: append-only.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS feed_tombstones_append_only ON feed_tombstones;
CREATE TRIGGER feed_tombstones_append_only
  BEFORE UPDATE OR DELETE ON feed_tombstones
  FOR EACH ROW EXECUTE FUNCTION feed_reject_mutation();

-- ---------------------------------------------------------------------------
-- 3. No TRUNCATE of feed items (statement level; TRUNCATE has no row triggers).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS company_observations_no_truncate ON company_observations;
CREATE TRIGGER company_observations_no_truncate
  BEFORE TRUNCATE ON company_observations
  FOR EACH STATEMENT EXECUTE FUNCTION feed_reject_mutation();

DROP TRIGGER IF EXISTS feed_tombstones_no_truncate ON feed_tombstones;
CREATE TRIGGER feed_tombstones_no_truncate
  BEFORE TRUNCATE ON feed_tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION feed_reject_mutation();

-- ---------------------------------------------------------------------------
-- 4. The retention watermark only moves forward and is never removed. The
--    0006 trigger's upsert already only advances it; this makes that a rule
--    for every writer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION feed_watermark_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.installation_id IS DISTINCT FROM OLD.installation_id
     OR NEW.website_id IS DISTINCT FROM OLD.website_id
     OR (NEW.pruned_through_txid, NEW.pruned_through_id) < (OLD.pruned_through_txid, OLD.pruned_through_id) THEN
    RAISE EXCEPTION 'the retention watermark only moves forward' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS feed_retention_watermarks_forward_only ON feed_retention_watermarks;
CREATE TRIGGER feed_retention_watermarks_forward_only
  BEFORE UPDATE ON feed_retention_watermarks
  FOR EACH ROW EXECUTE FUNCTION feed_watermark_forward_only();

DROP TRIGGER IF EXISTS feed_retention_watermarks_no_delete ON feed_retention_watermarks;
CREATE TRIGGER feed_retention_watermarks_no_delete
  BEFORE DELETE ON feed_retention_watermarks
  FOR EACH ROW EXECUTE FUNCTION feed_reject_mutation();

DROP TRIGGER IF EXISTS feed_retention_watermarks_no_truncate ON feed_retention_watermarks;
CREATE TRIGGER feed_retention_watermarks_no_truncate
  BEFORE TRUNCATE ON feed_retention_watermarks
  FOR EACH STATEMENT EXECUTE FUNCTION feed_reject_mutation();
