-- 0008: browser events, contract event.v1 (Gate 4, CHR-64; owner decision D4).
-- Forward-only and additive: 0001-0007 are unchanged, and no existing table,
-- trigger or feed object is touched.
--
-- One row per accepted browser event, written only by POST /v1/events
-- (src/api/events.ts through src/db/event-repo.ts). D4:
--   * Browser events are NEVER associated with companies. This table has no
--     company, network-address, fingerprint or observation column, and no
--     foreign key to or from any other table, so no join to company data is
--     possible through the schema.
--   * origin is always 'browser' (constraint below).
--   * The table is not part of reporting-feed.v1: it has no feed position
--     (txid) and no trigger, and pruning it never moves the feed's retention
--     watermark or writes a tombstone.
--
-- Vocabulary. type and name are checked here only for their shape (a short
-- lowercase token), so no free text, URL or value can ever be stored in them.
-- Membership of the closed vocabulary (docs/contracts/event-vocabulary.v1.json,
-- pending owner approval in CHR-59) is enforced by the resolver, from its one
-- embedded copy (src/contracts/event.ts), which a test keeps equal to the
-- canonical file. A CHECK listing the vocabulary would be a second copy that
-- could drift, and every vocabulary change would need a new forward-only
-- migration instead of a one-line edit.
--
-- Retention: rows older than OBSERVATION_RETENTION_DAYS, by the resolver's
-- own received_at clock (never the caller's occurred_at), are deleted by the
-- bounded maintenance drain (src/runtime/maintenance.ts).

CREATE TABLE IF NOT EXISTS browser_events (
  id               bigserial   PRIMARY KEY,
  installation_id  text        NOT NULL CHECK (installation_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  website_id       text        NOT NULL CHECK (website_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  -- Random per event, generated in the browser; the idempotency key per (installation, website).
  event_id         text        NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  type             text        NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]{0,31}$'),
  name             text        NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- Same rule as company_observations.page_key (0005): a normalised path only.
  page_key         text        NOT NULL
    CHECK (char_length(page_key) BETWEEN 1 AND 256 AND page_key ~ '^/[^?#[:space:][:cntrl:]]*$'),
  consent          text        NOT NULL CHECK (consent IN ('granted', 'not_required')),
  origin           text        NOT NULL DEFAULT 'browser' CHECK (origin = 'browser'),
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_events_event_unique UNIQUE (installation_id, website_id, event_id)
);

-- Retention: bounded batches delete the oldest rows first
-- (WHERE received_at < cutoff ORDER BY received_at, id LIMIT n).
CREATE INDEX IF NOT EXISTS browser_events_retention_idx
  ON browser_events (received_at, id);
