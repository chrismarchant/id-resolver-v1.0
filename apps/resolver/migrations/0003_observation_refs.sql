-- ID Resolver V0.1 augmentation, review fixes (Codex P2 findings on dcc780e).
--
-- 1. Durable deduplication of observation references, independent of
--    observation retention: one minimal row per accepted reference, holding
--    only the scope, the reference, the company id, the server timestamp and
--    the previously-seen answer given at record time. It carries no IP,
--    fingerprint, header, provider payload or person identifier, and it is
--    never pruned by OBSERVATION_RETENTION_DAYS (see docs/REPORTING.md,
--    "Retention and deletion"). Replaying a reference after its observation
--    row was pruned therefore still records nothing and still detects a
--    different company as a conflict.
--
-- 2. "Newly observed" is derived from the scoped earliest observation
--    timestamp (company_scope_stats.first_observed_at), not from the order in
--    which transactions committed, so the insertion-order company_first flag
--    is removed together with its partial index.

CREATE TABLE IF NOT EXISTS company_observation_refs (
  installation_id  text        NOT NULL,
  website_id       text        NOT NULL,
  observation_ref  text        NOT NULL CHECK (observation_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  company_id       bigint      NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  observed_at      timestamptz NOT NULL,
  previously_seen  boolean     NOT NULL,
  PRIMARY KEY (installation_id, website_id, observation_ref)
);

-- Serves the ON DELETE CASCADE from companies (manual company deletion).
CREATE INDEX IF NOT EXISTS company_observation_refs_company_idx
  ON company_observation_refs (company_id);
CREATE INDEX IF NOT EXISTS company_observations_company_idx
  ON company_observations (company_id);

-- Existing observations (none in production before this augmentation ships)
-- become deduplication records; this derives nothing that was not recorded.
INSERT INTO company_observation_refs (installation_id, website_id, observation_ref, company_id, observed_at, previously_seen)
SELECT installation_id, website_id, observation_ref, company_id, observed_at, NOT company_first
FROM company_observations
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS company_observations_first_idx;
ALTER TABLE company_observations DROP COLUMN IF EXISTS company_first;
