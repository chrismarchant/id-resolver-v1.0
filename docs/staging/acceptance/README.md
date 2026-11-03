# Staging acceptance scripts

Scripts for the owner or MAIN to run **after** the owner has provisioned the disposable staging resources
([../CLOUDFLARE_TEST_SITE.md](../CLOUDFLARE_TEST_SITE.md), [../SUPABASE_HOSTED_TEST.md](../SUPABASE_HOSTED_TEST.md)).
Node 22, no dependencies beyond Node built-ins (the hosted Supabase catalog checks use the repository's `pg`).
They are not part of `npm run verify` or CI.

| file | what it is |
|---|---|
| `cf-site-check.mjs` | Cloudflare staging site: TTFB and delivery, resolver faults, trust policy, **G4-I8**, route CSRF/replay/rate checks, bundle safety, `waitUntil` ceiling, cold starts, the real-browser checklist |
| `canary-sink.mjs` | the stand-in resolver and header canary the owner runs next to the resolver (outside the site's zone) |
| `supabase-hosted-check.mjs` | hosted Supabase project: function auth through the gateway, sync, concurrency, RLS with real Auth, catalog and G4-L4, pg_cron/pg_net/Vault, projection = feed, optional seeding |
| `lib/common.mjs` | shared: target validation, redaction, results, raw HTTP |
| `self-test.mjs` | `node --test docs/staging/acceptance/self-test.mjs`: refusals, redaction, canary behaviour; 127.0.0.1 only |

## Safety rules (all scripts)

* **No defaults that point anywhere.** Every URL, key and token comes from environment variables at run time.
  A script refuses (exit 2, nothing sent) when a required variable is missing, a URL is not https (http only for a
  loopback host with `--local-probe` / `--local-stack`), a value still contains a `<placeholder>`, or the operator
  did not repeat the target on the command line with `--confirm-target <site host | project ref>`.
* **No secrets in output.** Output lines and result files (`--out`, written with mode 600) never contain a token,
  key, IP address, user id or e-mail address; hosts appear as `<site>`, `<canary>`, `<resolver>`, `<project>`.
  The canary stores no IP and no header value: it keeps booleans and header **names**.
* **Enter secrets without echo**, for example `read -rs ACCEPT_CANARY_TOKEN && export ACCEPT_CANARY_TOKEN`; never on
  the command line and never in a file in the repository.
* `--dry-run` validates the configuration and prints the plan without sending anything.
* Result files are private. A summary for the repository is written separately and checked with
  `node scripts/check-public-safety.mjs` before it is committed.

## Environment variables (names only)

`cf-site-check.mjs`: `ACCEPT_SITE_URL`, `ACCEPT_SITE_ZONE`, `ACCEPT_RESOLVER_URL` (required);
`ACCEPT_CANARY_URL`, `ACCEPT_CANARY_TOKEN` (phases `ttfb`, `faults`, `route`, `ceiling`, `cold`);
`ACCEPT_PROBE_TOKEN` (`ceiling`); `ACCEPT_COLLECTOR_ALLOW`, `ACCEPT_COLLECTOR_CONSENT`, `ACCEPT_RATE_EVENTS`,
optional `ACCEPT_CONSENT_COOKIE` (`route`); optional `ACCEPT_TESTER_IP`, `ACCEPT_BUNDLE_SCAN_TOKEN`,
`ACCEPT_REPORTED_PREFIX`, `ACCEPT_CONTROL_PREFIX`, `ACCEPT_COLLECTOR_PATH`, `ACCEPT_EXPECT_COLLECTOR`.

`canary-sink.mjs`: `CANARY_TOKEN`, `CANARY_BIND`, `PORT` (required); optional `CANARY_DEFAULT_MODE`,
`CANARY_FORGED_IP`.

`supabase-hosted-check.mjs`: `SBH_URL`, `SBH_PUBLISHABLE_KEY`, `SBH_SERVICE_ROLE_KEY`, `SBH_SYNC_SECRET`,
`SBH_INSTALLATION_ID` (required); optional `SBH_DB_URL` with `SBH_DB_CA_FILE` (or the explicit opt-out
`SBH_DB_TLS_NOVERIFY=1`), `SBH_RESOLVER_URL` + `SBH_REPORTING_TOKEN` (oracle), `SBH_SEED_RESOLVER_URL` +
`SBH_SEED_RESOLVER_TOKEN` + `SBH_SEED_WEBSITE_ID` (with `--seed N`), `SBH_TEST_EMAIL_DOMAIN`, `SBH_EXPECT_SCHEMA`,
`SBH_EXPECT_RECONCILE`, `SBH_FUNCTION`.

## Examples

```bash
cd docs/staging/acceptance
node --test self-test.mjs

# Cloudflare staging site (after provisioning; values typed, not echoed)
export ACCEPT_SITE_URL=https://idr-staging.<STAGING_ZONE> ACCEPT_SITE_ZONE=<STAGING_ZONE> \
       ACCEPT_RESOLVER_URL=https://<canary-host> ACCEPT_CANARY_URL=https://<canary-host> \
       ACCEPT_COLLECTOR_ALLOW=page_view,scroll_50,scroll_90,engaged_30s,cta_click,form_start,form_submit \
       ACCEPT_COLLECTOR_CONSENT=required ACCEPT_CONSENT_COOKIE=staging_consent=granted ACCEPT_RATE_EVENTS=60
read -rs ACCEPT_CANARY_TOKEN && export ACCEPT_CANARY_TOKEN
read -rs ACCEPT_PROBE_TOKEN && export ACCEPT_PROBE_TOKEN
node cf-site-check.mjs --dry-run --phase all --confirm-target idr-staging.<STAGING_ZONE>
node cf-site-check.mjs --phase all --confirm-target idr-staging.<STAGING_ZONE> --out <private dir>/cf-all.json

# The same script against the repository's local workerd probe (no credentials; what was run on 3 Nov 2026)
#   cd packages/tanstack/verification/cf-lifecycle && npm ci --ignore-scripts && npm run build
#   npx wrangler dev -c .output/server/wrangler.json --port 8799 --ip 127.0.0.1 --local
#   export both CANARY_TOKEN and ACCEPT_CANARY_TOKEN as the probe's own synthetic token (src/start.ts), then:
#   CANARY_BIND=127.0.0.1 PORT=4599 node canary-sink.mjs
#   ACCEPT_SITE_URL=http://127.0.0.1:8799 ACCEPT_SITE_ZONE=probe.invalid ACCEPT_RESOLVER_URL=http://127.0.0.1:4599 \
#   ACCEPT_CANARY_URL=http://127.0.0.1:4599 ACCEPT_COLLECTOR_ALLOW=page_view,cta_click,scroll_50,scroll_90 \
#   ACCEPT_COLLECTOR_CONSENT=not_required ACCEPT_RATE_EVENTS=600 \
#   node cf-site-check.mjs --local-probe --phase all --confirm-target 127.0.0.1:8799

# Hosted Supabase project
export SBH_URL=https://<PROJECT_REF>.supabase.co SBH_INSTALLATION_ID=<installation-id>
read -rs SBH_PUBLISHABLE_KEY && export SBH_PUBLISHABLE_KEY
read -rs SBH_SERVICE_ROLE_KEY && export SBH_SERVICE_ROLE_KEY
read -rs SBH_SYNC_SECRET && export SBH_SYNC_SECRET
node supabase-hosted-check.mjs --confirm-target <PROJECT_REF> --checks auth,sync,concurrency,rls --out <private dir>/sb.json
```

## Executed so far (3 Nov 2026)

* `self-test.mjs`: 9 of 9 pass.
* `cf-site-check.mjs --local-probe --phase all` against the local workerd probe: 53 PASS, 0 FAIL, 1 SKIP (no
  ceiling route in the probe); `--phase down`: 2 PASS. Details and the finding G5-D-F1 in
  [../CLOUDFLARE_TEST_SITE.md](../CLOUDFLARE_TEST_SITE.md) section 7.
* `supabase-hosted-check.mjs`: refusals and `--dry-run` only (self-test). The hosted checks are **unexecuted**;
  the `--local-stack` mode was not run (no Docker daemon in that session).
* Nothing was run against Cloudflare, Supabase, Railway or npm.
