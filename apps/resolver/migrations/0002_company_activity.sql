-- ID Resolver V0.1 augmentation: durable company-level activity.
--
-- Privacy invariant (unchanged): no column holds an IP address, range, ISP,
-- ASN, geolocation, fingerprint, provider payload, header or person
-- identifier. Observations carry only the company id, the scope, a server
-- timestamp, an opaque caller reference and the source of the association.
--
-- Separation: ip_resolution_cache is private, fingerprint-keyed and pruned by
-- TTL. companies, company_observations and company_scope_stats are durable
-- company-level records and survive cache expiry and pruning.

-- One row per accepted observation of a company in a (installation, website)
-- scope. observation_ref is the caller's bounded opaque idempotency reference
-- (or one generated server-side when the caller omitted it); a repeated
-- reference within the scope never adds a second row.
CREATE TABLE IF NOT EXISTS company_observations (
  id               bigserial   PRIMARY KEY,
  installation_id  text        NOT NULL,
  website_id       text        NOT NULL,
  company_id       bigint      NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  observed_at      timestamptz NOT NULL,
  observation_ref  text        NOT NULL CHECK (observation_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  source           text        NOT NULL CHECK (source IN ('cache', 'provider')),
  -- True when this was the first accepted observation of the company in the
  -- scope (decided under a per-company lock, so exactly one row per company
  -- and scope carries true).
  company_first    boolean     NOT NULL,
  CONSTRAINT company_observations_ref_unique UNIQUE (installation_id, website_id, observation_ref)
);

-- Scope-wide listing and date-range summaries.
CREATE INDEX IF NOT EXISTS company_observations_scope_time_idx
  ON company_observations (installation_id, website_id, observed_at DESC, id DESC);
-- Per-company observation history.
CREATE INDEX IF NOT EXISTS company_observations_company_time_idx
  ON company_observations (installation_id, website_id, company_id, observed_at DESC, id DESC);
-- Newly observed companies per date range.
CREATE INDEX IF NOT EXISTS company_observations_first_idx
  ON company_observations (installation_id, website_id, observed_at)
  WHERE company_first;

-- Per-scope, per-company lifetime activity summary, maintained in the same
-- transaction as the observation insert. Its existence is the durable answer
-- to "was this company previously observed in this scope".
CREATE TABLE IF NOT EXISTS company_scope_stats (
  installation_id    text        NOT NULL,
  website_id         text        NOT NULL,
  company_id         bigint      NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  first_observed_at  timestamptz NOT NULL,
  last_observed_at   timestamptz NOT NULL,
  observation_count  bigint      NOT NULL CHECK (observation_count >= 0),
  PRIMARY KEY (installation_id, website_id, company_id)
);

-- Stable pagination of identified companies by most recent activity.
CREATE INDEX IF NOT EXISTS company_scope_stats_recent_idx
  ON company_scope_stats (installation_id, website_id, last_observed_at DESC, company_id DESC);

-- companies.first_seen_at / last_seen_at now mean accepted activity:
-- first_seen_at = creation by a qualified provider resolution (unchanged);
-- last_seen_at = the latest accepted observation (cache hit or provider), or
-- the creation instant when no observation has been recorded yet. Existing
-- rows keep their pre-migration values (which reflected provider resolutions
-- only) and have no observation history; nothing is backfilled.
