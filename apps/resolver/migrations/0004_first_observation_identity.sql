-- ID Resolver V0.1 augmentation, review fix: stable earliest-observation
-- identity (independent review P2 on d6a8fb6).
--
-- company_scope_stats.first_observation_ref persists WHICH observation is the
-- company's first in the scope, independently of the prunable observation
-- rows. Rules (src/db/activity-repo.ts, UPSERT_STATS_SQL): set on the first
-- accepted observation; replaced only when a strictly earlier observed_at is
-- accepted later; on an equal instant the earlier ACCEPTED observation keeps
-- it. The reporting listing flags company_first on exactly that reference.
--
-- Backfill from the durable deduplication records (company_observation_refs,
-- never pruned): for each stats row, the reference whose observed_at equals
-- the lifetime first_observed_at; on an equal instant the one whose
-- observation row survives with the lowest id, else the lexically smallest
-- reference. When no record carries first_observed_at (the true first
-- observation was pruned before migration 0003 recorded references), the
-- identity is unreconstructable and stays NULL: no surviving row is promoted.

ALTER TABLE company_scope_stats ADD COLUMN IF NOT EXISTS first_observation_ref text
  CHECK (first_observation_ref IS NULL OR first_observation_ref ~ '^[A-Za-z0-9_-]{1,64}$');

UPDATE company_scope_stats s
SET first_observation_ref = (
  SELECT r.observation_ref
  FROM company_observation_refs r
  LEFT JOIN company_observations o
    ON o.installation_id = r.installation_id AND o.website_id = r.website_id AND o.observation_ref = r.observation_ref
  WHERE r.installation_id = s.installation_id AND r.website_id = s.website_id AND r.company_id = s.company_id
    AND r.observed_at = s.first_observed_at
  ORDER BY o.id ASC NULLS LAST, r.observation_ref ASC
  LIMIT 1)
WHERE s.first_observation_ref IS NULL;
