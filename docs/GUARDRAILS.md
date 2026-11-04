# Guardrails: three-database separation (G1-G7)

Repository-level checks that keep the three database environments of an ID Resolver deployment apart and keep
visitor-level data out of everything that leaves the resolver. Every guardrail has a **positive** test (the clean
tree, build or schema passes) and a **negative** test (a planted violation is caught), and runs in CI
(`.github/workflows/ci.yml`: job `hygiene` for G1, job `verify` on PostgreSQL 16 and 18 for G2-G7).

## The three environments

| | Environment | Holds | Must never hold |
|---|---|---|---|
| **A** | Website (Lovable on Cloudflare) and its own Lovable-native Supabase project | `IDR_RESOLVER_URL`, `IDR_RESOLVER_TOKEN`, `IDR_WEBSITE_ID` (server-side only) | any ref, URL or key of the private Supabase project, the reporting token, the resolver's database credentials |
| **B** | Railway resolver and its Railway PostgreSQL | the operational system of record (`DATABASE_URL`, the runtime role, `RESOLVER_AUTH_TOKEN`, `REPORTING_AUTH_TOKEN`, `IP_HMAC_SECRET`) | any Supabase credential, URL or project ref: C pulls from B, B never connects to C |
| **C** | Private ID Resolver (Insights) Supabase project | the projection of the sanitised `reporting-feed.v1`, pulled by the `idr-sync` Edge Function (`integrations/supabase-edge`) with the reporting token as an Edge secret | raw IPs, fingerprints, observation references, query strings or any other visitor-level data |

Data flows one way: the website's server reports entrances to B (`/v1/entrances`, `/v1/events`); C pulls the
reporting feed from B (`/v1/reporting/observations`). Nothing else connects.

## G1: public-safety gate and secret scan know Supabase

**Enforces.** No concrete Supabase project host (`<20-character ref>.supabase.co` or `.supabase.in`, including
`db.<ref>.supabase.co`), no concrete connection-pooler host (`<name>.pooler.supabase.com`), no `sb_secret_` or
`sb_publishable_` key, and no JWT whose decoded payload has `"role":"service_role"` anywhere in the tree, in any
file or ref name, or anywhere in the git history (every added line, commit and tag message, identity). These
rules are in the `NEVER_ALLOW` class: they do not honour the `public-safety: allow-synthetic` marker and cannot be
allow-listed in `.public-safety-history-allow`; a hit needs history rewriting and rotation. Placeholders such as
`<project-ref>.supabase.co`, links to `supabase.com/docs`, bare key prefixes in prose and anon JWTs are not
reported. Exactly one synthetic stand-in ref, already in the public history
(`docs/staging/acceptance/self-test.mjs`), is exempt by exact value (`SYNTHETIC_SUPABASE_REFS`). The project-host,
pooler-host and key rules are mirrored as custom gitleaks rules in `.gitleaks.toml` (gitleaks' default `jwt` rule
already reports every JWT).

**Files.** `scripts/check-public-safety.mjs`, `scripts/check-public-safety.test.mjs`, `.gitleaks.toml`,
`.public-safety-history-allow` (header), `docs/PUBLIC_REPO_SECURITY.md`.

**Tests.** The self-test plants each value (assembled at runtime) in the tree and in history, proves the marker
does not opt it out, that an allow-list entry for each rule is refused, that output is redacted, and that the
allowed forms stay quiet.

## G2: website and browser artifacts carry nothing of B's reporting side or of C

**Enforces.** The TanStack adapter's compiled output (`.js` and `.d.ts`) and the probe app's server bundle contain
no `SUPABASE_` name, `sb_secret_`/`sb_publishable_`, `service_role`, concrete project or pooler host, `/v1/reporting`,
`REPORTING_AUTH_TOKEN`, `IDR_REPORTING_TOKEN` or `DATABASE_URL`; they legitimately contain `/v1/entrances` and
`/v1/events`, and name the Supabase domains the adapter refuses (G3b). The probe app's **client** assets
additionally contain no `supabase` at all (on top of the existing server-code and token checks). The browser
collector's minified bundle and tsc output contain none of these and none of the resolver's routes or
`IDR_RESOLVER_TOKEN` either.

**Files.** `packages/tanstack/test/hygiene.test.ts`, `packages/collector/test/bundle.test.ts`.

**Tests.** Positive: the real dist, the probe build (CI sets `IDR_REQUIRE_PROBE=1`, so it never skips) and the
collector bundle are clean, and contain what they should (sanity). Negative: every needle is planted into a text,
and into the real collector bundle, and is detected.

## G3: fail-closed configuration refuses cross-environment targets

**(a) Resolver (B).** `loadConfig`, `migrate`, every `ops:*` command and `ops:db-tls-fingerprint` refuse, before any
connection: any variable named `SUPABASE_*` (case-insensitive; the message names the variable, never its value),
and a `DATABASE_URL` whose host, or `host`/`hostaddr` query parameter (which node-postgres and libpq let override
it), is under `supabase.co`, `supabase.in` or `supabase.com` (percent-encoding, case, trailing dots and libpq host
lists handled). Fixed messages, following the `REMOVED_VARIABLES` pattern.
Files: `apps/resolver/src/config/index.ts`, `src/db/migrate.ts`, `src/ops/env.ts`, `src/ops/db-tls-fingerprint.ts`;
test `apps/resolver/test/unit/supabase-separation.test.ts` (each path, the migrate CLI exiting before it connects,
look-alike hosts accepted).

**(b) Adapter (A).** A `resolverUrl` on a host under those domains is invalid configuration like any other:
eager options throw at creation with a fixed message, lazy options disable reporting with `config_invalid` and
send nothing. The adapter's default behaviour is otherwise unchanged (there is no enable flag). The package version
is `0.1.0-dev.1`, unreleased. Files: `packages/tanstack/src/config.ts`; tests in
`packages/tanstack/test/middleware.test.ts` and `collector-route.test.ts`.

**(c) Edge Function (C).** `IDR_BASE_URL` on a host under those domains is a configuration problem: the function
answers `misconfigured` and fetches nothing, so the reporting token is never sent to a Supabase project.
`SUPABASE_URL` (the project's own URL) is unaffected. Files: `integrations/supabase-edge/src/core/config.ts`; tests
in `test/handler.test.ts`.

Limit: a Supabase project behind a custom domain cannot be recognised by its host name.

## G4: projection exposure controls

**Enforces**, for every `public.idr_*` object, as rules rather than a fixed list: no privilege for `anon` or
`PUBLIC` (ACL and effective, including role membership) and no RLS policy that applies to them; `authenticated`
holds `SELECT` only, on tables with RLS enabled and a non-trivial `SELECT` policy, or on a `security_invoker` view;
no column-level grant; no `idr_*` function executable by `anon`, `authenticated` or `PUBLIC`; every
`SECURITY DEFINER` function pins `search_path` with `pg_temp` last; Supabase's default privileges (ALL to `anon`,
`authenticated`, `service_role`) do not leak (`service_role` reads only). Supabase's RLS auto-enable event trigger
(`ensure_rls`) is emulated in a scratch database, and the projection installs, re-runs and upgrades from every
earlier release cleanly under it, also as a non-superuser owner.

**Files.** `integrations/supabase-edge/test/helpers/exposure.ts`, `test/exposure.test.ts` (the exact grant lists
stay in `test/helpers/acl.ts`).

**Tests.** Positive: fresh install, re-run, upgrades and owner install are clean. Negative: each rule is proved by
a planted violation (a grant to `anon`/`PUBLIC`, a write grant, a sequence or column grant, role membership, RLS
off, a `PUBLIC` or write policy, an unconditional policy, a non-invoker view, function `EXECUTE`, a definer
without or with a bad `search_path`, a new `idr_*` table under the default privileges) in a rolled-back
transaction.

**Out of scope here:** moving the projection out of `public` into its own schema (a separate, reviewed change).

## G5: no raw-IP-capable column, and a guarded page_key

**Projection (C).** An exact `(relation, column, type)` snapshot of every `idr_*` table and view, after a fresh
install and after an upgrade from every release; no `inet`, `cidr`, `macaddr`, `macaddr8` or `bytea` column
(domains and arrays resolved); no column name matching
`ip|addr|fingerprint|hmac|visitor|session|user_agent|referrer|email|observation_ref|entrance`, except
`idr_observations.entrance_contract` (the contract name, such as `entrance.v1`) and
`idr_daily_company_activity.entrances` (a count). Test: `integrations/supabase-edge/test/exposure.test.ts`
(planted columns caught).

**Resolver (B).** After migrations 0001-0009 on a fresh database, no column of any relation in any schema has a
network-address type (domains and arrays resolved), and `bytea` or an address-like name appears only on the
allowlist: `ip_resolution_cache.ip_fingerprint`, the 32-byte HMAC-SHA-256 of the canonical address under
`IP_HMAC_SECRET` (fixed-size by `CHECK`), a keyed one-way digest and not a raw address. Test:
`apps/resolver/test/integration/schema-no-raw-ip.test.ts` (planted columns caught, including behind a domain, in a
view and in another schema).

**page_key guard (projection schema 8).** `page_key` is checked against the resolver's own rule
(`isValidPageKey` in `apps/resolver/src/contracts/api.ts`, and the CHECK of `apps/resolver/migrations/0005`:
1-256 **code points**, leading `/`, no `?`, `#`, whitespace, control character or lone surrogate), twice:

* by the Edge function's validator (`src/core/validate.ts`, `isResolverPageKey`), which counts code points
  exactly as the resolver does (not UTF-16 code units: a character outside the Basic Multilingual Plane, such as
  an emoji, is one code point and two units). A failing value is replaced by null before the page reaches the
  store, so it is never even sent to the database;
* by `idr_apply_feed_page` (`char_length`, the same rule in SQL), for anything that reaches it by another path.

A failing value is not stored: the observation is kept with `page_key` null (the value the contract already
allows), the page applies and the cursor advances, so the sync neither halts nor stores the value. Both counts
are reported as `page_keys_cleared` in the run result, the function's response and (when not zero) its log line.
Only a `page_key` that is not a string at all is a contract violation (`contract_error`), as before. Every page
the resolver serves passes, so a resolver-valid page never halts the sync on its `page_key`.

**A null `page_key` is ambiguous** (documentation only, nothing records which): it means either that the resolver
sent none (an observation recorded through an older contract, which the contract allows) or that G5 cleared a
value that failed the rule. `page_keys_cleared` counts the second case per run; the projection does not mark
the row.

Tests: `integrations/supabase-edge/test/apply-guards.test.ts` (every valid form stored unchanged; each invalid
form cleared, at the function and through the engine; astral-plane keys at the 256/257 code-point boundary
through the engine; the validator's rule compared with the resolver's own `isValidPageKey` over valid, boundary
and invalid keys; a page of resolver-valid keys never halts), `test/upgrade.test.ts` (after upgrading from every
release).

## G6: reporting-feed wire allowlist (resolver)

**Enforces.** Every envelope, scope, observation item, tombstone item and 410 body the feed serves has exactly the
keys of an explicit allowlist (compared as sets: an extra key and a missing key both fail), and the feed query
never references the IP resolution cache, a fingerprint or key-version column, observation references or their
deduplication table, browser events or eligibility. Changing the allowlist is a contract change.

**Files.** `apps/resolver/test/helpers/feed-wire.ts`, `test/unit/feed-wire-allowlist.test.ts` (detector, SQL
check and planted violations), `test/integration/feed-wire-allowlist.test.ts` (every page of the real HTTP feed,
across pages, with cache-linked, nameless and erased companies, and the 410).

## G7: erasure propagation in the projection (schema 8)

**Enforces.** `idr_apply_feed_page` ignores an observation whose `company_id` already has a tombstone of the
installation in `idr_tombstones` (the contract's recommendation, `docs/contracts/reporting-feed.v1.md`, "Erasure
and re-observation": company ids are never reused). A re-applied or replayed page can therefore never resurrect
an erased company; the result counts such items as `ignored_erased`, and the count (never a value) reaches the
Edge function's run result, its response (`"ignored_erased"`) and, when not zero, its log line (`PostgrestStore`,
`engine.ts`, `handler.ts`; tests in `test/handler.test.ts`).

**Tests.** `integrations/supabase-edge/test/apply-guards.test.ts`: a stale page after the tombstone, an
observation after its tombstone in the same page, a replay through the engine after a resync (positive); a
re-observation under a new company id and another installation's tombstone are applied normally (negative
controls). `test/upgrade.test.ts`: a tombstone recorded by each earlier release is honoured after the upgrade.

Schema 8 is required by the engine of this release (`PROJECTION_SCHEMA_VERSION`); an older install gets
`schema_mismatch` before any fetch until the idempotent script is re-run (`integrations/supabase-edge/SETUP.md`).

## Running them

```sh
npm ci --ignore-scripts
# G1
node scripts/check-public-safety.mjs
node scripts/check-public-safety.mjs --history
node --test scripts/check-public-safety.test.mjs
gitleaks git . --config .gitleaks.toml --redact --no-banner --exit-code 1   # pinned 8.30.1, as in CI
# G2-G7 (PostgreSQL 16+ with a superuser test role, as in CI)
export TEST_DATABASE_URL=postgres://resolver:resolver@127.0.0.1:5432/id_resolver_test
npm ci --ignore-scripts --no-audit --no-fund --prefix packages/tanstack/verification/cf-lifecycle
IDR_REQUIRE_PROBE=1 npm run verify --workspaces --if-present
```

Single guardrails: `npx vitest run test/unit/supabase-separation.test.ts` (G3a) or
`test/unit/feed-wire-allowlist.test.ts test/integration/feed-wire-allowlist.test.ts` (G6) or
`test/integration/schema-no-raw-ip.test.ts` (G5) in `apps/resolver`; `npx vitest run test/hygiene.test.ts` (G2)
in `packages/tanstack`; `npx vitest run test/bundle.test.ts` (G2) in `packages/collector`;
`npx vitest run test/exposure.test.ts test/apply-guards.test.ts test/upgrade.test.ts test/handler.test.ts`
(G3c, G4, G5, G7) in `integrations/supabase-edge`. The G4 scratch database and event trigger need a superuser
test role (CI's `POSTGRES_USER` is one).
