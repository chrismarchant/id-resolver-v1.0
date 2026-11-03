-- 0006: reporting-feed.v1 (CHR-71): erasure tombstones, the retention
-- watermark and the database-enforced invariants the feed relies on.
--
-- Feed position. Every feed item is positioned by (txid, kind, id): txid is
-- the top-level transaction id of the writing transaction (xid8, never wraps),
-- kind is 0 for an observation and 1 for a tombstone, and id is the row's own
-- bigserial. The feed serves only items whose txid is below the xmin of the
-- reading statement's snapshot (src/db/reporting-repo.ts, FEED_SQL), so every
-- transaction that can still commit has a txid at or above any position a
-- consumer has been given. That argument needs txid to BE the inserting
-- transaction's id; the triggers below enforce it for every writer, whatever
-- the INSERT statement says.
--
-- Privacy: tombstones hold only the scope, the erased company id and a
-- timestamp. The erased domain and organisation name are never copied here.

-- ---------------------------------------------------------------------------
-- Tombstones: one row per (scope, erased company), written by the erasure
-- transaction (src/db/erasure.ts). There is deliberately no foreign key: the
-- company row is deleted in the same transaction. Tombstones are never pruned
-- by retention, so a consumer resynchronising from the start of the buffer
-- still learns of every erasure.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_tombstones (
  id               bigserial   PRIMARY KEY,
  installation_id  text        NOT NULL,
  website_id       text        NOT NULL,
  company_id       bigint      NOT NULL CHECK (company_id > 0),
  erased_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid             xid8        NOT NULL DEFAULT pg_current_xact_id()
);

CREATE INDEX IF NOT EXISTS feed_tombstones_feed_idx
  ON feed_tombstones (installation_id, website_id, txid, id);

-- ---------------------------------------------------------------------------
-- Retention watermark, per scope: the highest feed position (always an
-- observation, kind 0) that has been deleted other than by an erasure. Any
-- item at or below it may be gone; nothing above it has ever been deleted by
-- retention. A consumer cursor strictly below it receives 410 cursor_expired.
-- Monotonic: it only ever moves forward.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_retention_watermarks (
  installation_id      text        NOT NULL,
  website_id           text        NOT NULL,
  pruned_through_txid  xid8        NOT NULL,
  pruned_through_id    bigint      NOT NULL,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (installation_id, website_id)
);

-- ---------------------------------------------------------------------------
-- Invariant 1: txid is the inserting transaction's top-level id and a row
-- never moves. pg_current_xact_id() returns the top-level id even inside a
-- subtransaction (SAVEPOINT), which is the id that appears in snapshots.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION feed_enforce_position() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.txid := pg_current_xact_id();
    RETURN NEW;
  END IF;
  IF NEW.txid IS DISTINCT FROM OLD.txid OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
     OR NEW.website_id IS DISTINCT FROM OLD.website_id THEN
    RAISE EXCEPTION 'feed position and scope are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS company_observations_feed_position ON company_observations;
CREATE TRIGGER company_observations_feed_position
  BEFORE INSERT OR UPDATE ON company_observations
  FOR EACH ROW EXECUTE FUNCTION feed_enforce_position();

DROP TRIGGER IF EXISTS feed_tombstones_feed_position ON feed_tombstones;
CREATE TRIGGER feed_tombstones_feed_position
  BEFORE INSERT OR UPDATE ON feed_tombstones
  FOR EACH ROW EXECUTE FUNCTION feed_enforce_position();

-- ---------------------------------------------------------------------------
-- Invariant 2: no observation leaves the feed silently. Every DELETE of
-- company_observations (retention through src/db/retention.ts, the inherited
-- ActivityRepository.pruneObservationsBefore, an FK cascade from companies or
-- a manual operator statement) advances the scope's watermark to the highest
-- deleted position, in the same statement and therefore atomically with the
-- delete, UNLESS the deleting transaction itself wrote a tombstone for that
-- company in that scope (an erasure, which the consumer learns about from the
-- tombstone instead). TRUNCATE bypasses row deletes and is for tests only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION feed_record_observation_deletes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO feed_retention_watermarks AS w
    (installation_id, website_id, pruned_through_txid, pruned_through_id, updated_at)
  SELECT DISTINCT ON (d.installation_id, d.website_id)
         d.installation_id, d.website_id, d.txid, d.id, clock_timestamp()
  FROM feed_deleted_observations d
  WHERE NOT EXISTS (
    SELECT 1 FROM feed_tombstones t
    WHERE t.installation_id = d.installation_id AND t.website_id = d.website_id
      AND t.company_id = d.company_id AND t.txid = pg_current_xact_id())
  ORDER BY d.installation_id, d.website_id, d.txid DESC, d.id DESC
  ON CONFLICT (installation_id, website_id) DO UPDATE SET
    pruned_through_txid = EXCLUDED.pruned_through_txid,
    pruned_through_id = EXCLUDED.pruned_through_id,
    updated_at = EXCLUDED.updated_at
  WHERE (EXCLUDED.pruned_through_txid, EXCLUDED.pruned_through_id) > (w.pruned_through_txid, w.pruned_through_id);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS company_observations_feed_watermark ON company_observations;
CREATE TRIGGER company_observations_feed_watermark
  AFTER DELETE ON company_observations
  REFERENCING OLD TABLE AS feed_deleted_observations
  FOR EACH STATEMENT EXECUTE FUNCTION feed_record_observation_deletes();

-- Bounded retention batches (src/db/retention.ts and the inherited
-- ActivityRepository prune) take the oldest rows by (observed_at, id) across
-- every scope; without this index each batch would scan and sort the table.
CREATE INDEX IF NOT EXISTS company_observations_retention_idx
  ON company_observations (observed_at, id);
