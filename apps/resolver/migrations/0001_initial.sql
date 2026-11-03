-- ID Resolver V0.1 initial schema.
--
-- Privacy invariant: NO column in this schema may hold an IP address, range,
-- ISP, ASN or geolocation. Visitors are only ever represented by a 32-byte
-- HMAC-SHA-256 fingerprint (protected pseudonymous data, never returned to
-- the website). Never add network-address column types or address-named
-- columns; test/integration/db-migrate.test.ts fails if forbidden tokens
-- appear in migrations or src/db.

CREATE TABLE IF NOT EXISTS companies (
  id                bigserial PRIMARY KEY,
  domain            text        NOT NULL UNIQUE,
  organisation_name text        NULL,
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_resolution_cache (
  installation_id       text        NOT NULL,
  website_id            text        NOT NULL,
  key_version           integer     NOT NULL,
  ip_fingerprint        bytea       NOT NULL CHECK (octet_length(ip_fingerprint) = 32),
  status                text        NOT NULL CHECK (status IN
                          ('pending', 'qualified', 'no_match', 'excluded', 'unknown', 'provider_error', 'uncertain')),
  company_id            bigint      NULL REFERENCES companies (id) ON DELETE SET NULL,
  qualification_category text       NULL,
  checked_at            timestamptz NOT NULL,
  expires_at            timestamptz NOT NULL,
  lease_expires_at      timestamptz NULL,
  reservation_token     text        NULL,
  attempts              integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, website_id, key_version, ip_fingerprint),
  -- A row is pending exactly while it carries a token and a lease.
  CONSTRAINT ip_resolution_cache_pending_shape CHECK (
    (status = 'pending' AND reservation_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'pending' AND reservation_token IS NULL AND lease_expires_at IS NULL)
  )
);

-- Supports bounded expiry pruning (WHERE expires_at <= now ... LIMIT n).
CREATE INDEX IF NOT EXISTS ip_resolution_cache_expires_at_idx
  ON ip_resolution_cache (expires_at);

CREATE TABLE IF NOT EXISTS usage_periods (
  installation_id            text        NOT NULL,
  website_id                 text        NOT NULL,
  period_key                 text        NOT NULL,
  resolver_requests          bigint      NOT NULL DEFAULT 0 CHECK (resolver_requests >= 0),
  cache_hits                 bigint      NOT NULL DEFAULT 0 CHECK (cache_hits >= 0),
  provider_attempts          bigint      NOT NULL DEFAULT 0 CHECK (provider_attempts >= 0),
  domain_resolutions         bigint      NOT NULL DEFAULT 0 CHECK (domain_resolutions >= 0),
  qualified_matches          bigint      NOT NULL DEFAULT 0 CHECK (qualified_matches >= 0),
  no_matches                 bigint      NOT NULL DEFAULT 0 CHECK (no_matches >= 0),
  excluded_results           bigint      NOT NULL DEFAULT 0 CHECK (excluded_results >= 0),
  unknown_results            bigint      NOT NULL DEFAULT 0 CHECK (unknown_results >= 0),
  failures                   bigint      NOT NULL DEFAULT 0 CHECK (failures >= 0),
  uncertain_outcomes         bigint      NOT NULL DEFAULT 0 CHECK (uncertain_outcomes >= 0),
  -- Credits the provider itself reported. Never inferred.
  provider_credits_reported  bigint      NOT NULL DEFAULT 0 CHECK (provider_credits_reported >= 0),
  -- Locally estimated credits. Clearly an estimate.
  provider_credits_estimated bigint      NOT NULL DEFAULT 0 CHECK (provider_credits_estimated >= 0),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, website_id, period_key)
);

-- Runtime kill switch. An absent row means enrichment is enabled.
CREATE TABLE IF NOT EXISTS deployment_controls (
  installation_id    text        PRIMARY KEY,
  enrichment_enabled boolean     NOT NULL DEFAULT true,
  reason             text        NULL,
  updated_at         timestamptz NOT NULL
);
