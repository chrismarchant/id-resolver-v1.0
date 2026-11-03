# idr-sync on a local Supabase stack: results (CHR-65, Gate 4)

Run of 3 Nov 2026, cell G4-C, harness as committed in this directory. The
last run started from a torn-down stack (`stack.sh down`, `stack.sh up`,
`node run.mjs`): **141 checks passed, 0 failed**, in 56 s. Earlier runs on
the same stack gave the same result. **No defect was found** in the adapter
(`src/core`, the function, `sql/0001_idr_projection.sql`) or in the
resolver. Five observations about the platform follow. None of them is a
defect, and two of them may be worth a line in SETUP.md. These are the
results of one machine. They are not a certification: the limitations against
hosted Supabase are listed at the end.

## Approach

The brief's first option, a full local Supabase stack run by the CLI, worked.
The function runs under **Supabase's Edge Runtime** (Deno-based), not under
the Deno CLI. Kong serves it, and it writes through **PostgREST** into the
stack's **Postgres 17** with RLS. **GoTrue** issues the user tokens, and
`pg_cron` + `pg_net` + Vault make the scheduled call. The **real resolver**
(`apps/resolver/dist/main.js`, `PROVIDER_MODE=mock`, synthetic RFC 5737 /
RFC 3849 addresses) runs on 127.0.0.1 with its own PostgreSQL 16 cluster on
port 5433, not the shared 5432 cluster. A fault-injecting proxy sits between
the function and the resolver. The harness itself reads the feed directly
and serves as the test oracle.

The stack runs these services: `db`, `auth`, `rest`, `kong` and
`edge-runtime`. Realtime, storage, studio, SMTP, analytics, imgproxy,
postgres-meta, vector and supavisor are off.

### Getting the images

The Supabase CLI pulls from `public.ecr.aws` by default. Here the egress proxy
refused that registry's blob downloads (CloudFront, 403 by policy) and those
of ghcr.io (403), and Docker Hub answered 429. So the five images were pulled
from `mirror.gcr.io`, a mirror of Docker Hub, and re-tagged with the names
the CLI expects (`stack.sh pull`). The digests are below. Someone with normal
registry access can skip `stack.sh pull`.

The CLI also tried to send telemetry (PostHog), and the proxy refused it. The
harness sets `DO_NOT_TRACK=1`.

## Components

| component | version |
| --- | --- |
| Supabase CLI | 3.0.0 (npm `supabase@3.0.0`) |
| Postgres (Supabase side) | PostgreSQL 17.11, image `supabase/postgres:17.11.0.011` `sha256:7bd84e6a1d5322c7b864b9751873a0ac50f48df3f20a776e88114eadb2948fc0` |
| Extensions used | pg_cron 1.6.4, pg_net 0.20.4, supabase_vault 0.3.1 |
| PostgREST | 16.5, image `postgrest/postgrest:v16.5` `sha256:1347d7552b88f17832912c06afbf7c43209af6eeeb60834b04aae12c9bd9d5cc` |
| GoTrue (Auth) | v2.197.0, image `supabase/gotrue:v2.197.0` `sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b` |
| Kong | 2.8.1, image `library/kong:2.8.1` `sha256:1b53405d8680a09d6f44494b7990bf7da2ea43f84a258c59717d4539abf09f6d` |
| Edge Runtime | supabase-edge-runtime 1.77.9 ("compatible with Deno v2.1.4"; `deno 2.1.4` inside), image `supabase/edge-runtime:v1.77.9` `sha256:6b850a2ccf0bf50ecac9accff8098095cd191c389c2a53c59b857aa0f53a8343`, policy `per_worker` |
| Deno CLI (type check only) | 2.9.6: `deno check --no-config --no-lock supabase/functions/idr-sync/index.ts` passed |
| Resolver | this repository at `0cf34df` (`npm run build -w @idr/resolver`), Node v22.23.4 |
| Resolver Postgres | PostgreSQL 16.15, a dedicated cluster on 127.0.0.1:5433 |
| Docker | 29.9.2 (cgroup v1) |

## Commands

```bash
# once: Supabase CLI and images
npm i supabase@3.0.0                                   # in a scratch directory
E2E_IMAGE_MIRROR=mirror.gcr.io ./stack.sh pull          # only because the registries above were blocked
# resolver and its own cluster
npm run build -w @idr/resolver
pg_createcluster 16 g4c --port 5433 && pg_ctlcluster 16 g4c start   # plus a superuser role
# stack and scenarios
export SUPABASE_CLI=<cli binary> E2E_WORK=<private dir> E2E_RESOLVER_PG_URL_BASE=postgres://<user>:<pw>@127.0.0.1:5433
./stack.sh down && ./stack.sh up && node run.mjs
```

The function's configuration (in `E2E_WORK/project/supabase/functions/.env`):
`IDR_PAGE_LIMIT=5`, `IDR_MAX_PAGES=50`, `IDR_MAX_RETRIES=2`,
`IDR_BACKOFF_BASE_MS=20`, `IDR_BACKOFF_MAX_MS=100`, `IDR_REQUEST_TIMEOUT_MS=5000`,
`IDR_BUDGET_MS=30000`, `IDR_RECONCILE_DAYS` unset (0) and
`IDR_ALLOW_INSECURE_HTTP=true`. The last one is needed because the resolver
URL and the stack's own `SUPABASE_URL` (`http://kong:8000`) are both plain
HTTP here.

## Results per scenario

| scenario | checks | outcome |
| --- | --- | --- |
| S0 setup | 2/2 | The projection SQL is applied with `psql -f` as `postgres`, and the service_role RPC answers through PostgREST (schema_version 4). The function bundles offline (`edge-runtime bundle`, `--network none`) into an eszip that holds exactly the entry point and the 7 `src/core` modules, and no secret. |
| S0b skew and upgrade | 3/3 | Against the previous release's SQL (`test/fixtures/...f12b1ad.sql`, verbatim), the function answers HTTP 500 `schema_mismatch`, makes no resolver request and writes nothing. The old 4-argument apply works through PostgREST. Re-running the current SQL upgrades in place on Supabase's catalog: the row and the cursor are kept, schema_version is 4, the old signature is dropped, and every `idr_*` ACL is exactly owner + service_role. |
| S2 function auth | 9/9 | Each of these gets an empty 401: no `x-idr-sync-secret`, a wrong secret, the secret with one character changed, half the secret, GET or PUT with the right secret, and the platform keys (anon apikey + service_role bearer) instead of the secret. None of them reached the resolver (0 proxied requests), and none wrote a state row. |
| S1 authenticated sync | 12/12 | 24 observations arrive in 5 pages with one feed request per page, each carrying the reporting token. The projection equals the feed: all fields, companies and tombstones match. The stored cursor equals the feed's end cursor, with status `ok`. The response holds the summary fields only, with no domain, cursor or credential. A feed request with the token stripped, or with the website token, ends in `auth_failed` (HTTP 502) with nothing written and the cursor kept. The next run catches up. |
| S3 replay / idempotency | 15/15 | A re-run at the end cursor makes 1 page, inserts 0 rows and leaves `received_at` untouched. A replay from a stale cursor (the state as restored from an older backup) makes 4 pages, inserts 0 rows and returns the cursor to the end. A voluntary `idr_begin_resync` through PostgREST works: the re-check (`after=<old>&limit=1`, 200) runs first, then the replay from the start, which inserts 0 rows; the re-check is cleared and no gap is recorded. Three concurrent invocations (responses delayed 400 ms) give one `ok` and two `cas_conflict`, and insert all 15 observations exactly once. Five concurrent `idr_apply_feed_page` calls through PostgREST with one expected cursor apply exactly once. 260 new observations (52 pages, more than `IDR_MAX_PAGES` 50) give `partial` after 50 pages, and the next run drains the remaining 2. |
| S4 tombstones | 8/8 | `ops:erase-company --company-id` deletes 204 observations (as many as the projection held for the company) and writes 1 tombstone. The projection is unchanged until the consumer pulls. The tombstone is the only item after the consumer's cursor, so it follows every observation of the company that the consumer applied, and the erased observations have left the feed. The run applies it: the company and all its observations are gone, the tombstone is recorded, and the other company is untouched. A re-observation of the same domain arrives as a **new** company id. A full replay re-applies the tombstone idempotently. |
| S5 interruption | 11/11 | **a)** SIGKILL of the Edge Runtime container while the resolver's page 3 is held in the proxy: the caller gets 502. Pages 1 and 2 (10 observations) are committed and nothing after them. After `docker start`, the next run applies the remaining 10, with no loss and no duplicate. **b)** The PostgREST backend is terminated while the apply waits: `store_error` (HTTP 500), rolled back, then the next run applies the page. **c)** The function is killed while its apply waits on the state row lock: the orphaned apply **commits after the function died** (the cursor advanced, 5 rows), and the next run continues from that cursor and re-applies nothing. **d)** An apply blocked longer than the `authenticator` role's `statement_timeout`/`lock_timeout` (8 s) is cancelled server-side after about 8 s, before the store's 20 s client timeout: `store_error`, rolled back, then applied by the next run. |
| S6a continuity gap | 14/14 | The consumer stalls at cursor C. Batch A is written, then batch B 5 s later. The resolver's own `ops:prune` runs with `OBSERVATION_RETENTION_DAYS=1` and its clock set to the boundary between A and B plus 1 day (`lib/clock-preload.mjs`). It pruned everything older than the boundary (147 of 151 observations: A, and what the consumer already had) and kept B (4). The resolver answers C with 410. The run answers HTTP 409 `needs_resync` with `gap_recorded`/`gap_new`, and **exactly one** `idr_sync_gaps` row exists: `cursor_expired`, `expired_cursor = C`, `last_applied_at` and `last_observed_at` correct, open. The cursor is not advanced. Two more runs answer 409 without a new row or a resolver request. The row cannot be deleted or rewritten: service_role DELETE through PostgREST gives 403, PATCH gives 400, and the owner's DELETE and TRUNCATE in SQL give 23514. `idr_begin_resync` followed by a drain gives `ok` with `gaps_resolved = 1`. The row persists, resolved once (`full_resync`). B is present, A is **permanently absent**, and the observations applied before the gap stay. |
| S6b voluntary-resync re-check | 6/6 | After a prune past C2, a voluntary `idr_begin_resync` keeps C2 in `reset_from_cursor`. The run's first request is the re-check, which gets 410. The gap is recorded **without halting**: the replay drains and resolves it in the same run (HTTP 200, `gap_recorded`, `gaps_resolved = 1`). This adds a second row; the first row is unchanged. |
| S6c R3-A | 8/8 | The resolver is restarted with a rotated `IP_HMAC_SECRET`, so the stored cursor, which is within retention, gets 400. The first replay page is failed once with 503: the run ends `upstream_error` (502) after **exactly one** request for that page (no retry, although `IDR_MAX_RETRIES=2`), with `cursor = null`, `reset_from_cursor` = the rejected cursor and no gap. The next run re-checks (400 again), sends the first page once, and retries a later page that failed once. It reports `cursor_rejected` (200), clears the re-check, stores the new key's end cursor and records no gap. The following run is a plain `ok`. |
| S7 RLS via PostgREST | 49/49 | **anon** (legacy anon JWT and `sb_publishable_` key) gets 401 on every table, on the view and on every `idr_*` RPC. A **forged** token carrying the claim, signed with another key, gets 401. **Public sign-up** is refused (422 `signup_disabled`). An **authenticated user without the claim** (created with the admin API, signed in with GoTrue) gets 200 with 0 rows everywhere. If that user sets `user_metadata.idr_reader=true` themselves, they still see 0 rows. For a **reader**, the claim is set with the admin API. The token issued before the grant still sees nothing. After a new sign-in the reader sees every row of the 5 tables and the view (the sum of entrances equals the observations). The reader's INSERT, PATCH and DELETE get 403, every RPC gets 403, and no table changes. **Revocation**: a new sign-in sees nothing, while the earlier token keeps reading until it expires (as SETUP.md says). **service_role** RPC works. The catalog confirms that only service_role may execute the `idr_*` functions, that every ACL is exactly owner + service_role (the claim in `rls.test.ts`), that anon has no table privilege, that authenticated has SELECT only, that service_role has no DELETE or TRUNCATE on `idr_sync_gaps`, and that RLS is on for all 5 tables. |
| S8 pg_cron + pg_net | 3/3 | The job body of `sql/schedule.example.sql` was scheduled **verbatim**, with the URL and the secret in Vault. Only the schedule was changed, to `10 seconds`, and the URL is the internal `http://kong:8000/...`. `cron.job_run_details` shows `succeeded`, `net._http_response` shows 200 with the run summary, and the 3 new observations were applied. The job was unscheduled afterwards. |
| S9 final | 1/1 | The projection equals the cumulative model of the feed (158 observations, 2 companies, 1 tombstone, 2 gap rows), with no duplicate. |

**Harness sensitivity check.** The served copy of `engine.ts` was mutated in
the work directory, with the first replay page no longer single-shot, and the
harness was run against it. S6c failed 5 checks: the page was retried and
succeeded. This shows that the harness detects an R3-A regression and that
the Edge Runtime really serves the copied code. The copy was then restored,
it was compared byte for byte with the repository, and the run passed again.

## Observations (not defects)

1. **PostgREST role timeouts.** On this stack the `authenticator` role has
   `statement_timeout=8s` and `lock_timeout=8s`, and `service_role` has none.
   A store call that waits in the database is therefore cancelled
   server-side after 8 s (S5d). `PostgrestStore`'s 20 s client timeout only
   ever fires on a network stall. Nothing is lost: the apply rolls back and
   the next run applies the page. But an operator who sees `store_error`
   should know about this bound. Hosted defaults were not checked.
2. **PostgREST does not cancel a statement whose HTTP client went away.**
   This was seen directly, and probed separately as well. An apply in flight
   when the function dies, or when its client times out, can commit
   afterwards (S5c). The compare-and-set design makes this harmless: the next
   run starts from the stored cursor and re-applies nothing. But a
   `store_error` response does **not** mean "nothing was written".
3. **Supabase's default privileges** give `service_role` more than the SQL
   grants: TRUNCATE on the four projection tables, and INSERT, UPDATE, DELETE
   and TRUNCATE on the view. `anon` and `authenticated` are revoked correctly.
   `idr_sync_gaps` is stripped to SELECT, INSERT and UPDATE as intended, and
   its trigger stops the owner as well. This is consistent with "only
   service_role writes". The unit tests, which run on plain Postgres, cannot
   see these defaults.
   *Follow-up after this run (CHR-66 G4-L4, Gate 5):* the script now revokes
   every privilege of `anon`, `authenticated`, `service_role` and `PUBLIC`
   on each `idr_*` object before granting exactly what it needs, and the unit
   tests emulate Supabase's default privileges. This stack was not re-run
   against that change.
4. **The CLI publishes ports on all interfaces** unless the docker network
   has `host_binding_ipv4=127.0.0.1`. That includes the database on 54322
   with the local default password. The harness creates such a network;
   anyone running `supabase start` by hand for this adapter should do the
   same.
5. **Bundling from the repository layout.** In a probe outside the harness,
   `edge-runtime bundle` run directly on `integrations/supabase-edge`, which
   has a `package.json` and `node_modules`, also packed `package.json` and a
   vitest cache file into the eszip. From the layout SETUP.md step 3
   describes (S0), the bundle holds exactly the 8 modules. What
   `supabase functions deploy` does with a client's own `package.json` was
   not checked.

## Local vs hosted Supabase: limitations

- **pg_cron / pg_net / Vault.** These are the extension versions of the local
  image (pg_cron 1.6.4, pg_net 0.20.4, supabase_vault 0.3.1). The job used a
  10-second schedule instead of `*/5 * * * *`, and called the function at
  `http://kong:8000` inside the docker network. A hosted job calls the public
  `https://<ref>.supabase.co/functions/v1/idr-sync` through Supabase's edge,
  with TLS and DNS. pg_net's handling of slow or failing HTTPS endpoints, and
  hosted extension versions, were not exercised.
- **Edge Runtime vs Deno CLI vs hosted.** The function ran under the Edge
  Runtime 1.77.9 (Deno 2.1.4 compatibility, `per_worker` policy, hot reload),
  with the CLI bind-mounting each imported file. Hosted functions run from a
  deployed eszip on Supabase's infrastructure, whose runtime version may
  differ. The Deno CLI (2.9.6) was used only for `deno check`. Hosted CPU-time,
  wall-clock and memory limits were not reproduced: the local runtime's
  limits differ, and they were not measured. `IDR_BUDGET_MS` was therefore
  not tested against a hosted wall-clock limit. The CLI lowered the Edge
  Runtime's file-descriptor limit to 20000 on this host.
- **Auth / GoTrue.** GoTrue v2.197.0 issued ES256 user tokens, signed with a
  key the CLI generated (JWKS). The legacy anon and service_role keys are
  HS256, signed with a JWT secret the harness generated at runtime. The
  `sb_publishable_` and `sb_secret_` keys were present too. A hosted project
  may use the legacy JWT secret or asymmetric keys, and may have other Auth
  settings (e-mail confirmation, SMTP, rate limits, session lifetime). Users
  were created with the admin API (`email_confirm: true`), so no e-mail flow
  was exercised. Revocation was shown only to the extent SETUP.md claims: a
  token already issued keeps working until it expires.
- **Network and TLS.** Everything was plain HTTP on one host:
  `IDR_ALLOW_INSECURE_HTTP=true` for both the resolver URL and `SUPABASE_URL`.
  The function reached the resolver through the harness proxy on the docker
  bridge gateway. Hosted means HTTPS to the resolver (on Railway), public DNS,
  real latency, TLS handshakes, and possibly egress rules; none of that was
  tested. The resolver, the oracle and the prune share one clock.
- **Resource limits and scale.** One machine (4 vCPU, 15 GB), cgroup v1. The
  largest drain was 260 observations, at 5 per page. Neither pages of
  500 items, nor long drains near the budget, nor sustained load were
  measured.
- **Cold starts.** The first invocation after `supabase start`, and after the
  SIGKILL restart, was a cold start and worked; it was not timed. Hosted cold
  starts and isolate recycling between invocations were not reproduced.
  Locally the `per_worker` policy keeps a worker warm; whether the three
  concurrent invocations shared a worker was not checked. Hosted may spread
  them across isolates. The compare-and-set argument does not depend on
  that, but it was not observed there.
- **Secrets management.** The function's secrets came from
  `supabase/functions/.env`, not from `supabase secrets set`. Vault was
  exercised through SQL (`vault.create_secret` / `update_secret`), not
  through the dashboard. No key was rotated on the Supabase side, though the
  resolver's `IP_HMAC_SECRET` was rotated (S6c).
- **Deployment path.** `supabase functions deploy`, `supabase secrets set`
  and `supabase db push` act on a hosted project, and were deliberately not
  run. The projection SQL was applied with `psql -f` as `postgres`, as from
  the SQL editor. S0's eszip shows that the function bundles; it does not
  show the upload.
- **Gateway.** Kong 2.8.1 with the CLI's configuration stood in for hosted
  Supabase's API gateway. Header handling, limits and timeouts may differ;
  for example, the 502 seen on the kill is Kong's.
- **Postgres.** Version 17.11 here. Hosted projects may run 15 or 17, and
  may have other role settings (observation 1).
- **Retention prune.** The prune was run with the resolver's process clock
  moved forward (`lib/clock-preload.mjs`), rather than by waiting a day. The
  delete is the resolver's own statement, so the watermark trigger and the
  0007 guards apply unchanged. No ad-hoc delete was used anywhere on the
  resolver.
- **Images.** The images came from a Docker Hub mirror (`mirror.gcr.io`), not
  from `public.ecr.aws`. Their digests are recorded above; that they match
  ECR's was not checked.

## Not covered

- Reconciliation end to end (`IDR_RECONCILE_DAYS`, `/v1/reporting/summary`).
- The in-place upgrade from the `6318ab2` release on Supabase. Only
  `f12b1ad` was tested here; the unit tests cover both on plain Postgres.
  The pre-upgrade checks in SETUP.md were not tested either.
- CHR-66 R3-C: two runs holding the same cursor across a prune. Overlapping
  runs were covered only without a prune (S3).
- A tampered cursor (400) and the CHR-66 N1 path for an unverifiable cursor
  behind the watermark (410). The 410 here came from a validly signed cursor
  (S6a) and from a re-check (S6b). Both paths are covered by the resolver's
  own tests.
- Anything hosted (see above), soak or load tests, and more than one resolver
  instance.

## State left behind

At the end of the session, the stack and the resolver's cluster were stopped.
To start again:

```bash
setsid nohup dockerd > dockerd.log 2>&1 &   # when the docker daemon is not a service
pg_ctlcluster 16 g4c start
cd integrations/supabase-edge/e2e && ./stack.sh up && node run.mjs
```
