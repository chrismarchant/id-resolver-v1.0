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

Run `sql/0001_idr_projection.sql` against the project (SQL editor or `supabase db push`
after copying it into `supabase/migrations/`). It is idempotent. It creates the
projection tables, the `idr_daily_company_activity` view and the `idr_*` functions, enables
RLS on every table (no `anon` access; `authenticated` read-only and only with the `idr_reader` claim, see below) and grants function
execution to `service_role` only.

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
3. `select * from public.idr_daily_company_activity order by day desc limit 10;`
4. Optional: set `IDR_RECONCILE_DAYS=3`; status `reconcile_mismatch` means the projection
   disagrees with the resolver's `/v1/reporting/summary` for those days (see troubleshooting).
5. A signed-in user WITH the `idr_reader` claim can read the tables; a signed-in user without it, and `anon`, see nothing; nobody but `service_role` can write.

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
| `cas_conflict` | another invocation advanced the cursor | none; expected when runs overlap |
| `rate_limited` / `upstream_error` | resolver 429/5xx/network within the time budget | retries next run; check resolver health if persistent |
| `auth_failed` | resolver returned 401/403 | check `IDR_REPORTING_TOKEN` (reporting token, not website token) |
| `contract_error` | malformed response, wrong installation id, or 4xx | check `IDR_BASE_URL` and `IDR_INSTALLATION_ID`; resolver version |
| `cursor_rejected` | resolver answered 400 to the stored cursor: its cursor key rotated (its `IP_HMAC_SECRET` was rotated) and the cursor is not behind its retention watermark; the engine reset the cursor once and replayed from the buffer start | none: the replay is idempotent and the projection is complete. A stale cursor that is already behind the resolver's retention buffer gets 410 instead and ends in `needs_resync`, so data loss is never reported as `cursor_rejected`. Repeated every run means the resolver keeps rejecting cursors: check its version/secret rotation |
| `store_error` | database call failed | check that the SQL was applied and the function logs |
| `reconcile_mismatch` | projection differs from the resolver summary | see below |
| `needs_resync` | resolver answered 410 `cursor_expired` | see below |

### `needs_resync`

The sync fell behind the resolver's bounded retention buffer, so some observations were
pruned before they were pulled. The function stops, **does not advance or skip the cursor**
and does not call the resolver again until an operator acts. Alert on this status.

1. Find out why the sync stalled (disabled schedule, repeated `auth_failed`, outage) and fix it.
2. Accept that observations pruned from the resolver buffer in the gap cannot be recovered
   from it. The existing projection is kept (the client owns commercial-history retention).
3. Restart from the start of the retained buffer:
   `select public.idr_begin_resync('<installation-id>');` (run as `service_role`, e.g. in the SQL editor).
   Replays are idempotent, so overlap with data already stored is harmless.
4. Run the function once and confirm `status = ok`. To avoid recurrence, schedule more frequently
   or ask for a longer resolver retention buffer.

### `reconcile_mismatch`

Reconciliation compares observation and distinct-company counts for the last
`IDR_RECONCILE_DAYS` complete UTC days with the resolver summary. Common causes: days older
than the resolver's retention window, a company erasure applied on one side only (wait for the
next run), or a manual change to the projection tables. If it persists with a healthy sync,
follow the `needs_resync` steps to replay the buffer.
