-- 0015: daily counters for the watch-only source comparison
-- (SHADOW_SOURCES_MODE, src/shadow/; contract docs/contracts/source-shadow.v1.md).
-- Forward-only and additive: one new table, nothing else changes.
--
-- AGGREGATE COUNTS ONLY. One row per (installation, website, UTC day, metric)
-- holding a number. No address, fingerprint, company name, domain, ASN or
-- visitor identifier exists in this table, so none can be stored: `metric` is
-- a short token from a closed list in the code (SHADOW_METRICS in
-- src/shadow/types.ts), shape-checked here.
--
-- Written only by src/db/shadow-repo.ts: an upsert that adds to `count`, and
-- the per-source daily request reservation (`<source>_requests`, only while
-- below the configured limit). Read by GET /v1/reporting/source-shadow. Not
-- pruned by observation retention (counts only, like usage_periods). The
-- runtime role gets SELECT, INSERT and UPDATE, no DELETE (src/db/runtime-role.ts).

CREATE TABLE IF NOT EXISTS source_shadow_counts (
  installation_id  text    NOT NULL CHECK (installation_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  website_id       text    NOT NULL CHECK (website_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  day              date    NOT NULL,
  metric           text    NOT NULL CHECK (metric ~ '^[a-z0-9_]{1,64}$'),
  count            bigint  NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (installation_id, website_id, day, metric)
);
