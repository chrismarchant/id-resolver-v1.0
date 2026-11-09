-- 0011: per-period activity counters for the reporting API's daily activity
-- (GET /v1/reporting/activity). Forward-only and additive: eleven columns on
-- usage_periods, nothing else changes.
--
-- Every resolution job already counts resolver_requests. These count each
-- job once more, by its final status, so the outcome columns together add up
-- to resolver_requests (best-effort, like every usage counter): a cache hit
-- and a fresh lookup are counted under the same status. company_visits counts
-- newly recorded company observations and company_first_visits those that
-- were the company's first in the scope. Counts only: no address, fingerprint,
-- company or visitor identifier is stored here.
--
-- The runtime role already holds table-level SELECT, INSERT and UPDATE on
-- usage_periods (src/db/runtime-role.ts), which covers the new columns.
ALTER TABLE usage_periods
  ADD COLUMN IF NOT EXISTS outcome_qualified    bigint NOT NULL DEFAULT 0 CHECK (outcome_qualified >= 0),
  ADD COLUMN IF NOT EXISTS outcome_no_match     bigint NOT NULL DEFAULT 0 CHECK (outcome_no_match >= 0),
  ADD COLUMN IF NOT EXISTS outcome_excluded     bigint NOT NULL DEFAULT 0 CHECK (outcome_excluded >= 0),
  ADD COLUMN IF NOT EXISTS outcome_unknown      bigint NOT NULL DEFAULT 0 CHECK (outcome_unknown >= 0),
  ADD COLUMN IF NOT EXISTS outcome_pending      bigint NOT NULL DEFAULT 0 CHECK (outcome_pending >= 0),
  ADD COLUMN IF NOT EXISTS outcome_ineligible   bigint NOT NULL DEFAULT 0 CHECK (outcome_ineligible >= 0),
  ADD COLUMN IF NOT EXISTS outcome_disabled     bigint NOT NULL DEFAULT 0 CHECK (outcome_disabled >= 0),
  ADD COLUMN IF NOT EXISTS outcome_uncertain    bigint NOT NULL DEFAULT 0 CHECK (outcome_uncertain >= 0),
  ADD COLUMN IF NOT EXISTS outcome_unavailable  bigint NOT NULL DEFAULT 0 CHECK (outcome_unavailable >= 0),
  ADD COLUMN IF NOT EXISTS company_visits       bigint NOT NULL DEFAULT 0 CHECK (company_visits >= 0),
  ADD COLUMN IF NOT EXISTS company_first_visits bigint NOT NULL DEFAULT 0 CHECK (company_first_visits >= 0);
