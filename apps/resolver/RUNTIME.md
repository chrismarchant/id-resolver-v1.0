# Resolver runtime

Operator reference for the resolver service (`apps/resolver`). Owner
decisions D1 (single-process runtime, CHR-70), D2 (identification only) and
D3 (bounded observation retention) apply.

## Process model

One Node.js process serves the HTTP API and runs every resolution job
in-process. There are no child processes: the V0.1 fork-per-request model
(supervisor + one forked child per request) is gone, and no service module
forks or spawns anything (asserted by `test/unit/runner.test.ts`).

```
POST /v1/entrances ─▶ auth ─▶ strict schema ─▶ website_id ─▶ ip syntax ─▶ occurred_at ±300 s
                   ─▶ runner (semaphore, deadline) ─▶ pipeline (cache, kill switch, cap, provider, commit, observation)
                   ◀─ { version, status, source, recorded }   (never company data, D2)

POST /v1/events (only when EVENTS_ENABLED=true; see "Browser events")
                   ─▶ auth ─▶ strict schema + vocabulary ─▶ website_id ─▶ occurred_at ±300 s ─▶ consent policy
                   ─▶ one INSERT into browser_events (never the runner, cache, company tables or provider, D4)
                   ◀─ { version, recorded }
```

Entry point: `node dist/main.js` (Dockerfile `CMD`; `npm start`; `npm run dev`
runs `src/main.ts` through tsx). The image entrypoint
(`scripts/entrypoint.sh`) sets `ulimit -c 0` and refuses inspector, profiler,
diagnostic-report flags and `NODE_DEBUG` before `exec`.

## Controls

| Control | Mechanism | Setting |
|---|---|---|
| Per-request deadline | `AbortController` per job, aborted at the deadline; the runner answers `unavailable/deadline_exceeded` then; the HTTP layer keeps an independent deadline race. The pipeline stops at its next checkpoint, aborts an in-flight provider call and never starts the observation write after the abort. A provider answer already received is still committed to the cache (fenced), so a paid call is not wasted. | `REQUEST_DEADLINE_MS` |
| Provider timeout | `AbortSignal.timeout`, bounded by the lease and the deadline, combined with the job's abort signal | `ENRICH_TIMEOUT_MS` |
| Database bounds | server `statement_timeout` 3 s, plus a client-side query timeout (statement timeout + 1 s) because there is no child process left to kill; a failed transaction discards its connection; migrations use their own 120 s bound | fixed |
| Concurrency | synchronous semaphore; one job more is refused with `503 overloaded`; `/readyz` answers 503 while every slot is taken. A slot is freed only when the job settles, so a job overrunning its deadline still counts | `MAX_CONCURRENT_JOBS` (1–64, default 8) |
| Per-job crash containment | each job runs in its own try/catch; a throw, rejection or malformed outcome becomes `unavailable/internal_error`; outcomes are rebuilt from an allowlist; error text is never logged | — |
| Process crash containment | `unhandledRejection` / `uncaughtException` log the fixed event `process_fatal{category}` and exit 70; the platform restarts the service (`restartPolicyType: ON_FAILURE`) | — |
| Stuck jobs | a job still running 30 s after its deadline (every operation inside it is bounded far below that) logs `job_stuck` and is treated as fatal (exit 70) | fixed |
| Event-loop watchdog | a worker thread watches a heartbeat from the main loop; when the loop has been blocked longer than the threshold it writes `event_loop_blocked` to stdout and kills the process with SIGKILL (exit status 137; never a core-dumping signal) | `EVENT_LOOP_BLOCK_EXIT_MS` (1000–60000, default 10000) |
| Graceful shutdown | SIGTERM/SIGINT: stop accepting (requests during close get `503 not_ready`), answer in-flight requests, drain executing jobs and tracked background writes, close the pool, exit 0; hard exit 1 after `SHUTDOWN_GRACE_MS` + 2 s | `SHUTDOWN_GRACE_MS` (≥ `REQUEST_DEADLINE_MS` + 500) |
| IP and secret hygiene | the raw IP exists only in memory for the request; the per-job HMAC key and fingerprint Buffers are zeroed after use; logs pass a fixed event/field allowlist with IP and bearer redaction; secrets are removed from `process.env` once the configuration is loaded | — |

The database pool is shared by all jobs: `2 × MAX_CONCURRENT_JOBS + 4`
connections at most (the V0.1 worst case).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | graceful stop |
| 1 | refused to start (configuration, pending migrations, database unreachable) or shutdown overran its grace period |
| 70 | `process_fatal`: unhandled rejection, uncaught exception or stuck job |
| 137 | killed by the event-loop watchdog (`event_loop_blocked`) |

## Configuration

Validated with explicit bounds at startup (`src/config/index.ts`); errors
name variables, never values. See `.env.example` for every variable.

* **`OBSERVATION_RETENTION_DAYS` is required, 1–365, with no default (D3).**
  The resolver keeps company observations only as a bounded
  synchronisation buffer for the client's Insights environment, which owns
  commercial history. Choose a value that **exceeds the longest Insights
  sync outage you are prepared to tolerate**: observations older than the
  window are pruned whether or not Insights has pulled them, and a consumer
  whose cursor falls behind the buffer gets `410 cursor_expired`, a
  potential continuity gap: it must record it, alert and resynchronise,
  and the pruned observations are not recoverable from the resolver. Shorter is better for privacy; longer is safer for sync. The owner
  has not accepted any fixed default, so the service refuses to start until
  one is set. Pruning is not erasure and produces no tombstones; companies
  and per-company scope statistics are never pruned.
* **Maintenance run** (`src/runtime/maintenance.ts`). Deletes expired cache
  rows (IP fingerprints past their TTL), and observations and browser events
  older than the retention window. It runs once at startup (after the server
  listens, not blocking it) and then every `CACHE_PRUNE_INTERVAL_S` (default
  600 s); runs never overlap. A run drains: it repeats batches of
  `CACHE_PRUNE_BATCH` rows (one statement each) until a batch comes back
  short, within `CACHE_PRUNE_BUDGET_MS` (default 20 s; expired cache rows may
  use half of it, browser events then up to a quarter but never past three
  quarters of it, observation retention gets the rest, at least the last
  quarter). A deadline stops a phase from starting another batch; a single
  batch already running can overrun it. Only one that runs past three
  quarters of the budget eats into the observations' quarter, and the run
  then reports the backlog. Each run logs `maintenance_run{cache_rows,
  observation_rows, event_rows, backlog, duration_ms}`; a run that stops with
  rows still due (budget spent, shutdown or a database error) also logs the
  warning `maintenance_backlog{reason, category}`, where `category` names the
  kinds left due (`cache`, `observations`, `events`, joined with `_and_`). Alert on
  repeated `maintenance_backlog`: the buffer is then growing faster than it
  is pruned; raise the batch size or the budget. On shutdown a running drain
  stops after its current batch.
* `PROVIDER_MODE=mock` is refused when `NODE_ENV=production` unless
  `ALLOW_MOCK_PROVIDER=true` (the isolated development deployment, D7).
  Paid enrichment stays off unless `PROVIDER_MODE=live` and
  `ENRICHMENT_ENABLED=true`.
* Removed variables are refused rather than silently ignored:
  `MAX_CONCURRENT_CHILDREN` (use `MAX_CONCURRENT_JOBS`),
  `CHILD_HARD_KILL_GRACE_MS` and `RUN_MIGRATIONS_ON_START`.

## Browser events (CHR-64)

Contract `event.v1` (`docs/contracts/event.v1.md`), owner decision D4:
browser events are **never** associated with companies.

* **Off by default.** `POST /v1/events` exists only when
  `EVENTS_ENABLED=true` (default `false`). Otherwise it is an unknown route:
  `404 not_found` with the website credential, `401` without, the same answer
  as any other unknown path, whatever the body. `EVENTS_ENABLED=true` with no
  event store refuses to build the server.
* **Requests.** The website credential only (the reporting credential gets
  `401`), checked before the body is parsed. Strict schema: any field beyond
  `contract, website_id, event_id, occurred_at, type, name, page_key,
  consent` is `400`, so no IP, user agent, referrer, cookie, session,
  visitor or company field can be accepted. `type`/`name` must be a pair of
  the vocabulary embedded in `src/contracts/event.ts` (the only copy; a test
  keeps it equal to `docs/contracts/event-vocabulary.v1.json`). `page_key`
  follows the entrance rule, `occurred_at` must be within 300 s of resolver
  time, `website_id` must match (`403 forbidden`).
* **Consent.** `EVENT_CONSENT_MODE=required` (default) refuses
  `consent: not_required` with `403 consent_required`; `not_required` accepts
  both values and stores what was asserted.
* **Storage and idempotency.** One `INSERT ... ON CONFLICT DO NOTHING` into
  `browser_events` (migration 0008): `200 {version, recorded: true}` for a new
  `event_id`, `recorded: false` for a repeat (the first write wins). The table
  has no company, address, fingerprint or observation column, no foreign key
  and no trigger, and `origin` is always `browser`. Events are not part of
  `reporting-feed.v1`.
* **Isolation (D4).** The route and the event repository read and write
  `browser_events` only; they never reach the runner, the fingerprint cache,
  the company or activity tables or the provider, and import none of them.
  `test/integration/events-isolation.test.ts` proves it with a statement spy
  over the shared pool, a database role limited to `browser_events`, and an
  import and code scan.
* **Limits.** The same body limit. A separate `events` rate-limit bucket,
  bounded by `RATE_LIMIT_PER_MINUTE` like the reporting bucket: event volume
  follows public page activity and must never exhaust the bucket entrance
  resolution depends on. At most 4 inserts in flight (`503 overloaded` beyond
  that); when enabled the pool grows by the same 4 connections, so event
  writes never take one the resolution jobs are sized for. A database failure
  answers `503 not_ready` (retrying the same `event_id` is safe).
* **Retention.** Rows older than `OBSERVATION_RETENTION_DAYS`, by the
  resolver's `received_at`, are deleted by the maintenance run (above) and by
  `npm run ops:prune`, also while events are disabled. This never moves the
  feed's retention watermark or writes a tombstone.
* **Logging.** Only `request_completed{route, http_status, recorded,
  duration_ms}` and `request_rejected{route, error_code, http_status,
  reason}`; never the `event_id`, `page_key`, type, name, body or headers.
  `config_loaded` reports `events_enabled` and `event_consent_mode`.
* **Not covered by the smoke run** (`src/ops/smoke.ts`), which checks
  entrances and the feed only.

## Migrations

Migrations never run on application start. They run as the deploy
pre-step (`railway.json` `preDeployCommand: node dist/db/migrate.js`,
advisory-locked, forward-only; locally `npm run migrate`). At startup the
service compares `migrations/*.sql` with `schema_migrations` and **refuses to
start** while any migration of this build is not applied, naming the missing
files. A database that is ahead of the build (a rollback) is reported in the
`migration_check` log line but not refused.

Feed immutability (migration 0007, CHR-66 F5): the database refuses any
UPDATE of a served observation column, any UPDATE or DELETE of an erasure
tombstone, TRUNCATE of `company_observations`, `feed_tombstones` or
`feed_retention_watermarks`, and any DELETE or backward move of the retention
watermark. Observations leave the feed only by DELETE (retention, erasure,
cascades, manual statements), which the watermark or a tombstone always
makes visible to consumers. The only bypass is
`SET session_replication_role = replica` (superuser-only, or an explicit
`GRANT SET` on that parameter) or disabling triggers as the table owner:
these are out-of-band operations, used by the test reset only. Never use
them on a live deployment except as documented break-glass maintenance, and
then make every feed consumer resynchronise.

## Health

* `GET /healthz`: liveness, always 200 while the process serves HTTP.
* `GET /readyz`: 200 only when the database answers and a job slot is free;
  503 during shutdown. The probe is unauthenticated and not rate limited, so
  its database ping is cached for 1 s and single-flight (CHR-66 F6): however
  many probes arrive, at most one ping is in flight and at most one starts
  per second, so a probe flood cannot take connections from entrance jobs or
  the feed. A database failure therefore shows within about 1 s plus the
  ping's own 1 s timeout; the job-slot check is made on every request.

## Residual risks of the single-process model

These are accepted by D1 and listed for the independent review (CHR-66):

* **Shared fate.** A fatal fault, the watchdog or a stuck job ends every
  in-flight request at once (the website's adapter is non-blocking, so
  pages are unaffected; those identifications are lost).
* **Shared heap.** V0.1 capped each child's heap; now all jobs share one
  heap (`NODE_OPTIONS=--max-old-space-size=256` in the image). A memory leak
  or a pathological allocation affects every job and ends in an
  out-of-memory exit.
* **Blocked loop window.** A synchronous stall delays every request until
  the watchdog fires (`EVENT_LOOP_BLOCK_EXIT_MS`), not just one request.
* **Memory residency.** Secrets live in the one process's memory for its
  lifetime (as they did in the V0.1 supervisor); JavaScript strings holding
  a request IP cannot be zeroed and stay until garbage-collected. Core dumps
  are disabled best-effort (`ulimit -c 0`; the host controls core_pattern).
  `/proc/<pid>/environ` keeps the start-up environment; removing secrets
  from `process.env` does not change it.
* **Work after the answer.** A job that overruns its deadline keeps running
  (bounded) after the caller got `unavailable`: a provider result received
  in that window is committed to the cache. An observation write that has
  started is never cancelled (CHR-66 F4): when it outlives its budget the
  caller gets `qualified` with `recorded: false`, and the write may still
  commit afterwards, after which the reporting feed serves it. So
  `recorded: false` means "not confirmed within the deadline", never "not
  recorded" (`docs/contracts/entrance.v1.md`); retrying the same
  `entrance_id` never adds a second observation.
