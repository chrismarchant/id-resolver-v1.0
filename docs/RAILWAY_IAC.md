# Railway Infrastructure as Code

Status: Gate 5. `.railway/railway.ts` declares the **development** environment
of the resolver's Railway project. Evaluated by the Railway CLI; no workflow in
this repository plans or applies it.

## What it declares

| Resource | Settings managed by the file |
|---|---|
| service `id-resolver` | Dockerfile builder, `apps/resolver/Dockerfile`; pre-deploy `node dist/db/migrate.js` (300 s); healthcheck `/healthz` (60 s); restart `ON_FAILURE`, 3 retries; 0.5 vCPU, 500 MB; 1 replica in `ams`; IPv6 egress off; no TCP proxy, no custom domain |
| service `id-resolver` variables | `DATABASE_URL` = reference to `Postgres.DATABASE_URL`; every other variable by **name only**, value `preserve()`: `ALLOW_DOCUMENTATION_RANGES`, `ALLOW_MOCK_PROVIDER`, `DATABASE_RUNTIME_PASSWORD` (sealed), `DATABASE_SSL`, `DATABASE_TLS_PIN_SHA256`, `ENRICHMENT_ENABLED`, `INSTALLATION_ID`, `IP_HMAC_SECRET` (sealed), `LOG_LEVEL`, `OBSERVATION_RETENTION_DAYS`, `PERIOD_CALL_CAP`, `PROVIDER_MODE`, `REPORTING_AUTH_TOKEN` (sealed), `RESOLVER_AUTH_TOKEN` (sealed), `WEBSITE_ID` |
| database `Postgres` | the `postgres-ssl` template image, data at `/var/lib/postgresql/data`, no TCP proxy and no public domain declared |

Deliberately **not** managed (left as Railway holds them): the service's
source (repository, branch; omitting `source` means "do not manage"), the
service's generated public domain (generated domains are never part of an IaC
file), and the PostgreSQL service's own template variables, region and volume
(owned by the managed-database helper).

The variable list is the **target state after the Gate 5 rollout** below:
`DATABASE_TLS_PIN_SHA256` and `DATABASE_RUNTIME_PASSWORD` are listed, the
transitional overrides `ALLOW_UNVERIFIED_DATABASE_TLS` and
`ALLOW_OWNER_DATABASE_ROLE` are not. Plan before the rollout is complete and
the plan will differ; do not apply then.

`apps/resolver/test/unit/railway-iac.test.ts` evaluates the file with the
pinned SDK and asserts the settings above (whole-project resource set,
pre-deploy migrate, healthcheck, restart policy, region and limits, no TCP
proxy or declared domain, every value `preserve()` except the `DATABASE_URL`
reference, no override variable, no host, id or key material in the source).
The resolver's `typecheck` also typechecks `.railway/railway.ts`
(`.railway/tsconfig.json`).

## Why `railway.json` was removed

Config as Code is deprecated: new services cannot opt in, and existing
`railway.json` files stop being read on 2026-12-01. The `id-resolver` service
is new, so the file was never read for it; it had also drifted
(`restartPolicyMaxRetries: 5` while the service runs with 3). Keeping it, even
marked superseded, would leave two sources of truth, and the CLI refuses to
plan a service that is still managed by `railway.json` and finds such files
during `railway config migrate`. `.railway/railway.ts` is the single source.

## Requirements

* **Railway CLI 5.42.1 or newer** (the SDK refuses older CLIs). Install it as
  Railway documents; this repository does not vendor it.
* `npm ci` at the repository root: installs the SDK, `railway` **3.16.0**
  (exact pin, a root devDependency; published 2026-10-14). The CLI resolves
  `railway/iac` from `.railway/` upwards. `.railway/package.json` marks the
  file as an ES module.
* **Token: an environment-scoped project token**, created by the **owner** in
  the project's settings (Tokens) for the development environment only, and
  exported as `RAILWAY_TOKEN` in the shell that runs the CLI. A project token
  is limited to one project and environment, so the commands below cannot
  reach any other environment. Never commit it, never paste it into an issue
  or log, revoke it when the work is done. (Alternatively an operator who is
  logged in with `railway login` can `railway link` this directory to the
  project and the development environment.)

## Risk: omitted resources are deleted

This is a **whole-project** file (no `export const partial`): `railway config
apply` makes the environment match it, so a resource missing from the file is
**deleted**, and a variable missing from a declared service is **deleted**.
For a sealed variable (`IP_HMAC_SECRET`, `RESOLVER_AUTH_TOKEN`,
`REPORTING_AUTH_TOKEN`, `DATABASE_RUNTIME_PASSWORD`) that loss is
unrecoverable: sealed values cannot be read back, only recreated. Railway marks
destructive changes and, non-interactively, refuses them without
`--confirm-destructive`. **Never pass `--confirm-destructive`** for this
environment unless every destructive line was reviewed and is intended.

## Runbook

All commands from the repository root, with `RAILWAY_TOKEN` set as above.

1. **Compare with the live environment** (read-only). `railway config pull`
   overwrites the authoring file it finds, so run it in an empty scratch
   directory, never in this checkout:

   ```
   mkdir -p "$SCRATCH/idr-pull" && cd "$SCRATCH/idr-pull"
   railway config pull
   diff -u "$SCRATCH/idr-pull/.railway/railway.ts" "$REPO/.railway/railway.ts"
   ```

   Do not pass `--include-variables` (it would write non-sealed values,
   secrets included, to disk). Review the diff for: the PostgreSQL image tag,
   the region key (`ams`), the CPU and memory values, every variable name, and
   any volume resource the importer lists for the database. Anything the live
   environment has that the file lacks must be added to the file (by name,
   `preserve()`), or the apply would delete it. Delete the scratch directory
   afterwards.

2. **Plan** (read-only):

   ```
   railway config plan
   railway config plan --detailed-exit-code   # 0 = nothing to change, 2 = changes pending
   ```

   It must print **"Your Railway configuration is already up to date."**, or
   list only changes you intend. A plan that shows any of these is wrong and
   must not be applied: a destroy of a service, database, volume or variable; a
   change to the PostgreSQL image, volume or networking; a TCP proxy or domain
   added anywhere; a change of `id-resolver`'s source. Values are redacted in
   plan output (`«hidden»`); do not use `--show-values` in a shared terminal.

3. **Apply only a reviewed plan**:

   ```
   railway config plan --out railway-plan.json
   # review the plan output
   railway config apply --plan railway-plan.json
   ```

   `--plan` applies exactly the saved change set and fails if the environment
   changed since (re-plan then). Answer the confirmation interactively; do not
   add `--yes` or `--confirm-destructive`. `railway-plan*.json` is git-ignored;
   delete it afterwards.

4. **Verify** after an apply: the deployment is healthy, `config_loaded` shows
   the expected `tls_mode` and `db_role`, and a fresh `railway config plan`
   says "already up to date".

Not verified from this repository: no `railway config plan` has been run
against the live environment (the cell that wrote the file has no Railway
access). The first plan is the verification; expect to adjust the image tag,
region key or memory value if the live values differ.

### Optional: plan in CI (for the owner to enable)

No workflow is committed. Before enabling one (G5R2-L7):

* `railway config plan` **executes** `.railway/railway.ts` (TypeScript) with
  the token in its environment, and a Railway project token is **not
  plan-only**: it can apply, delete resources and read the non-sealed
  variables of its environment. Never hand it to code from a pull request: no
  `pull_request` (and never `pull_request_target`) trigger, because a branch
  of this repository can change both `railway.ts` and the workflow itself.
* Plan only code that is already merged: on `push` to `main` (paths
  `.railway/**`) and/or `workflow_dispatch` run from `main`.
* Keep the token in a GitHub **Environment** (for example `railway-dev`) with
  required reviewers and a deployment-branch rule that allows `main` only,
  not in a repository secret, so every run is approved and no other branch's
  workflow can read it.
* The token is an environment-scoped project token for the development
  environment only, and only the plan step receives it.
* Never `apply` from CI. The `railwayapp/config` action is referenced by
  Railway's documentation; its behaviour was not verified here.

```yaml
name: railway-config-plan
on:
  push:
    branches: [main]
    paths: [".railway/**"]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  plan:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    # Required reviewers; deployment branches: main only; holds RAILWAY_TOKEN.
    environment: railway-dev
    env:
      HAS_TOKEN: ${{ secrets.RAILWAY_TOKEN != '' }}
    steps:
      - uses: actions/checkout@<sha> # pin
        with:
          persist-credentials: false
      - uses: actions/setup-node@<sha> # pin
        with:
          node-version: 22
      - run: npm ci --ignore-scripts
      - name: Plan only (skipped while the environment has no RAILWAY_TOKEN)
        if: env.HAS_TOKEN == 'true'
        uses: railwayapp/config@<sha> # pin; command: plan only
        with:
          command: plan
          railway-token: ${{ secrets.RAILWAY_TOKEN }}
```

## Dev rollout: database TLS and roles

The Gate 5 build refuses, when `NODE_ENV=production` (set by the image, also
for the pre-deploy migrate), `DATABASE_SSL=no-verify` unless
`ALLOW_UNVERIFIED_DATABASE_TLS=true`, and running as the `DATABASE_URL` owner
unless `DATABASE_RUNTIME_PASSWORD` is set or `ALLOW_OWNER_DATABASE_ROLE=true`.
Development today runs `no-verify` as the owner, so the variables must change
**before** this build deploys. Every variable change on Railway redeploys the
current build; batch the changes of one step into one staged change.

**Step 0, before the deploy.**

* **Owner:** create the sealed variable `DATABASE_RUNTIME_PASSWORD` on
  `id-resolver`, generated locally with `openssl rand -hex 32` and never
  stored anywhere else. Only the owner can do this: a sealed value cannot be
  read back. (The current build ignores the variable.)
* **MAIN:** set `ALLOW_UNVERIFIED_DATABASE_TLS=true` on `id-resolver`
  (transitional: the pin is not known yet). If the owner has not created the
  password yet, also set `ALLOW_OWNER_DATABASE_ROLE=true` (transitional).

**Step 1, deploy this build.** The pre-deploy migrate (as the owner) applies
`0009_runtime_role_support.sql` and creates `idr_runtime` with the password
and its grants (`runtime_role: "created"` in its JSON line; a warning line
names the active override). Verify:

* the deployment is healthy and `/readyz` answers 200;
* the service log has `config_loaded` with `db_role: "runtime"`,
  `database_role_check` with `outcome: "least_privilege"`, and
  `config_override` warnings only for the overrides set in step 0;
* the smoke run passes (`node dist/ops/smoke.js`, RUNTIME.md);
* as the owner, `SELECT usename FROM pg_stat_activity WHERE application_name =
  'id-resolver'` lists only `idr_runtime` (besides your own session).

If `ALLOW_OWNER_DATABASE_ROLE` was used, the owner creates
`DATABASE_RUNTIME_PASSWORD` later and MAIN deletes `ALLOW_OWNER_DATABASE_ROLE`
in the same staged change; re-verify as above.

**Step 2, pin the certificate.**

1. In the service (`railway ssh` into `id-resolver`):
   `node dist/ops/db-tls-fingerprint.js`. Note `sha256`, `subject_alt_names`
   and `valid_to` in the private Linear issue (the SANs may contain the private
   host name: never in this repository).
2. Second, independent reading on the database itself (Railway shell of the
   `Postgres` service):
   `openssl x509 -noout -fingerprint -sha256 -in /var/lib/postgresql/data/certs/server.crt`.
   The value after `=` must equal the first reading (colons and case aside;
   either form is accepted as a pin). Two readings over
   different paths remove the trust-on-first-use caveat.
3. One staged change on `id-resolver`: `DATABASE_SSL=verify-pinned`,
   `DATABASE_TLS_PIN_SHA256=<sha256>` (not a secret; a plain variable), and
   delete `ALLOW_UNVERIFIED_DATABASE_TLS`.
4. Verify: healthy; `config_loaded` shows `tls_mode: "verify-pinned"`; no
   `config_override` line; the smoke run passes; the helper now reports
   `matches_configured_pin: true`. Add a reminder for `valid_to` minus 45 days
   (renewal changes the pin; RUNTIME.md "Rotation").

**Step 3, adopt IaC.** Run the runbook above (pull and compare, plan). With
steps 0-2 done the plan should be "already up to date" (or show only values the
first comparison identified). Apply only if it shows intended changes.

**Rollback.**

* Pin problem (e.g. the certificate was regenerated): fix the pin (RUNTIME.md
  "Rotation"); or, temporarily, `DATABASE_SSL=no-verify` plus
  `ALLOW_UNVERIFIED_DATABASE_TLS=true` and delete `DATABASE_TLS_PIN_SHA256`
  (a pin with `no-verify` is refused), in one staged change.
* Role problem: `ALLOW_OWNER_DATABASE_ROLE=true` and (owner) delete
  `DATABASE_RUNTIME_PASSWORD`, in one staged change: the service runs as the
  owner again. The role and its grants stay and are harmless.
* Previous build: it connects as the owner with `DATABASE_URL`, ignores the
  new variables, and accepts the upgraded database (migration 0009 is
  reported as "database ahead", not refused). It does **not** know
  `verify-pinned`: set `DATABASE_SSL=no-verify` first, or it refuses to start.

**Production** follows the same steps without any override: read the pin
from the database volume (step 2.2) before the first deploy, set
`DATABASE_SSL=verify-pinned`, `DATABASE_TLS_PIN_SHA256` and the sealed
`DATABASE_RUNTIME_PASSWORD` first, then deploy.
