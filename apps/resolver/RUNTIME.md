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
  whose cursor falls behind the buffer must resynchronise (it has missed
  data). Shorter is better for privacy; longer is safer for sync. The owner
  has not accepted any fixed default, so the service refuses to start until
  one is set. Pruning is not erasure and produces no tombstones; companies
  and per-company scope statistics are never pruned.
* `PROVIDER_MODE=mock` is refused when `NODE_ENV=production` unless
  `ALLOW_MOCK_PROVIDER=true` (the isolated development deployment, D7).
  Paid enrichment stays off unless `PROVIDER_MODE=live` and
  `ENRICHMENT_ENABLED=true`.
* Removed variables are refused rather than silently ignored:
  `MAX_CONCURRENT_CHILDREN` (use `MAX_CONCURRENT_JOBS`),
  `CHILD_HARD_KILL_GRACE_MS` and `RUN_MIGRATIONS_ON_START`.

## Migrations

Migrations never run on application start. They run as the deploy
pre-step (`railway.json` `preDeployCommand: node dist/db/migrate.js`,
advisory-locked, forward-only; locally `npm run migrate`). At startup the
service compares `migrations/*.sql` with `schema_migrations` and **refuses to
start** while any migration of this build is not applied, naming the missing
files. A database that is ahead of the build (a rollback) is reported in the
`migration_check` log line but not refused.

## Health

* `GET /healthz`: liveness, always 200 while the process serves HTTP.
* `GET /readyz`: 200 only when the database answers and a job slot is free;
  503 during shutdown.

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
  in that window is committed to the cache, and a delayed observation write
  may still land, so `recorded: false` means "not confirmed", never "not
  recorded".
