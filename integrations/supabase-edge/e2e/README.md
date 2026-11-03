# idr-sync end-to-end harness (local Supabase stack)

Runs the reference adapter end to end on a **local** Supabase stack: the
`idr-sync` Edge Function under Supabase's Edge Runtime (Deno), behind Kong,
writing through PostgREST into the stack's Postgres with RLS, authenticated
users from the stack's Auth (GoTrue), and `pg_cron` + `pg_net` + Vault for the
scheduled call. It pulls from the **real resolver** (`apps/resolver/dist`,
mock provider, synthetic documentation addresses) running on `127.0.0.1`.
Results of the last run and the limitations against hosted Supabase:
[RESULTS.md](RESULTS.md).

It is **not** part of `npm run verify` or CI: it needs Docker, the Supabase
CLI, a few GB of images and a dedicated PostgreSQL cluster. Nothing here talks
to a hosted Supabase project or any other cloud service.

```
 run.mjs ──POST x-idr-sync-secret──▶ Kong :54321 (127.0.0.1) ──▶ Edge Runtime: idr-sync (Deno)
    │                                                               │            │
    │                                     PostgREST ◀── rpc/idr_* ──┘            │ GET /v1/reporting/observations
    │                                         │                                  ▼
    │                                  Postgres 17 (RLS)        fault proxy (in run.mjs, docker
    │                                    ▲  pg_cron/pg_net ─────▶ bridge gateway, host-only)
    │                                    │                                       │
    └── oracle: feed read, SQL ──────────┴───────────────────────▶ resolver dist/main.js 127.0.0.1:54390
                                                                     └─ own PostgreSQL cluster (not :5432)
```

## Prerequisites

- Docker (daemon running), Node 22, `psql`, `openssl`.
- Supabase CLI **3.0.0** (`npm i supabase@3.0.0` in a scratch directory and set
  `SUPABASE_CLI` to its binary, or have `supabase` on `PATH`). Other versions
  pull other image tags; `stack.sh` lists the ones 3.0.0 uses.
- The resolver built: `npm run build -w @idr/resolver` (from the repository root).
- A PostgreSQL superuser on a cluster **nothing else uses**: the feed's horizon
  is cluster-wide, so another session's open transaction would hold the feed
  back. `run.mjs` refuses port 5432 unless `E2E_ALLOW_SHARED_CLUSTER=1`.
  On Debian/Ubuntu, for example:

  ```bash
  pg_createcluster 16 e2e --port 5433 && pg_ctlcluster 16 e2e start
  PW="$(openssl rand -hex 24)"
  sudo -u postgres psql -p 5433 -c "create role e2e login superuser password '$PW'"
  export E2E_RESOLVER_PG_URL_BASE="postgres://e2e:$PW@127.0.0.1:5433"
  ```

## Run

```bash
cd integrations/supabase-edge/e2e
export SUPABASE_CLI=/path/to/supabase E2E_WORK=/some/private/dir   # default: $TMPDIR/idr-supabase-e2e
E2E_IMAGE_MIRROR=mirror.gcr.io ./stack.sh pull    # only if the CLI cannot pull its images itself
./stack.sh up                                      # ~20 s once the images are present
node run.mjs                                       # ~1 min; PASS/FAIL per check; exit 1 on any FAIL
./stack.sh down                                    # stops the stack, deletes its volumes and network
```

`run.mjs` can be re-run on the same stack: it drops and re-applies the
projection SQL and recreates the resolver database each time. It writes
`results.md`, `results.json`, `resolver.log` and the offline function bundle
into `E2E_WORK`.

| variable | default | meaning |
| --- | --- | --- |
| `E2E_WORK` | `$TMPDIR/idr-supabase-e2e` | work directory (mode 700): generated secrets, the generated Supabase project, results |
| `SUPABASE_CLI` | `supabase` | Supabase CLI binary |
| `E2E_RESOLVER_PG_URL_BASE` | (required) | superuser URL of the dedicated cluster, without a database part |
| `E2E_DOCKER_NETWORK` | `idr_e2e_net` | docker network created with `host_binding_ipv4=127.0.0.1` |
| `E2E_PROXY_PORT` | `54380` | fault proxy port (on the network's gateway address) |
| `E2E_RESOLVER_PORT` | `54390` | resolver port (127.0.0.1) |
| `E2E_IMAGE_MIRROR` | (none) | registry mirror for `stack.sh pull` |

## What `stack.sh up` does

1. Generates, once per work directory, the stack's JWT secret, the function's
   shared secret, the resolver's reporting and website tokens and two IP HMAC
   secrets (`secrets.env`, mode 600). Nothing is printed or committed.
2. Creates the docker network with `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`
   and starts the stack on it (`supabase start --network-id`), so every
   published port binds to 127.0.0.1. Without that option the CLI publishes
   ports, including the database's, on all interfaces.
3. `supabase init` in `E2E_WORK/project`, then `lib/configure-project.mjs`:
   unused services off (realtime, studio, storage, SMTP, analytics), `[auth]
   jwt_secret` from the environment, `enable_signup = false`, and the adapter's
   own `supabase/config.toml` merged in (`verify_jwt = false`), as SETUP.md asks.
4. Copies `supabase/functions/idr-sync/index.ts` and `src/core/*.ts` so the
   relative import resolves (SETUP.md step 3) and writes the function secrets
   to `supabase/functions/.env` (mode 600). `IDR_ALLOW_INSECURE_HTTP=true`
   because both the resolver URL and the stack's own `SUPABASE_URL`
   (`http://kong:8000`) are plain HTTP here.
5. Applies `sql/0001_idr_projection.sql` with `psql -f` as `postgres` (SETUP.md step 1).

## What `run.mjs` checks

Each scenario prints one line per check; RESULTS.md lists them all.

- **S0** setup: projection SQL applied, service_role RPC through PostgREST,
  versions, and an offline (`--network none`) eszip bundle of the function
  containing exactly the entry point and the seven `src/core` modules.
- **S2** function authentication: a missing, wrong or partial shared secret, a
  wrong method, or the platform keys instead of the secret all get an empty
  401, and no request reaches the resolver.
- **S1** authenticated sync: projection equals the feed, cursor persisted,
  summary-only response; the reporting token is required (stripped or website
  token: `auth_failed`, nothing written).
- **S3** replay/idempotency: same cursor, a stale cursor, voluntary
  `idr_begin_resync` (re-check then replay), three concurrent invocations, and
  five concurrent `idr_apply_feed_page` calls with one expected cursor.
- **S4** tombstones: `ops:erase-company`; the tombstone follows the company's
  observations; re-observation gets a new company id; replay is idempotent.
- **S5** interruption: SIGKILL of the Edge Runtime with page 3 in flight;
  PostgREST backend terminated during an apply; the function killed while its
  apply waits (the orphaned apply still commits); an apply blocked past the
  PostgREST role's statement timeout.
- **S6** continuity gap: a stalled consumer, the resolver's own `ops:prune`
  (`OBSERVATION_RETENTION_DAYS=1`, run with its clock moved to boundary + 1
  day by `lib/clock-preload.mjs`; the delete is the resolver's statement, so
  the 0006 watermark trigger and 0007 guards apply), 410, exactly one
  `idr_sync_gaps` row, append-only, `idr_begin_resync`, drain, resolution;
  the voluntary-resync re-check (410 recorded without halting); and R3-A:
  after rotating the resolver's `IP_HMAC_SECRET`, 400, reset, the first replay
  page is sent once (no retry), later pages retry normally.
- **S7** RLS through PostgREST with real GoTrue tokens: anon (legacy key and
  publishable key), a forged token, a user without the claim, a user who set
  `user_metadata.idr_reader` themselves, a reader with `app_metadata.idr_reader`
  (read only, every write and RPC refused), revocation, and the function and
  table ACLs from the catalog.
- **S8** the scheduled path: `sql/schedule.example.sql`'s job body with Vault
  secrets, run by `pg_cron` every 10 s through `pg_net`.

## Safety

- Local only. Published ports bind to 127.0.0.1; the resolver binds to
  127.0.0.1. The only other listener is the fault proxy on the docker network's
  gateway address (a host-only bridge address), which the function container
  needs to reach the host.
- Secrets are generated at runtime into `E2E_WORK` (mode 700/600) and never
  printed; results contain counts and statuses, never cursors, tokens or data.
- Synthetic data only: the resolver's mock provider with RFC 5737 / RFC 3849
  documentation addresses; user e-mails are random `@example.test` addresses.

## Starting again after a restart of the machine

```bash
dockerd &                                   # if the daemon is not a service
pg_ctlcluster 16 e2e start                  # the resolver's cluster
cd integrations/supabase-edge/e2e && ./stack.sh up && node run.mjs
```
