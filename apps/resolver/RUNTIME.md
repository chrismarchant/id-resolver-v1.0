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
  and per-company scope statistics are never pruned. How to choose the value,
  what pruning does and does not remove, and erasure:
  [docs/RETENTION.md](../../docs/RETENTION.md) (operational justification,
  not legal advice, pending owner/legal confirmation).
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

## Hosting ranges

Cloud providers and search crawlers publish the network ranges of their own
servers. A visit from one of those ranges comes from a server, not from a
person at a company, and when Enrich finds a domain for it, it is the host's
(usage type `DCH` or `SES`) and is excluded after a charged lookup.
`HOSTING_RANGES_MODE` checks the address against those lists first, right
after the private-address check and before the cache, the charge slot and
the provider call:

| mode | effect |
| --- | --- |
| `off` (default) | the list is not loaded; nothing changes |
| `shadow` | a match is logged and the lookup goes ahead: `job_finished` and `provider_outcome` carry `hosting_range` (the provider's name, e.g. `aws`) |
| `enforce` | a match is answered `excluded` (reason `ip_hosting_range`) with no cache read, no reservation and no provider call |

Every `provider_outcome` for a found domain also carries `usage_type`, the
network type Enrich reported (`COM`, `ISP`, `DCH`... or `none`), whatever the
mode. Neither field holds the address, the domain or the company name.

**Reading shadow results.** In the Railway logs, filter
`@event:provider_outcome`. Lookups with `hosting_range` set are the ones
`enforce` would have skipped; `outcome: resolved` among them were charged.
Their `usage_type` shows what Enrich made of them: `DCH`, `CDN` or `SES`
confirms the match, while `COM` or another qualifying type would have been a
company that `enforce` turns away. Switch to `enforce` only when the second
group is empty or acceptable.

**The list.** `data/hosting-ranges.json` is in the image; nothing is
downloaded at run time. It holds, per provider: AWS (EC2), Google Cloud,
Azure (`AzureCloud`), Oracle Cloud, DigitalOcean, Googlebot and Bingbot,
each from the provider's own published list. Ranges are merged and kept to
IPv4 /8-/28 and IPv6 /16-/64 (smaller pieces are dropped). The service checks
the file at start-up whenever the mode is not `off` and refuses to start if
it is damaged; `config_loaded` logs `hosting_ranges_mode` and
`hosting_ranges_date`.

**Refreshing it.** `node apps/resolver/scripts/update-hosting-ranges.mjs`
(from the repository root) downloads the lists and rewrites the file only
when a prefix changed. It stops without writing if a download fails or a
provider would lose more than half its IPv4 coverage (`--accept-shrink`
after checking the provider's announcement). The `hosting-ranges` workflow
runs it every Monday and opens a pull request when something changed; a
refresh reaches production only through review, merge and redeploy. A list a
few weeks old just means some newer cloud ranges are looked up as before.

The public-safety gate exempts exactly this file's single-prefix lines
(`PUBLISHED_RANGE_FILES` in `scripts/check-public-safety.mjs`): the bounds
mean no line can name a single address.

## Database TLS

`DATABASE_SSL` governs **every** database connection: the service pool,
`node dist/db/migrate.js` and every `ops:*` command (all go through
`createPool`, `src/db/pool.ts`; the policy is `resolveDatabaseTls` in
`src/config/index.ts`, the mechanics are in `src/db/tls.ts`). TLS parameters
inside `DATABASE_URL` (`sslmode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`,
`sslnegotiation`, `uselibpqcompat`, ...) are stripped, so the URL can neither
weaken nor redirect TLS.

| `DATABASE_SSL` | Encrypted | Verified | Production (`NODE_ENV=production`, the default) |
|---|---|---|---|
| `verify-pinned` | yes | the server's leaf certificate has a SHA-256 fingerprint listed in `DATABASE_TLS_PIN_SHA256` (one, or two during a rotation); with `DATABASE_CA_CERT` also the chain and the validity period. The host name is not checked. | allowed (the target for the Railway PostgreSQL template) |
| `require` (default) | yes | chain to the system CAs, or to `DATABASE_CA_CERT` when set, **and** the host name | allowed |
| `no-verify` | yes | nothing (encrypted, not authenticated) | **refused** unless `ALLOW_UNVERIFIED_DATABASE_TLS=true` (development deployment only; a `config_override` warning is logged at every start) |
| `disable` | no | — | **refused**, also with the override; local development and tests only (`NODE_ENV=development` or `test`) |

`DATABASE_TLS_PIN_SHA256` with a mode other than `verify-pinned`, and
`DATABASE_CA_CERT` with `no-verify` or `disable`, are refused rather than
ignored. Errors name variables only.

**Why a pin.** The Railway `postgres-ssl` template creates its own root CA
(`CN=root-ca`) and a server certificate (`CN=localhost`, SAN `DNS:localhost`
and, in recent template versions, the private host name) on the data volume
at first start. It chains to nothing public, so `require` fails without the
template's CA, and the host name may not be in it. Pinning the exact leaf
certificate needs neither: only a server holding that certificate's private
key can complete the handshake. The cost: the pin changes whenever the
certificate is regenerated (rotation, below). If the certificate's SANs
include the private host name, `require` with `DATABASE_CA_CERT` set to the
template's `root.crt` is an equivalent alternative (full host-name check);
the template regenerates that CA together with the leaf, so it needs the same
rotation.

**How the pin is enforced.** Node calls a `checkServerIdentity` override only
after the chain verified, so for a self-signed certificate it is never
called, even with `rejectUnauthorized: false`: a pin check there would accept
any certificate. Instead the service hands node-postgres its own socket
(`PinnedTlsSocket`, node-postgres's `stream` option, node-postgres TLS off):
it sends the SSLRequest, completes the handshake, compares the leaf
fingerprint with the pins (constant-time) and only then lets node-postgres
start. On a mismatch not one protocol byte (no startup message, user name or
password) is sent; the connection fails with `DB_TLS_PIN_MISMATCH`. A server
that answers the SSLRequest with anything but a single `S` is refused
(`DB_TLS_REFUSED` / `DB_TLS_PROTOCOL`). With `DATABASE_CA_CERT`, OpenSSL also
verifies the chain and validity (`DB_TLS_VERIFY_FAILED`). In pin-only mode
the validity period is not enforced: an expired but pinned certificate still
proves possession of the pinned key; renew it before it expires (the template
regenerates it at a restart within 30 days of expiry, which changes the pin).

At startup a failed verification exits 1 with `database TLS verification
failed (<code>): check DATABASE_SSL, DATABASE_TLS_PIN_SHA256 and
DATABASE_CA_CERT`. While running, existing connections stay up and new ones
fail closed: requests answer `unavailable` and `/readyz` turns 503 until the
pin is corrected.

### Discovering the fingerprint

```
node dist/ops/db-tls-fingerprint.js      # in the service (Railway: railway ssh into id-resolver)
npm run ops:db-tls-fingerprint           # locally
```

It reads only the host and port of `DATABASE_URL`, performs the SSLRequest
and an **unverified** TLS handshake, and closes: it never sends the startup
message, so no user name, password or database name leaves the process and
nothing is read from the database. It prints one JSON object: `sha256` (the
value for `DATABASE_TLS_PIN_SHA256`), `subject_cn`, `subject_alt_names`,
`valid_from`, `valid_to`, and `matches_configured_pin` when
`DATABASE_TLS_PIN_SHA256` is set. Errors print a fixed code only.
`subject_alt_names` may contain the private host name: keep the output in
private notes, never in this repository.

**Trust on first use.** The first reading is only as trustworthy as the path
it was read over. Run it inside the service, over the private network (which
Railway encrypts between services), never through a public TCP proxy, and
confirm it with a second, independent reading taken on the database's own
volume (Railway shell of the PostgreSQL service):
`openssl x509 -noout -fingerprint -sha256 -in /var/lib/postgresql/data/certs/server.crt`
(the colon-separated value after `=` is accepted as a pin as is).

### Rotation (two pins)

`DATABASE_TLS_PIN_SHA256` takes `current,next` for the window in which the
server may present either certificate:

1. Obtain the next certificate's fingerprint (planned renewal: from the new
   `server.crt` on the volume before it is activated; unplanned: the
   template already switched, see below).
2. Set `DATABASE_TLS_PIN_SHA256=<current>,<next>` on the service (this
   redeploys; migrate and the service accept either certificate).
3. Activate the next certificate (`SELECT pg_reload_conf()` as the owner
   after the files were replaced, or a restart of the PostgreSQL service).
4. Confirm with the helper (`matches_configured_pin: true`, new `sha256`),
   then set `DATABASE_TLS_PIN_SHA256=<next>`.

Unplanned regeneration (the template restarted within 30 days of expiry, or
the volume was replaced): new connections fail closed. Take both readings
above, set the new pin, redeploy. Put `valid_to` minus 45 days in the
operations calendar to keep renewals planned.

## Database roles

Two PostgreSQL roles (Gate 5; `src/db/runtime-role.ts`):

| Role | Credentials | Used by | Can |
|---|---|---|---|
| **owner** | `DATABASE_URL` | `node dist/db/migrate.js` (the pre-deploy step) and every `ops:*` command | everything: owns every object, runs DDL |
| **runtime** (`DATABASE_RUNTIME_ROLE`, default `idr_runtime`) | `DATABASE_URL` host and database, `DATABASE_RUNTIME_ROLE`, `DATABASE_RUNTIME_PASSWORD` | the service process only | exactly the grants below |

The feed guards of migrations 0006/0007 are triggers. Only the table owner
(`ALTER TABLE ... DISABLE TRIGGER`) or a superuser (`SET
session_replication_role = replica`) can bypass them, and `TRUNCATE` skips
row triggers. The runtime role has none of that, so a leaked runtime
credential cannot rewrite, silently delete or truncate feed items, write the
retention watermark (INSERT, UPDATE and DELETE on it are refused) or remove a
tombstone.

What a leaked runtime credential **can** still do to the feed (G5R2-L4): it
holds DELETE and INSERT on `company_observations`, because retention and the
entrance path need them. Deleting observations, including the newest ones,
advances the scope's watermark through the 0006 trigger (which runs as its
owner since migration 0009): every consumer whose cursor is below it then
gets `410 cursor_expired` and must resynchronise, and the deleted buffer
contents are gone from the resolver. Inserting adds observations that the
feed serves. Both are visible to consumers (a watermark move, feed items);
neither is silent.

**Runtime grants** (`RUNTIME_GRANTS`; every other privilege in the schema is
revoked on every migrate run):

| Table | Runtime privileges | Why |
|---|---|---|
| `ip_resolution_cache` | SELECT, INSERT, UPDATE, DELETE | leases, fenced commits, expiry pruning |
| `usage_periods` | SELECT, INSERT, UPDATE | cap reservation, counters |
| `companies` | SELECT, INSERT, UPDATE (`organisation_name`, `last_seen_at`) | resolution upsert, activity timestamp, the per-company lock |
| `company_observations` | SELECT, INSERT, DELETE, UPDATE (`id`) | entrances, the feed, retention; UPDATE on `id` only because `SELECT ... FOR UPDATE SKIP LOCKED` needs an UPDATE privilege, and the 0006 trigger rejects any change of `id` |
| `company_observation_refs` | SELECT, INSERT | idempotency records |
| `company_scope_stats` | SELECT, INSERT, UPDATE | activity summary |
| `browser_events` | SELECT, INSERT, DELETE, UPDATE (`id`) | events and their retention (same `FOR UPDATE` reason) |
| `feed_tombstones`, `feed_retention_watermarks`, `deployment_controls`, `schema_migrations` | SELECT | the feed, the kill-switch read, the startup schema check |
| sequences of `companies`, `company_observations`, `browser_events` | USAGE | inserts |

Not granted: TRUNCATE, TRIGGER, REFERENCES on anything; DELETE on
`companies`, `company_observation_refs`, `company_scope_stats`; any write to
`feed_tombstones`, `feed_retention_watermarks` or `deployment_controls`; CREATE
on the schema or the database; ownership; role memberships (so no `SET ROLE`
to the owner); SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS; SET on
`session_replication_role`. Temporary tables remain possible through PostgreSQL's
default PUBLIC privilege; they are private to the session and cannot touch
the guarded tables. Retention still advances the watermark because the 0006
trigger function runs as its owner (migration 0009, `SECURITY DEFINER` with a
pinned `search_path`).

**Owner-only operations.** `ops:erase-company` (writes tombstones, deletes
the company and its history) and `ops:kill-switch` (writes
`deployment_controls`) need privileges the runtime role deliberately lacks;
every ops command connects with `DATABASE_URL`. `ops:usage` and `ops:prune`
also run as the owner (one rule for every ops command); `ops:prune` deletes
through the same triggers.

**Scope of the separation.** The owner `DATABASE_URL` (on Railway the
template's superuser) is in the service's own environment, because the
pre-deploy migrate shares the service's variables; `process.env` is scrubbed
at startup but `/proc/<pid>/environ` keeps it. Role separation therefore
contains SQL-level abuse and a leaked runtime password, not a compromise of
the service process (a separate migrator service would be the structural
answer).

**Provisioning** (`node dist/db/migrate.js`, after the migrations, under the
migration advisory lock, one transaction, on every run, only when
`DATABASE_RUNTIME_PASSWORD` is set):

1. creates the role (`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
   NOREPLICATION NOBYPASSRLS NOINHERIT`), or updates it when it exists;
   refuses (the deploy fails, nothing changes) if a role of that name exists
   with an elevated attribute, a membership or owned objects: it never
   demotes a role it did not create. An existing role of that name without
   any of these is taken over (password reset, grants replaced), so
   `DATABASE_RUNTIME_ROLE` must name a role nothing else uses;
2. sets its password as a SCRAM-SHA-256 verifier computed in the migrate
   process, so the plaintext never appears in SQL text, server logs or
   `pg_stat_activity` (the verifier itself is in the statement text, so it can
   reach server logs with `log_statement = ddl`, or `pg_stat_statements`; it
   does not reveal the password);
3. revokes every privilege it holds in the schema and grants exactly the
   table above. Objects created by future migrations get their grants from
   this map, re-applied on every run (no `ALTER DEFAULT PRIVILEGES`). An
   object without an entry gets no privilege and is named in a warning;
   `test/integration/runtime-role.test.ts` fails while any object the
   migrations create has no entry;
4. removes every session default stored on the role (`ALTER ROLE ...
   RESET ALL`, for all databases and `IN DATABASE` this one). A role can set
   its own defaults, so a leaked runtime credential could otherwise make every
   later service session read-only (`default_transaction_read_only`) or
   change its timeouts or durability (G5R2-L3); the service's session settings
   live in code (`src/db/pool.ts`), never on the role;
5. checks the result is least privilege (fails otherwise, e.g. CREATE on
   `public` granted to PUBLIC on PostgreSQL 14 and older).

The owner needs CREATEROLE (or superuser, as on Railway) for step 1.
Changing `DATABASE_RUNTIME_PASSWORD` rotates the password at the next deploy:
the pre-deploy migrate sets it before the new service instance starts.
Connections the old instance already holds stay open until it stops; any new
connection it opens after the migrate fails authentication.

**Startup.** With `DATABASE_RUNTIME_PASSWORD` set the service logs in as the
runtime role and checks its own login (`database_role_check`): it refuses to
start (exit 1, naming the excess, e.g. `owns_objects`, `superuser`) if the
login can do anything listed under "Not granted", or if the role carries
session defaults for all databases or this one (`role_settings`, set after
the last migrate run, e.g. with a leaked credential; a redeploy runs the
migrate step, which resets them). The runtime role can also change its own
password: new connections then fail authentication until the next migrate
run sets it again. A wrong password exits 1
with `database authentication failed (28P01)` and a hint that the pre-deploy
migrate must have run with the same value. Without `DATABASE_RUNTIME_PASSWORD`
the service logs in as the owner: refused when `NODE_ENV=production` unless
the dev-only `ALLOW_OWNER_DATABASE_ROLE=true` is set (a `config_override`
warning on every start). `config_loaded` reports `db_role: runtime|owner`.

**Configuration matrix.**

| Deployment | `DATABASE_SSL` | TLS variables | Role variables | Overrides |
|---|---|---|---|---|
| Production | `verify-pinned` (or `require` with a CA-issued certificate) | `DATABASE_TLS_PIN_SHA256` (optional `DATABASE_CA_CERT`) | `DATABASE_RUNTIME_PASSWORD` (sealed), optional `DATABASE_RUNTIME_ROLE` | none |
| Development (Railway), target | `verify-pinned` | `DATABASE_TLS_PIN_SHA256` | `DATABASE_RUNTIME_PASSWORD` (sealed) | `ALLOW_MOCK_PROVIDER` only |
| Development (Railway), transitional | `no-verify` | — | none | `ALLOW_UNVERIFIED_DATABASE_TLS=true`, `ALLOW_OWNER_DATABASE_ROLE=true` (both logged on every start; remove them; steps in `docs/RAILWAY_IAC.md`) |
| Local development / tests | `disable` with `NODE_ENV=development` or `test` | — | optional | — |

`NODE_ENV` must stay `production` (the image's default) on every deployed
service: `development` or `test` silently switches off all three production
refusals (`disable`, unverified TLS, the owner login), and `config_loaded`
does not report `NODE_ENV`.

**Rollback.** The previous build (no role separation) connects as the owner
with `DATABASE_URL`, which still works: migration 0009 changes no table,
the owner keeps every privilege, and a build that does not know 0009 reports
the database as ahead (`migration_check`) instead of refusing. Leaving the
runtime role in place is harmless; to remove it, as the owner: `DROP OWNED BY
idr_runtime; DROP ROLE idr_runtime;` (after no build uses it).

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
* **Smoke run** (`src/ops/smoke.ts`, operator guide `docs/DEV_SMOKE.md`).
  With `EVENTS_ENABLED=true` it checks ingestion, idempotency, the
  rejections, the consent policy, that responses carry no address, and,
  read-only in the database, that only the run's `browser_events` rows were
  written and nothing on the company side. With events off it checks that
  `POST /v1/events` is byte-identical to an unknown route.

## Migrations

Migrations never run on application start. They run as the deploy
pre-step (`node dist/db/migrate.js`, the service's pre-deploy command in
`.railway/railway.ts`; advisory-locked, forward-only; locally `npm run
migrate`), as the owner (`DATABASE_URL`), and then provision the runtime role
(see "Database roles"). At startup the
service compares `migrations/*.sql` with `schema_migrations` and **refuses to
start** while any migration of this build is not applied, naming the missing
files. A database that is ahead of the build (a rollback) is reported in the
`migration_check` log line but not refused. Rolling the development
deployment back to a build before migration 0008 is verified from its logs and
the public edge, optionally with the current smoke's `--mode rollback-check`
(`docs/DEV_SMOKE.md`).

Feed immutability (migration 0007, CHR-66 F5): the database refuses any
UPDATE of a served observation column, any UPDATE or DELETE of an erasure
tombstone, TRUNCATE of `company_observations`, `feed_tombstones` or
`feed_retention_watermarks`, and any DELETE or backward move of the retention
watermark. Observations leave the feed only by DELETE (retention, erasure,
cascades, manual statements), which the watermark or a tombstone always
makes visible to consumers. The only bypass is
`SET session_replication_role = replica` (superuser-only, or an explicit
`GRANT SET` on that parameter) or disabling triggers as the table owner:
these are out-of-band operations, used by the test reset only, and the
runtime role the service uses can do neither (see "Database roles"). Never use
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
