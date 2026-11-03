# Insights sync: client provisioning (Supabase Edge reference)

Reusable reference for pulling the ID Resolver reporting feed
(`docs/contracts/reporting-feed.v1.md`) into a client's own Supabase project.
Nothing here is client-specific: every value below is a placeholder you fill
in when provisioning a client. The Edge Function **pulls** from the resolver;
the resolver never pushes and holds no client credentials.

Interpretation (show it wherever the data is displayed): an entrance is not a
visitor or a session, and activity after outreach is temporal association, not
causation.

## Prerequisites

- A Supabase project for the client, with extensions `pg_cron`, `pg_net`, `supabase_vault`.
- The resolver base URL `https://<resolver-host>` (https required) and its read-only
  reporting token (`REPORTING_AUTH_TOKEN` on the resolver; the website token is rejected).
- The resolver's installation id `<installation-id>` (the feed's `scope.installation_id`;
  the function refuses pages for any other installation).
- Supabase CLI, logged in.

## 1. Apply the SQL

Run `sql/0001_idr_projection.sql` against the project (see "How to apply it" below). It is idempotent (re-run it to upgrade an
existing project, keeping every row: it adds `idr_sync_gaps` and the `idr_sync_state` columns
`resync_requested_at`, `reset_from_cursor` and `drained_generation`, and replaces `idr_apply_feed_page`
(now with a sixth argument, `p_drained`) and `idr_record_sync_gap` with new signatures, so re-run the
SQL and redeploy the function together; until both are done the function answers `schema_mismatch`
and writes nothing). It creates the
projection tables, the append-only `idr_sync_gaps` log, the `idr_daily_company_activity` view and the `idr_*` functions, enables
RLS on every table (no `anon` access; `authenticated` read-only and only with the `idr_reader` claim, see below) and grants function
execution to `service_role` only. Privileges are exact (CHR-66 G4-L4): Supabase's default privileges grant
`ALL` on every new table, view, sequence and function in `public` to `anon`, `authenticated` and
`service_role`, so the script first revokes everything from those roles (and `PUBLIC`) on each `idr_*`
object, then grants only this:

| role | `idr_companies`, `idr_observations`, `idr_tombstones`, `idr_sync_state` | `idr_sync_gaps` | `idr_daily_company_activity` (view) | `idr_*` functions |
| --- | --- | --- | --- | --- |
| `anon` | nothing | nothing | nothing | nothing |
| `authenticated` | `SELECT` (rows only with the `idr_reader` claim) | `SELECT` (claim) | `SELECT` | nothing |
| `service_role` | `SELECT` | `SELECT` | `SELECT` | `EXECUTE` (not on the trigger function `idr_sync_gaps_guard`) |

`service_role` writes **only through the functions** (CHR-66 R2-8). The six that write
(`idr_apply_feed_page`, `idr_record_sync_status`, `idr_reset_cursor`, `idr_begin_resync`,
`idr_record_sync_gap`, `idr_resolve_sync_gaps`) are `SECURITY DEFINER`: they run as the owner of the
tables (the role that applied the script), with an empty `search_path`, no dynamic SQL and
validated arguments, and only `service_role` may execute them. So a holder of the service-role key
cannot insert a gap row, mark one resolved, or change `needs_resync`, the generations,
`reset_from_*` or `drained_generation` directly; the state machine described under "`needs_resync`
and `idr_sync_gaps`" is the only way. A change by hand (for example deleting projection rows) must
be made as the owner in the SQL editor; remember that a replay may restore rows the feed still
holds.

No role but the owner keeps `TRUNCATE`, `REFERENCES`, `TRIGGER` or `MAINTAIN` on any `idr_*` table, write
access to the view, or any privilege on the `idr_sync_gaps` id sequence (an identity column needs none).
Re-running the script on an existing project removes those privileges there too.

### How to apply it

The script is **one statement**: a single `DO` block with no `BEGIN`, `COMMIT` or other
transaction control of its own (every statement inside it is transaction-safe). One statement is
atomic however it is sent: if anything in it fails, nothing is applied and the previous version
stays intact. `idr_schema_version()` is defined last as well, so it reports the new version only
for a completely applied script. Supported methods:

1. **psql** (recommended for a manual apply):
   `psql -X -v ON_ERROR_STOP=1 --single-transaction -d "<connection string>" -f sql/0001_idr_projection.sql`.
   `ON_ERROR_STOP=1` makes psql exit with code 3 on an error; without it psql still prints the
   error but exits 0. `--single-transaction` is harmless (the script never opens or ends a
   transaction itself). Plain `psql -f` is also atomic.
2. **SQL editor**: paste the whole file and run it once.
3. **Migration runners that wrap each file in their own transaction** (for example
   `supabase migration up` / `supabase db push` after copying the file unchanged into
   `supabase/migrations/`): the statement runs inside the runner's transaction, so it is applied,
   or rolled back, together with the runner's own bookkeeping.

> **Warning about wrapping runners.** Releases before Gate 5 (schema 4 and earlier) wrapped the
> script in their own `BEGIN` … `COMMIT`. Under a runner that wraps the file in a transaction,
> that `COMMIT` ended the **runner's** transaction early: what the runner had done before the
> file was committed with it, and what it did afterwards (such as recording the migration) ran
> outside any transaction. The current script has no transaction control, so this cannot happen.
> Do **not** add `BEGIN`/`COMMIT` around or inside it, and do not split it into several files or
> statements. A tool that splits SQL on semicolons without understanding dollar quoting cannot
> run it (nor any earlier release, whose function bodies are dollar-quoted too).

Verified locally on PostgreSQL 16 (`test/upgrade.test.ts`): plain `psql -f` and the psql command
above, each twice; that command with a failure injected (exit 3, nothing applied); and a simulated
runner (`BEGIN`, a bookkeeping table, the file, a bookkeeping row, then `ROLLBACK` or `COMMIT`):
the rollback undoes the script and the bookkeeping, the commit keeps both. **Not verified:** the
Supabase CLI's own runner (`supabase migration up` / `db push`) was not run against this script,
so how it wraps a file is not confirmed here; and nothing was applied to a hosted Supabase project
(neither its SQL editor nor its PostgreSQL 17). A single statement is atomic in every case above,
which is why the script has this form.

**Before upgrading an existing project**, check its sync state:

```sql
select installation_id, cursor, needs_resync, status, last_applied_at
  from public.idr_sync_state;
select count(*) as open_gaps from public.idr_sync_gaps where resolved_at is null; -- if the table exists
```

- `cursor is null and last_applied_at is not null` on an install of an earlier release (no
  `reset_from_cursor` column yet) means a reset or a resync is in flight. The earlier SQL never
  stored the old position, so this upgrade cannot re-check it, and a prune past it would go
  unreported. Let the function run until a run drains (`status = ok` or `cursor_rejected`) before
  upgrading; if that is not possible, treat it as a potential gap: after the upgrade, run
  `select public.idr_begin_resync('<installation-id>');` once and record the incident.
- A gap that was open before the upgrade (even one already resynced) stays open, and keeps
  alerting, until a resync requested after the upgrade has drained: the earlier SQL did not record
  the generation the rules below rely on. If `open_gaps` is not 0, run `idr_begin_resync` once
  after the upgrade. (From schema 4 or 5, which do record generations, a gap whose resync was
  already requested resolves without that step: the first run after the upgrade that reaches the
  end of the feed records the drain, `drained_generation`, and resolves it.)

## 2. Set secrets

Generate the shared scheduler secret (at least 32 random characters) and set the secrets:

```bash
IDR_SYNC_SECRET="$(openssl rand -hex 32)"
supabase secrets set --project-ref <project-ref> \
  IDR_BASE_URL=https://<resolver-host> \
  IDR_REPORTING_TOKEN=<reporting-token> \
  IDR_INSTALLATION_ID=<installation-id> \
  IDR_SYNC_SECRET="$IDR_SYNC_SECRET"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase. Optional tuning:
`IDR_PAGE_LIMIT` (1-500, default 200), `IDR_MAX_PAGES` (default 50), `IDR_BUDGET_MS`
(default 50000, max 140000), `IDR_REQUEST_TIMEOUT_MS`, `IDR_MAX_RETRIES`,
`IDR_BACKOFF_BASE_MS`, `IDR_BACKOFF_MAX_MS`, `IDR_RECONCILE_DAYS` (0 = off; N = reconcile
the last N complete UTC days ending yesterday). `IDR_ALLOW_INSECURE_HTTP=true` permits
http URLs for local development only; never set it in production.

## 3. Deploy the function

Merge `supabase/config.toml` (`[functions.idr-sync] verify_jwt = false`) into the project
config, place `supabase/functions/idr-sync` and `src/core` so the relative import in
`index.ts` (`../../../src/core/index.ts`) resolves, then:

```bash
supabase functions deploy idr-sync --project-ref <project-ref>
```

The function accepts only `POST` with header `x-idr-sync-secret` equal to `IDR_SYNC_SECRET`
(constant-time compare); everything else gets an empty `401`. Its response holds counts and
a status only. Keep the function URL and secret out of browsers and Lovable app code: the
Insights app reads the projection tables with the signed-in user's session and never calls
this function.

## 4. Schedule

Follow `sql/schedule.example.sql`: store `idr_sync_url` and `idr_sync_secret` in Vault, then
`cron.schedule(...)` every N minutes. The secret in Vault must equal `IDR_SYNC_SECRET`.

## 5. Verify

1. Invoke once by hand: `curl -sS -X POST -H "x-idr-sync-secret: $IDR_SYNC_SECRET" https://<project-ref>.supabase.co/functions/v1/idr-sync`
   expect `{"status":"ok", ...}` (or `partial`; the next run continues). A wrong secret gives an empty 401.
2. `select installation_id, cursor, status, needs_resync, last_run_at from public.idr_sync_state;`
   and `select count(*) from public.idr_sync_gaps;` (expect 0 on a fresh project).
3. `select * from public.idr_daily_company_activity order by day desc limit 10;`
4. Optional: set `IDR_RECONCILE_DAYS=3`; status `reconcile_mismatch` means the projection
   disagrees with the resolver's `/v1/reporting/summary` for those days (see troubleshooting).
5. A signed-in user WITH the `idr_reader` claim can read the tables; a signed-in user without it, and `anon`, see nothing; nothing writes except the `idr_*` functions, which only `service_role` may call.

### Who may read the projection

On Supabase every self-signed-up user has the `authenticated` role, and e-mail sign-up is on
by default, so the role alone is not an authorisation. The RLS policies therefore require the
JWT claim `app_metadata.idr_reader = true`. `app_metadata` can be written only with the
service role (admin API); `user_metadata` can be edited by the user and is deliberately not
used.

1. Disable public sign-ups: Dashboard > Authentication > Sign In / Providers, turn off
   "Allow new users to sign up" (`enable_signup = false` in `config.toml`), and invite staff instead.
2. Grant the claim to each staff member from a trusted shell (never from a browser):
   `curl -sS -X PUT "https://<project-ref>.supabase.co/auth/v1/admin/users/<user-id>" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" -d '{"app_metadata":{"idr_reader":true}}'`
3. The user must sign in again (or refresh the session) to receive a token with the claim.
4. Revoke by setting `idr_reader` to `false`; the existing token keeps working until it expires, so keep the JWT expiry short.

## 6. Rotate tokens

- **Reporting token:** set the new value on the resolver (`REPORTING_AUTH_TOKEN`), then
  `supabase secrets set IDR_REPORTING_TOKEN=<new>`. Runs between the two steps report `auth_failed` and lose nothing.
- **Sync secret:** `supabase secrets set IDR_SYNC_SECRET=<new>` and update the Vault secret:
  `select vault.update_secret((select id from vault.secrets where name = 'idr_sync_secret'), '<new>');`.
- **Service role key:** rotate in the Supabase dashboard; the function picks up the new key on redeploy.

## Status values and troubleshooting

`status` in `idr_sync_state` and in the function response:

| status | meaning | action |
| --- | --- | --- |
| `ok` / `partial` | drained / more pages next run | none |
| `cas_conflict` | another invocation advanced the cursor. Also a stale overlapping run that got 410 for a position another run had already passed: the gap record is a compare-and-set on the cursor that got the 410, so such a run records no gap and changes nothing | none; expected when runs overlap |
| `rate_limited` / `upstream_error` | resolver 429/5xx/network within the time budget | retries next run; check resolver health if persistent |
| `auth_failed` | resolver returned 401/403 | check `IDR_REPORTING_TOKEN` (reporting token, not website token) |
| `contract_error` | malformed response, wrong installation id, or 4xx | check `IDR_BASE_URL` and `IDR_INSTALLATION_ID`; resolver version |
| `cursor_rejected` | resolver answered 400 to the stored cursor: its cursor key rotated (its `IP_HMAC_SECRET` was rotated) and the cursor is not behind its retention watermark; the engine reset the cursor once and replayed from the buffer start. The rejected cursor is kept in `idr_sync_state.reset_from_cursor` until the first page of the replay is applied; if the replay did not start (resolver blip, function killed), the next run first presents it again, and a 410 then becomes a recorded gap instead of a silent loss. The first page after that check is sent at once and only once (no retry or backoff; any failure ends the run with the position kept, so the next run checks again); what remains unchecked is the interval between the resolver's check and that one request (plus, right after a 400, the one store write that keeps the position), each bounded by its timeout | none: the replay is idempotent and nothing after the cursor was pruned. A stale cursor that is already behind the resolver's retention buffer gets 410 instead and ends in `needs_resync` with an `idr_sync_gaps` row, so a potential gap is never reported as `cursor_rejected`. Repeated every run means the resolver keeps rejecting cursors: check its version/secret rotation |
| `store_error` | database call failed | check that the SQL was applied and the function logs |
| `schema_mismatch` | the installed projection SQL is not the version this function requires (`idr_schema_version()`, 5 for this release); the function fetched and wrote nothing. HTTP 500 | re-run `sql/0001_idr_projection.sql` (idempotent, keeps all rows); alert on it |
| `reconcile_mismatch` | projection differs from the resolver summary | see below |
| `needs_resync` | resolver answered 410 `cursor_expired`: a **potential synchronisation continuity gap**. The function responds `409` with `"gap_recorded": true` and an `idr_sync_gaps` row exists | alert; see below |

### `needs_resync` and `idr_sync_gaps`

The resolver answered `410 cursor_expired`: the stored position lies behind the resolver's
bounded retention buffer, so observations **may** have been pruned before they were pulled.
Treat it as a **potential synchronisation continuity gap**, never as a recovery. In the same
transaction as setting `needs_resync`, the function appends one row to `public.idr_sync_gaps`
(`kind = 'cursor_expired'`, `detected_at`, the stored `expired_cursor`, `last_applied_at` = when
the last page was applied, `last_observed_at` = the newest observation in the projection). While
that gap is open, repeated runs do not add rows. The function then stops: it **does not advance
or skip the cursor** and does not call the resolver again until an operator acts. Every such run
responds `409` with `"gap_recorded": true` and logs `continuity gap: ...` (status and counts only).
If recording ever failed, the response says `"gap_recorded": false` and the next run retries it;
and `idr_begin_resync` itself inserts the gap row (bounded by the stored state) whenever
`needs_resync` is set but no open gap is on record, before it clears the flag, so a resync can
never erase the only evidence. Code/SQL version skew cannot drop it either: the function refuses
to run (`schema_mismatch`) unless the installed SQL is the version it requires.

1. Find out why the sync stalled (disabled schedule, repeated `auth_failed`, outage, a rotated
   resolver `IP_HMAC_SECRET` while far behind) and fix it.
2. Accept that observations pruned from the resolver buffer in the gap cannot be recovered
   from it. The existing projection is kept (the client owns commercial-history retention).
3. Restart from the start of the retained buffer:
   `select public.idr_begin_resync('<installation-id>');` (in the SQL editor, or as `service_role`).
   Replays are idempotent, so overlap with data already stored is harmless.
4. Let the function run until a run drains the buffer (`status = ok`). That run sets
   `resolved_at` and `resolution = 'full_resync'` on the open gap and reports `"gaps_resolved": 1`.
   Only a replay that started after the resync request can resolve a gap: resyncs, gaps and
   replays are ordered by a generation number under the state row lock (`resync_generation`,
   `detected_generation`, `replay_generation`), not by timestamps, so a gap detected while a
   replay is running stays open until the next resync. And only once that replay has **drained**
   (CHR-66 R2-8): `idr_apply_feed_page` records `drained_generation` in the same transaction as
   the replay's final page (the feed's `has_more = false`), and `idr_resolve_sync_gaps` resolves
   nothing until `drained_generation = replay_generation`. Calling the resolve function by hand
   before then changes nothing.
   **`resolved_at` marks the rebuild from what the resolver still retains, NOT a recovery:**
   observations pruned before the resync are permanently absent from the projection, and the
   row stays as the permanent record of the gap (rows are never deleted; `resolved_at` is set
   once). To avoid recurrence, schedule more frequently or ask for a longer resolver retention
   buffer.

### Monitoring

- **Alert on any row in `idr_sync_gaps`** (each is an incident in which data may be missing),
  e.g. `select count(*) from public.idr_sync_gaps where detected_at > now() - interval '1 day';`
- **Alert, and keep alerting, while any gap is unresolved**:
  `select id, detected_at, last_applied_at from public.idr_sync_gaps where resolved_at is null;`
- Also alert on `status = 'needs_resync'` in `idr_sync_state`, on HTTP `409` from the function,
  and on a run that reports `"gap_recorded": false`.
- Readers with the `idr_reader` claim can see the gap log (same RLS as the other tables). Nobody
  writes it directly: only the `SECURITY DEFINER` functions `idr_record_sync_gap`,
  `idr_begin_resync` and `idr_resolve_sync_gaps` (executable by `service_role` only) insert or
  resolve rows, and the guard trigger refuses a row inserted already resolved, any change but
  the one resolution, and every delete, even by the owner.
- What this does **not** prove: the SQL cannot check that a page came from the resolver. A holder
  of the service-role key can still call the functions in order with fabricated pages (resync,
  then a "final" page) and so reach a resolution. Every step of that is then in
  `idr_sync_state` (`resync_requested_at`, the generations, `drained_generation`, `cursor`), and a
  fabricated cursor is rejected by the resolver at the next run. Keep the service-role key as
  secret as the database password.

### `reconcile_mismatch`

Reconciliation compares observation and distinct-company counts for the last
`IDR_RECONCILE_DAYS` complete UTC days with the resolver summary. Common causes: days older
than the resolver's retention window, a company erasure applied on one side only (wait for the
next run), or a manual change to the projection tables. If it persists with a healthy sync,
follow the `needs_resync` steps to replay the buffer.

### Voluntary resync (without `needs_resync`)

`idr_begin_resync` may also be called when no gap was reported (for example after a
`reconcile_mismatch`). The old cursor may already lie behind the resolver's retention buffer, and
a replay from the start would never deliver, or report, what was pruned after it. So a voluntary
resync **re-checks the old position first**: it keeps the stored cursor in
`idr_sync_state.reset_from_cursor`, and the next run presents it to the resolver before replaying.
A `410` records a gap row (`kind = 'cursor_expired'`, `expired_cursor` = the old position) and,
because you already asked for the rebuild, the replay continues in the same run instead of
stopping; the response says `"gap_recorded": true`, the log says `continuity gap recorded ...`,
and the gap is resolved (`resolution = 'full_resync'`) once that replay drains. Alert on the row as
for any other gap. A `400` or `200` means nothing was pruned after the old position and the replay
proceeds without a gap. A resync with `needs_resync` set does not re-check (the gap is already on
record) and cannot loop.
