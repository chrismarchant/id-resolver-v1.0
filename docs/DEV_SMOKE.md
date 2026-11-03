# Development smoke test and rollback check (dev deployment only)

`node dist/ops/smoke.js` (source: `apps/resolver/src/ops/smoke.ts`) checks a
running resolver from inside its own service. It is for the isolated
development deployment with the mock provider only. It refuses to run unless
`PROVIDER_MODE=mock`.

## How it runs

Run it as a **one-off pre-deploy command** of the dev service, in place of
`node dist/db/migrate.js`, for one deployment. The pre-deploy container has the
service's own variables. It reaches the deployment that is **still running**
over the private network (`http://$RAILWAY_PRIVATE_DOMAIN:$PORT`), and its
public domain over TLS. Put the pre-deploy command back to
`node dist/db/migrate.js` afterwards.

* **Run it only when the running deployment has the same variables** as the
  pre-deploy container. Railway redeploys on every variable change, so change
  the variables, let that deployment finish, and then run the smoke.
* **Variables it reads** (never prints their values): `PROVIDER_MODE`,
  `RESOLVER_AUTH_TOKEN`, `REPORTING_AUTH_TOKEN`, `WEBSITE_ID`,
  `INSTALLATION_ID`, `DATABASE_URL`, `DATABASE_SSL`,
  `ALLOW_DOCUMENTATION_RANGES`, `EVENTS_ENABLED`, `EVENT_CONSENT_MODE`,
  `RAILWAY_PRIVATE_DOMAIN`, `PORT` and `RAILWAY_PUBLIC_DOMAIN`.
  `SMOKE_BASE_URL` overrides the target for loopback runs only.
* **It never changes a variable or any other configuration.**

## Output and exit codes

The output is JSON lines only. It contains check names, HTTP statuses, enums
and counts. It never contains tokens, IP addresses, bodies, `event_id`s,
`page_key` values or configuration values.

* **One line per check:** `{"event":"smoke_check","check",outcome,pass,detail}`.
  * `outcome` is `pass`, `fail` or `skipped`.
  * `pass` is `false` only for a failed check.
* **One summary line:** `smoke_summary`, with `suite`, `mode`, `events_mode`,
  `event_consent_mode`, `events_phase`, the kill-switch fields, and `checks`,
  `passed`, `failed` and `skipped`, where
  `passed + failed + skipped = checks`.
* **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | No check failed. Skipped checks are listed and counted apart. |
  | 1 | A check failed. |
  | 2 | Refused or misconfigured; or a kill switch left engaged by an earlier smoke run; or the kill switch is not verifiably back as found by this run's own hand; or a signal interrupted the kill-switch phase. Read stderr: it names the state and the command to run. |

## Expected check counts

The counts below assume the switch is released before the run.

| `ALLOW_DOCUMENTATION_RANGES` | `EVENTS_ENABLED` | Railway (public domain set) | Local (no public domain) |
|---|---|---|---|
| true | true | 50 checks: 50 passed, 0 skipped | 46: 45 passed, 1 skipped |
| true | false | 34: 34 passed, 0 skipped | 30: 29 passed, 1 skipped |
| false | true | 52: 40 passed, 12 skipped | 48: 35 passed, 13 skipped |
| false | false | 36: 24 passed, 12 skipped | 32: 19 passed, 13 skipped |
| `--mode rollback-check` | (not read) | 17: 17 passed, 0 skipped | 13: 12 passed, 1 skipped |

Where the counts can differ:

* **Concurrent traffic.** With events enabled, one check can become `skipped`
  instead of `passed` when other entrance traffic hit the service during the
  event requests. That check is "no cache, company or observation row created
  during the event requests". `checks` is unchanged, and the run still exits 0.
* **The switch engaged by an operator before the run.** The post-restore
  control is then skipped.
* **Credential-less requests.** Each run sends 7 requests without a valid
  credential to the private target. The service throttles invalid credentials
  per peer at `AUTH_FAILURE_LIMIT_PER_MINUTE` (default 60). Do not run more than
  about 8 smoke runs a minute.

## What each part checks

* **Kill-switch orphan check.** This runs first.
  * **If the switch is engaged with the smoke's own reason**, an earlier run
    was killed while it held the switch (SIGKILL, OOM, a lost container), or
    another smoke run is holding it now. The run stops at once with exit 2.
  * **It does not count this as "left as found".** If no other run is in
    progress, release it with
    `node dist/ops/kill-switch.js off --reason "released by an operator after a smoke run"`,
    then confirm `enrichment_enabled=true` with `node dist/ops/usage.js`.
* **Kill-switch phase.** This runs with `ALLOW_DOCUMENTATION_RANGES=true`.
  1. The smoke engages the switch only if it is still released, with a
     reason that names the run.
  2. It probes one uncached address and expects `disabled`.
  3. It releases the switch **only if it still carries that run's reason**
     (compare-and-set).
  4. If an operator engaged or released the switch meanwhile, the smoke
     leaves it as they set it and exits 2 with
     `KILL SWITCH CHANGED BY SOMEONE ELSE DURING THE RUN`.
  * SIGINT, SIGTERM, SIGHUP and SIGQUIT are deferred while the switch may be
    held: the restore runs first, then the run exits 2.
* **Events phase** (`EVENTS_ENABLED=true`, contract `event.v1`):
  * **Ingestion:** a valid event is stored, a repeated `event_id` is not
    stored twice, and a second event is stored. The response is exactly
    `{version, recorded}`.
  * **Rejections:** no credential gets 401, and the reporting credential 401.
    An unknown field (`ip`) gets 400, and an out-of-vocabulary name 400.
    `consent: not_required` gets 403 `consent_required` under the default
    `EVENT_CONSENT_MODE=required`. `occurred_at` outside the window gets 400.
  * **No address** appears in any event response.
  * **Database checks** (read-only, `BEGIN READ ONLY`):
    * `browser_events` holds exactly the accepted events of the run, with
      exactly the 0008 columns and vocabulary-only values.
    * No company observation carries the event `page_key`.
    * The inserting transactions wrote no other table.
    * The high-water marks show no cache, company or observation row created
      during the event requests.
  * **The reporting feed** afterwards has no item derived from the events,
    and keeps the exact `reporting-feed.v1` shape.
* **Events disabled.** `POST /v1/events` must be byte-identical to an unknown
  route: 404 with the website credential, 401 without.

## Side effects of a run (all synthetic)

| Setting | What a run leaves |
|---|---|
| Documentation ranges enabled | Three observations with `page_key` `/smoke/<run>` (domain example.com). The dev Insights projection receives them through the feed. |
| Events enabled | Two `browser_events` rows with `page_key` `/smoke/<run>/ev`. They are never in the feed. |
| Kill-switch phase | The switch is engaged for about one request, then released with the reason `smoke test (CHR-72): released again, as found before the run [run <run>]`. It also leaves two cache rows and one mock provider attempt. |

All of these leave through the normal retention and maintenance runs
(`OBSERVATION_RETENTION_DAYS`).

## Rollback to a build before migration 0008

A build from before Gate 4 cell B1 (migration 0008, `POST /v1/events`) can run
on a database that already has 0008. Examples are the Gate 3 baseline and the
Gate 4 cell A CHR-72 build. Verified locally with the CHR-72 build.

* **Pre-deploy migrate** of the old build exits 0 and applies nothing. It does
  not refuse the unknown `0008_browser_events`.
* **The service starts** and logs
  `migration_check {"outcome":"database_ahead","count":1}`, then
  `server_started`. Its `config_loaded` line has no `events_enabled` field: the
  old build ignores `EVENTS_ENABLED`.
* **`POST /v1/events` does not exist.** With the website credential it gets
  the same answer as any unknown route, which in builds before Gate 4 is
  `400 invalid_request`, not 404. Without a credential it gets 401, like every
  route. The `browser_events` rows stay and are not pruned by the old build.

### Verifying the rollback without the old build's smoke

1. **Deploy logs.** The old build's pre-deploy `migrate.js` exited 0.
2. **Service logs.** `migration_check` with `outcome` `database_ahead` and
   `count` 1, followed by `server_started`, and no `process_fatal`.
3. **Public edge, unauthenticated:**
   * `GET https://<public domain>/healthz` and `/readyz` answer 200.
   * `POST https://<public domain>/v1/entrances` with an invalid body answers
     401.

   These only show the old build is up. Absence of the route is shown by the
   next step.
4. **Optional, from inside, with the current smoke.** Redeploy the current
   build with the one-off pre-deploy command
   `node dist/ops/smoke.js --mode rollback-check`.
   * The command runs in the new deployment's container **before it goes
     live**, so it checks the still-running rolled-back deployment:
     liveness, credential separation, the feed, and "`POST /v1/events`
     answers exactly like an unknown route".
   * The suite sends nothing that resolves, writes nothing and reads no
     database.
   * Expect exit 0 with 17 passed, and the detail
     `status 400, identical to an unknown route` for a build before Gate 4.
   * When it passes, the current build goes live: that deploy is also the
     roll forward. Its pre-deploy did not run `migrate.js`, which is fine
     because the database already has 0008.

## Restoring the normal configuration

1. Set `EVENTS_ENABLED=false`, or delete the variable (the default is off).
   Leave `EVENT_CONSENT_MODE` unset (`required`).
2. Put the pre-deploy command back to `node dist/db/migrate.js` and let that
   deployment finish.
3. Check the service log: `config_loaded` shows `events_enabled:false`, and
   `migration_check` shows `current`.
4. Optionally, run the smoke once more. Expect the events-disabled counts
   above, with `POST /v1/events` 404, byte-identical to an unknown route.
5. Confirm the kill switch reads released with `node dist/ops/usage.js`
   (`enrichment_enabled: true`).
