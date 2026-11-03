-- 0005: V1 observation context (entrance evidence) and the commit-safe feed column.
--
-- Shared contract migration written before the parallel implementation cells
-- start, so the resolver core (entrance writes) and the reporting feed (reads)
-- build on one schema. All columns are nullable or defaulted: V1 databases are
-- fresh, and the change is additive.
--
-- Privacy: page_key is a normalised path only (no query string or fragment),
-- and acquisition is a closed enum derived on the website server. Neither a
-- raw referrer nor a UTM value is ever stored. There is deliberately no
-- browser-origin column: V1 never associates browser events with companies
-- (owner decision D4).

ALTER TABLE company_observations
  ADD COLUMN IF NOT EXISTS page_key text NULL
    CHECK (page_key IS NULL OR (char_length(page_key) BETWEEN 1 AND 256 AND page_key ~ '^/[^?#[:space:][:cntrl:]]*$')),
  ADD COLUMN IF NOT EXISTS acquisition text NULL
    CHECK (acquisition IS NULL OR acquisition IN ('direct', 'search', 'social', 'email', 'paid', 'referral', 'internal', 'unknown')),
  ADD COLUMN IF NOT EXISTS entrance_contract text NULL
    CHECK (entrance_contract IS NULL OR entrance_contract ~ '^[a-z][a-z0-9-]{0,31}\.v[0-9]{1,3}$'),
  ADD COLUMN IF NOT EXISTS eligibility text NULL
    CHECK (eligibility IS NULL OR eligibility ~ '^[a-z0-9][a-z0-9.-]{0,31}$'),
  -- Commit-safe feed position (CHR-71): the inserting transaction's id. The
  -- feed only serves rows whose txid is below the current snapshot's xmin, so
  -- a transaction that commits late cannot be skipped by a consumer cursor.
  -- Correctness must be proven by the CHR-71 suite before it is relied on.
  ADD COLUMN IF NOT EXISTS txid xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE INDEX IF NOT EXISTS company_observations_feed_idx
  ON company_observations (installation_id, website_id, txid, id);
