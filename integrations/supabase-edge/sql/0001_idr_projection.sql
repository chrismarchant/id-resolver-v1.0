-- 0001_idr_projection.sql
-- Template for a client's Supabase project: projection of the ID Resolver
-- reporting feed (reporting-feed.v1). Apply once per client project. Contains
-- no client-specific values. Safe to re-run (idempotent).
--
-- INTERPRETATION (mandatory for every consumer of this data):
--   * An observation is an ENTRANCE: a website visit whose network origin was
--     resolved to a company. It is NOT a visitor, a person or a session, and
--     counting rows does not count visitors.
--   * Post-outreach activity is TEMPORAL ASSOCIATION, not causation. A company
--     being observed after outreach does not show the outreach caused it.
--
-- Roles: relies on the standard Supabase roles anon, authenticated and
-- service_role. Writes happen only through the idr_* functions below, which
-- only service_role may execute (the Edge Function uses the service key).
-- The writing functions are SECURITY DEFINER (CHR-66 R2-8): service_role has
-- no direct INSERT, UPDATE or DELETE on any table, so the sync state, the gap
-- log and the projection change only through those functions' checks.
-- Privileges are exact (CHR-66 G4-L4): Supabase's default privileges grant ALL
-- on every new table, view, sequence and function in public to anon,
-- authenticated and service_role, so each object is first stripped of every
-- privilege of those roles and PUBLIC, then granted only what it needs.
--
-- The whole script is ONE STATEMENT: a single DO block, with no BEGIN, COMMIT
-- or other transaction control of its own (CHR-66 R3-D and its migration-
-- runner follow-up). One statement is atomic however it is applied: alone
-- (plain `psql -f`, the SQL editor), in psql's --single-transaction, or inside
-- a migration runner that wraps each file in its own transaction (it then
-- commits or rolls back together with the runner's bookkeeping; an earlier
-- release's own COMMIT ended such a transaction early). A failure anywhere
-- leaves the previous version untouched. Every statement in it is
-- transaction-safe (no CREATE INDEX CONCURRENTLY, VACUUM or similar).
-- idr_schema_version() is still defined last.
-- Supported apply methods: SETUP.md, section 1. Do not add BEGIN/COMMIT, and
-- do not split the file.

do $idr_projection$
begin

create table if not exists public.idr_companies (
  installation_id   text   not null,
  company_id        bigint not null,
  domain            text   not null,
  organisation_name text   null,
  updated_at        timestamptz not null default now(),
  primary key (installation_id, company_id)
);

create table if not exists public.idr_observations (
  installation_id   text   not null,
  observation_id    bigint not null,
  company_id        bigint not null,
  observed_at       timestamptz not null,
  method            text   not null check (char_length(method) between 1 and 32),
  page_key          text   null check (page_key is null or char_length(page_key) <= 256),
  acquisition       text   null check (acquisition is null or char_length(acquisition) <= 32),
  entrance_contract text   null check (entrance_contract is null or char_length(entrance_contract) <= 40),
  received_at       timestamptz not null default now(),
  primary key (installation_id, observation_id),
  -- Tombstoning a company cascades to its observations.
  foreign key (installation_id, company_id)
    references public.idr_companies (installation_id, company_id) on delete cascade
);
create index if not exists idr_observations_day_idx
  on public.idr_observations (installation_id, observed_at);
create index if not exists idr_observations_company_idx
  on public.idr_observations (installation_id, company_id, observed_at);

-- Idempotency record for company erasures (installation_id, tombstone_id).
create table if not exists public.idr_tombstones (
  installation_id text   not null,
  tombstone_id    bigint not null,
  company_id      bigint not null,
  erased_at       timestamptz not null,
  received_at     timestamptz not null default now(),
  primary key (installation_id, tombstone_id)
);

create table if not exists public.idr_sync_state (
  installation_id text primary key,
  cursor          text null,
  last_run_at     timestamptz null,
  last_applied_at timestamptz null,
  status          text not null default 'never_run'
    check (status in ('never_run','resync_requested','ok','partial','needs_resync','auth_failed',
                      'rate_limited','upstream_error','cas_conflict','contract_error','store_error',
                      'reconcile_mismatch','cursor_rejected')),
  needs_resync    boolean not null default false,
  updated_at      timestamptz not null default now()
);

-- Set by idr_begin_resync() (informational; re-runs: added if missing).
alter table public.idr_sync_state add column if not exists resync_requested_at timestamptz null;
-- Ordering of resyncs, gaps and replays by generation, not by timestamps
-- (CHR-66 R2-9). Every change happens under the idr_sync_state row lock, so
-- the order is exactly the commit order of those changes:
--   resync_generation: incremented by every idr_begin_resync();
--   replay_generation: resync_generation at the moment the current replay
--     applied its first page from null (idr_apply_feed_page).
-- A gap (idr_sync_gaps.detected_generation = resync_generation at detection)
-- may be resolved only once a replay that started after a later resync
-- request has drained: detected_generation < replay_generation.
alter table public.idr_sync_state add column if not exists resync_generation bigint not null default 0;
alter table public.idr_sync_state add column if not exists replay_generation bigint not null default 0;
-- The cursor the resolver rejected with 400 (idr_reset_cursor) while the
-- replay from the start of the buffer has not applied its first page yet.
-- While it is set, every run first presents it again: a 410 then means
-- retention passed it in the meantime (a gap, recorded); a 400 means it is
-- still within retention and the replay may start. Cleared atomically with the
-- first page applied from null (idr_apply_feed_page) or by the gap record.
alter table public.idr_sync_state add column if not exists reset_from_cursor text null;
-- resync_generation while reset_from_cursor was the stored position. A gap the
-- re-check finds is dated to it: if a resync was requested after that (a
-- voluntary idr_begin_resync), the requested replay already covers the
-- rebuild, so the gap is recorded without halting and resolves after the
-- replay drains; otherwise it halts with needs_resync.
alter table public.idr_sync_state add column if not exists reset_from_generation bigint null;
-- Proof of a completed drain (CHR-66 R2-8): the replay_generation of the
-- replay whose final page (the feed's has_more = false) idr_apply_feed_page
-- applied, written in the same transaction as that page. Null: no drain
-- recorded yet. idr_resolve_sync_gaps resolves a gap only when
-- drained_generation = replay_generation, so a gap cannot be marked resolved
-- before the replay that rebuilds the projection has drained the buffer.
alter table public.idr_sync_state add column if not exists drained_generation bigint null;

-- Re-runs on an existing installation: widen the status check (idempotent).
alter table public.idr_sync_state drop constraint if exists idr_sync_state_status_check;
alter table public.idr_sync_state add constraint idr_sync_state_status_check
  check (status in ('never_run','resync_requested','ok','partial','needs_resync','auth_failed',
                    'rate_limited','upstream_error','cas_conflict','contract_error','store_error',
                    'reconcile_mismatch','cursor_rejected'));

comment on table public.idr_companies is
  'Companies resolved by the ID Resolver. INTERPRETATION: a company appearing here means at least one website entrance was attributed to it; it does not identify a person.';
comment on table public.idr_observations is
  'One row per feed observation. INTERPRETATION: an entrance is not a visitor or a session. Activity after outreach is temporal association, not causation.';
comment on table public.idr_tombstones is
  'Company erasures received from the resolver; the company and its observations are deleted from this projection.';
comment on table public.idr_sync_state is
  'Sync cursor and last run status per installation. needs_resync is set when the resolver reports cursor_expired (a potential continuity gap, recorded in idr_sync_gaps) and is cleared only by idr_begin_resync().';

-- Durable, append-only record of synchronisation continuity gaps. A 410
-- cursor_expired from the resolver means the consumer's position lies behind
-- the resolver's retention buffer: observations may have been pruned before
-- they were pulled. needs_resync/status in idr_sync_state are overwritten by
-- idr_begin_resync() and the next run; a row here never is. At most one OPEN
-- (unresolved) gap per installation and kind, so repeated runs or a retry
-- after a crash never add a duplicate. Rows are never deleted; resolved_at and
-- resolution are set once, by idr_resolve_sync_gaps(), when the first run
-- after a resync request has drained the resolver's whole retained buffer
-- (proved by idr_sync_state.drained_generation). A row is always recorded
-- open, and only the idr_* functions write the table (CHR-66 R2-8).
-- resolved_at marks that REBUILD, not a recovery: observations pruned before
-- the resync are permanently absent from this projection.
create table if not exists public.idr_sync_gaps (
  id               bigint generated always as identity primary key,
  installation_id  text        not null,
  kind             text        not null check (kind in ('cursor_expired')),
  detected_at      timestamptz not null default now(),
  -- The consumer's position when the gap was detected (the stale, opaque cursor):
  -- the exact lower bound of the gap in the resolver's stream.
  expired_cursor   text        null,
  -- idr_sync_state.last_applied_at at detection: when the consumer last applied a page.
  last_applied_at  timestamptz null,
  -- Newest observed_at in this projection at detection (approximate data bound:
  -- the stream is ordered by commit, not by observed_at).
  last_observed_at timestamptz null,
  resolved_at      timestamptz null,
  resolution       text        null check (resolution is null or resolution in ('full_resync')),
  constraint idr_sync_gaps_resolution_pair check ((resolved_at is null) = (resolution is null))
);
-- idr_sync_state.resync_generation when the gap was detected (null: recorded by
-- an earlier release; treated as 0, so it needs a resync requested after the
-- upgrade before it can be resolved: never a false resolution).
alter table public.idr_sync_gaps add column if not exists detected_generation bigint null;
create unique index if not exists idr_sync_gaps_one_open_idx
  on public.idr_sync_gaps (installation_id, kind) where resolved_at is null;

comment on table public.idr_sync_gaps is
  'Append-only record of potential synchronisation continuity gaps (resolver 410 cursor_expired). One row per incident, never deleted. resolved_at marks the rebuild from the retained buffer after idr_begin_resync(), NOT recovery: observations pruned before the resync are permanently missing. Alert on any row, and on any row with resolved_at is null.';

-- Guard: no DELETE, no TRUNCATE; an INSERT records an open gap (never one
-- already resolved, CHR-66 R2-8); an UPDATE may only resolve an open gap,
-- once, and change nothing else. Applies to the owner as well, and so to the
-- SECURITY DEFINER functions; a table owner or superuser can still disable
-- triggers.
create or replace function public.idr_sync_gaps_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'idr_sync_gaps is append-only' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.resolved_at is not null or new.resolution is not null then
      raise exception 'idr_sync_gaps: a gap is recorded open; only idr_resolve_sync_gaps resolves it' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.resolved_at is not null then
    raise exception 'idr_sync_gaps: gap already resolved' using errcode = '23514';
  end if;
  if new.resolved_at is null or new.resolution is null
     or new.id is distinct from old.id
     or new.installation_id is distinct from old.installation_id
     or new.kind is distinct from old.kind
     or new.detected_at is distinct from old.detected_at
     or new.expired_cursor is distinct from old.expired_cursor
     or new.last_applied_at is distinct from old.last_applied_at
     or new.last_observed_at is distinct from old.last_observed_at
     or new.detected_generation is distinct from old.detected_generation then
    raise exception 'idr_sync_gaps: only an open gap may be resolved, once' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists idr_sync_gaps_guard_row on public.idr_sync_gaps;
create trigger idr_sync_gaps_guard_row
  before insert or update or delete on public.idr_sync_gaps
  for each row execute function public.idr_sync_gaps_guard();
drop trigger if exists idr_sync_gaps_guard_truncate on public.idr_sync_gaps;
create trigger idr_sync_gaps_guard_truncate
  before truncate on public.idr_sync_gaps
  for each statement execute function public.idr_sync_gaps_guard();

-- Daily activity per company, UTC days. security_invoker: the view runs with
-- the caller's privileges and RLS, so it exposes nothing the caller could not
-- already select from the base tables.
create or replace view public.idr_daily_company_activity
  with (security_invoker = true) as
select
  o.installation_id,
  (o.observed_at at time zone 'utc')::date as day,
  o.company_id,
  c.domain,
  c.organisation_name,
  count(*)::bigint as entrances,
  min(o.observed_at) as first_observed_at,
  max(o.observed_at) as last_observed_at
from public.idr_observations o
join public.idr_companies c
  on c.installation_id = o.installation_id and c.company_id = o.company_id
group by o.installation_id, (o.observed_at at time zone 'utc')::date, o.company_id, c.domain, c.organisation_name;

comment on view public.idr_daily_company_activity is
  'Entrances per company per UTC day. INTERPRETATION: entrances are not visitors or sessions; activity after outreach is temporal association, not causation.';

-- ---------------------------------------------------------------------------
-- Row level security: enabled on every table. anon has no access. authenticated
-- may only read, and only when the JWT carries app_metadata.idr_reader = true.
-- On Supabase every self-signed-up user is `authenticated`, so the role alone
-- is not an authorisation. app_metadata is writable only with the service role
-- (the admin API), never by the user, unlike user_metadata. There are deliberately no INSERT/UPDATE/DELETE policies for
-- authenticated, and table privileges are revoked as well (defence in depth).
-- service_role bypasses RLS on Supabase; the explicit read policy keeps the
-- intent visible and works if the role lacks BYPASSRLS. service_role writes
-- only through the SECURITY DEFINER functions, which run as the table owner
-- (not subject to these policies), so it has no write policy either.
-- ---------------------------------------------------------------------------
alter table public.idr_companies    enable row level security;
alter table public.idr_observations enable row level security;
alter table public.idr_tombstones   enable row level security;
alter table public.idr_sync_state   enable row level security;
alter table public.idr_sync_gaps    enable row level security;

-- Exact table privileges (CHR-66 G4-L4). REVOKE ALL first: it removes what
-- Supabase's default privileges granted (on PostgreSQL 17 that includes
-- MAINTAIN), what an earlier release granted, and any column-level grant.
-- No role but the owner gets TRUNCATE, REFERENCES, TRIGGER or MAINTAIN.
revoke all on table public.idr_companies, public.idr_observations, public.idr_tombstones,
  public.idr_sync_state, public.idr_sync_gaps, public.idr_daily_company_activity
  from public, anon, authenticated, service_role;
grant select on public.idr_companies, public.idr_observations, public.idr_tombstones,
  public.idr_sync_state, public.idr_sync_gaps, public.idr_daily_company_activity to authenticated;
-- service_role reads; it writes only through the SECURITY DEFINER idr_*
-- functions (CHR-66 R2-8). Without a direct INSERT or UPDATE it cannot record
-- a fabricated (or already resolved) gap, mark a gap resolved, or move the
-- generations, needs_resync, reset_from_* or drained_generation behind the
-- functions' backs. idr_sync_gaps stays append-only (guard trigger).
grant select on public.idr_companies, public.idr_observations, public.idr_tombstones,
  public.idr_sync_state, public.idr_sync_gaps, public.idr_daily_company_activity to service_role;
-- The gap id is an identity column (generated always): inserting needs no
-- privilege on its sequence, so no role but the owner holds any.
do $$
begin
  execute format('revoke all on sequence %s from public, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.idr_sync_gaps', 'id'));
end $$;

do $$
declare t text;
begin
  foreach t in array array['idr_companies','idr_observations','idr_tombstones','idr_sync_state','idr_sync_gaps'] loop
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_read', t);
    execute format($f$create policy %I on public.%I for select to authenticated using (coalesce((select auth.jwt()) -> 'app_metadata' ->> 'idr_reader', '') = 'true')$f$, t || '_authenticated_read', t);
    -- Earlier releases had a read-write policy for service_role (CHR-66 R2-8: now read-only).
    execute format('drop policy if exists %I on public.%I', t || '_service_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_service_read', t);
    execute format('create policy %I on public.%I for select to service_role using (true)', t || '_service_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Functions, all with an empty search_path (every object is schema-qualified,
-- so no caller-controlled schema can capture a name).
-- The six functions that write (idr_apply_feed_page, idr_record_sync_status,
-- idr_reset_cursor, idr_begin_resync, idr_record_sync_gap and
-- idr_resolve_sync_gaps) are SECURITY DEFINER (CHR-66 R2-8): they run as the
-- owner of the tables, so service_role needs no table write privilege and the
-- state machine below (compare-and-set, generations, the drain proof) is the
-- only way to change the sync state or the gap log. Each one validates its
-- arguments, uses no dynamic SQL, and only service_role may execute it.
-- The read-only functions (idr_get_sync_state, idr_reconcile_counts,
-- idr_schema_version) stay SECURITY INVOKER: service_role can read the tables.
-- ---------------------------------------------------------------------------

-- plpgsql (not sql) so that its reference to idr_schema_version(), which is
-- defined at the very end of this script, is resolved at call time.
create or replace function public.idr_get_sync_state(p_installation_id text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  return coalesce(
    (select jsonb_build_object('cursor', s.cursor, 'needs_resync', s.needs_resync, 'reset_from_cursor', s.reset_from_cursor)
       from public.idr_sync_state s where s.installation_id = p_installation_id),
    jsonb_build_object('cursor', null, 'needs_resync', false, 'reset_from_cursor', null))
    || jsonb_build_object('gap_open', exists (
         select 1 from public.idr_sync_gaps g
          where g.installation_id = p_installation_id and g.resolved_at is null),
       'schema_version', public.idr_schema_version());
end;
$$;

-- Applies one feed page atomically, only if the stored cursor equals
-- p_expected_cursor (NULL = "no cursor yet") and the stored reset_from_cursor
-- equals p_expected_reset_from (compare-and-set on both). Observations are
-- idempotent on (installation_id, observation_id). A company_erased item
-- deletes that company's rows. Items are processed in stream order. The row
-- lock on idr_sync_state serialises concurrent callers; the loser sees the
-- advanced state and gets {"applied": false} without writing anything. The
-- applied page always clears reset_from_cursor: applying the first page from
-- null after a 400-reset ends the pending re-check in the same transaction.
-- p_drained is true for the feed's final page (has_more = false): it records
-- the current replay as drained (drained_generation) in the same transaction,
-- the proof idr_resolve_sync_gaps requires (CHR-66 R2-8). It defaults to
-- false, which never proves a drain.
-- (The four- and five-argument versions of earlier releases are dropped on re-run.)
drop function if exists public.idr_apply_feed_page(text, text, text, jsonb);
drop function if exists public.idr_apply_feed_page(text, text, text, jsonb, text);
create or replace function public.idr_apply_feed_page(
  p_installation_id text,
  p_expected_cursor text,
  p_next_cursor text,
  p_items jsonb,
  p_expected_reset_from text,
  p_drained boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor text;
  v_reset_from text;
  v_item jsonb;
  v_obs int := 0;
  v_tomb int := 0;
  v_rows int;
begin
  -- Checked step by step, so no check depends on the evaluation order of another.
  if p_installation_id is null or char_length(p_installation_id) not between 1 and 128
     or p_next_cursor is null or char_length(p_next_cursor) not between 1 and 4096
     or char_length(p_expected_cursor) not between 1 and 4096
     or char_length(p_expected_reset_from) not between 1 and 4096
     or p_drained is null or p_items is null then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 1000
     or exists (select 1 from jsonb_array_elements(p_items) e(value) where jsonb_typeof(e.value) <> 'object') then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e(value)
              where (e.value ->> 'type') is null or (e.value ->> 'type') not in ('observation', 'company_erased')) then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;

  insert into public.idr_sync_state (installation_id) values (p_installation_id)
    on conflict (installation_id) do nothing;
  select s.cursor, s.reset_from_cursor into v_cursor, v_reset_from from public.idr_sync_state s
    where s.installation_id = p_installation_id for update;

  if v_cursor is distinct from p_expected_cursor or v_reset_from is distinct from p_expected_reset_from then
    return jsonb_build_object('applied', false);
  end if;

  for v_item in
    select e.value from jsonb_array_elements(p_items) with ordinality as e(value, ord) order by e.ord
  loop
    if v_item ->> 'type' = 'observation' then
      insert into public.idr_companies (installation_id, company_id, domain, organisation_name)
        values (p_installation_id, (v_item ->> 'company_id')::bigint, v_item ->> 'domain', v_item ->> 'organisation_name')
        on conflict (installation_id, company_id) do update
          set domain = excluded.domain, organisation_name = excluded.organisation_name, updated_at = now();
      insert into public.idr_observations
        (installation_id, observation_id, company_id, observed_at, method, page_key, acquisition, entrance_contract)
        values (p_installation_id, (v_item ->> 'observation_id')::bigint, (v_item ->> 'company_id')::bigint,
                (v_item ->> 'observed_at')::timestamptz, v_item ->> 'method', v_item ->> 'page_key',
                v_item ->> 'acquisition', v_item ->> 'entrance_contract')
        on conflict (installation_id, observation_id) do nothing;
      get diagnostics v_rows = row_count;
      v_obs := v_obs + v_rows;
    elsif v_item ->> 'type' = 'company_erased' then
      insert into public.idr_tombstones (installation_id, tombstone_id, company_id, erased_at)
        values (p_installation_id, (v_item ->> 'tombstone_id')::bigint, (v_item ->> 'company_id')::bigint,
                (v_item ->> 'erased_at')::timestamptz)
        on conflict (installation_id, tombstone_id) do nothing;
      get diagnostics v_rows = row_count;
      v_tomb := v_tomb + v_rows;
      -- Always delete (idempotent); cascades to idr_observations.
      delete from public.idr_companies
        where installation_id = p_installation_id and company_id = (v_item ->> 'company_id')::bigint;
    end if;
  end loop;

  -- (Right-hand sides read the row as it was before this update.)
  update public.idr_sync_state
    set cursor = p_next_cursor, reset_from_cursor = null, reset_from_generation = null, last_applied_at = now(), updated_at = now(),
        -- The first page from null starts a replay of the whole retained buffer.
        replay_generation = case when p_expected_cursor is null then resync_generation else replay_generation end,
        -- The final page of that replay proves it drained (CHR-66 R2-8).
        drained_generation = case when p_drained
                                  then case when p_expected_cursor is null then resync_generation else replay_generation end
                                  else drained_generation end
    where installation_id = p_installation_id;

  return jsonb_build_object('applied', true, 'observations', v_obs, 'tombstones', v_tomb);
end;
$$;

-- Records a run's status. needs_resync can only be set here, never cleared
-- (only idr_begin_resync clears it); the status check constraint limits p_status.
create or replace function public.idr_record_sync_status(
  p_installation_id text,
  p_status text,
  p_needs_resync boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_installation_id is null or char_length(p_installation_id) not between 1 and 128 or p_status is null then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  insert into public.idr_sync_state as s (installation_id, status, needs_resync, last_run_at)
    values (p_installation_id, p_status, coalesce(p_needs_resync, false), now())
    on conflict (installation_id) do update
      set status = excluded.status,
          needs_resync = s.needs_resync or coalesce(p_needs_resync, false),
          last_run_at = now(),
          updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- Automatic recovery when the resolver rejects a stored cursor (400, e.g. its
-- cursor MAC key rotated). Compare-and-set so concurrent runs stay safe; the
-- projection is kept and the replay from the buffer start is idempotent. The
-- rejected cursor is kept in reset_from_cursor, in the same transaction,
-- until the first page from null is applied: if the replay does not start in
-- this run, the next run re-presents it, so a retention prune past it in the
-- meantime becomes a 410 and a recorded gap instead of a silent loss. This is
-- NOT for cursor_expired (410): that is a potential continuity gap, recorded
-- in idr_sync_gaps by idr_record_sync_gap(), and needs the operator action
-- idr_begin_resync().
create or replace function public.idr_reset_cursor(p_installation_id text, p_expected_cursor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_installation_id is null or char_length(p_installation_id) not between 1 and 128
     or char_length(p_expected_cursor) not between 1 and 4096 then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  update public.idr_sync_state
     set cursor = null, reset_from_cursor = p_expected_cursor, reset_from_generation = resync_generation, updated_at = now()
   where installation_id = p_installation_id
     and cursor is not distinct from p_expected_cursor
     and p_expected_cursor is not null
     and not needs_resync;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('applied', v_rows = 1);
end;
$$;

-- Operator action after cursor_expired: restart from the start of the
-- resolver's retained buffer. The projection is kept (the client owns
-- commercial-history retention); replays are idempotent. This rebuilds from
-- what the resolver still retains; it does NOT recover observations pruned
-- before the resync. The gap row in idr_sync_gaps stays.
-- Evidence first (CHR-66 R2-6): if needs_resync is set but no open gap is on
-- record (the gap RPC failed and only the status write succeeded), the gap
-- row is inserted here, in the same transaction, before the flag is cleared,
-- bounded by the stored state. A pending re-check of a rejected cursor is
-- then fulfilled too (reset_from_cursor cleared): re-checking an already
-- known expired position would only loop.
-- A VOLUNTARY resync (needs_resync not set) must not discard the old position
-- unchecked either: it may already lie behind the resolver's retention
-- watermark, and the replay from null would never deliver (or report) the
-- items pruned after it. So the stored cursor is kept in reset_from_cursor
-- (with the generation it belonged to), in the same transaction as the reset;
-- the next run presents it first, exactly as after a 400-reset. A pending
-- re-check that is already set is kept as it is.
create or replace function public.idr_begin_resync(p_installation_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_needs boolean;
  v_cursor text;
  v_reset_from text;
  v_last_applied timestamptz;
  v_generation bigint;
  v_id bigint;
begin
  if p_installation_id is null or char_length(p_installation_id) not between 1 and 128 then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  insert into public.idr_sync_state (installation_id) values (p_installation_id)
    on conflict (installation_id) do nothing;
  select s.needs_resync, s.cursor, s.reset_from_cursor, s.last_applied_at, s.resync_generation
    into v_needs, v_cursor, v_reset_from, v_last_applied, v_generation
    from public.idr_sync_state s where s.installation_id = p_installation_id for update;
  if v_needs then
    insert into public.idr_sync_gaps (installation_id, kind, detected_at, detected_generation, expired_cursor, last_applied_at, last_observed_at)
      values (p_installation_id, 'cursor_expired', clock_timestamp(), v_generation, coalesce(v_cursor, v_reset_from), v_last_applied,
              (select max(o.observed_at) from public.idr_observations o where o.installation_id = p_installation_id))
      on conflict (installation_id, kind) where resolved_at is null do nothing
      returning id into v_id;
  end if;
  update public.idr_sync_state
     set cursor = null, needs_resync = false, status = 'resync_requested',
         reset_from_cursor = case when v_needs then null else coalesce(v_cursor, reset_from_cursor) end,
         reset_from_generation = case when v_needs then null
                                      when v_cursor is not null then v_generation
                                      else reset_from_generation end,
         resync_generation = resync_generation + 1,
         resync_requested_at = clock_timestamp(), updated_at = now()
   where installation_id = p_installation_id;
  return jsonb_build_object('ok', true, 'gap_recorded', v_id is not null);
end;
$$;

-- Called by the engine on 410 cursor_expired (and on every run that finds
-- needs_resync already set). Compare-and-set like every other cursor change:
-- p_expected_cursor is the cursor that got the 410 (the one the run holds, or
-- the re-presented reset_from_cursor). The stored position is the cursor, or
-- reset_from_cursor while the cursor is null after a 400-reset. If it no
-- longer equals p_expected_cursor, another run has moved on (it applied pages
-- past that position, so nothing was missed there): the call writes nothing
-- and returns {"superseded": true}. A recorded gap also ends a pending
-- re-check (reset_from_cursor is cleared). Otherwise, in ONE
-- transaction, it records the gap unless an open gap of this kind already
-- exists (the partial unique index makes that race-free) and, unless a resync
-- requested after that position already covers the rebuild, marks
-- needs_resync and the status (halt). The gap is dated to the generation of
-- the position: the current one, or reset_from_generation for a re-checked
-- reset_from_cursor. expired_cursor is the cursor that got the 410; the other
-- bounds come from the stored state.
-- Returns {recorded, new, superseded, needs_resync, gap_id}.
drop function if exists public.idr_record_sync_gap(text, text);
create or replace function public.idr_record_sync_gap(p_installation_id text, p_kind text, p_expected_cursor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor text;
  v_reset_from text;
  v_reset_gen bigint;
  v_needs boolean;
  v_last_applied timestamptz;
  v_generation bigint;
  v_detected bigint;
  v_halt boolean;
  v_new boolean := false;
  v_id bigint;
begin
  if p_installation_id is null or char_length(p_installation_id) not between 1 and 128
     or p_kind is distinct from 'cursor_expired' or char_length(p_expected_cursor) not between 1 and 4096 then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  insert into public.idr_sync_state (installation_id) values (p_installation_id)
    on conflict (installation_id) do nothing;
  select s.cursor, s.reset_from_cursor, s.reset_from_generation, s.needs_resync, s.last_applied_at, s.resync_generation
    into v_cursor, v_reset_from, v_reset_gen, v_needs, v_last_applied, v_generation
    from public.idr_sync_state s where s.installation_id = p_installation_id for update;
  if coalesce(v_cursor, v_reset_from) is distinct from p_expected_cursor then
    return jsonb_build_object('recorded', false, 'new', false, 'superseded', true, 'needs_resync', false, 'gap_id', null);
  end if;
  v_detected := case when v_cursor is null and v_reset_from is not null then coalesce(v_reset_gen, v_generation) else v_generation end;
  -- Halt unless a resync requested after that position already covers the rebuild.
  v_halt := v_needs or v_detected >= v_generation;
  update public.idr_sync_state
     set status = case when v_halt then 'needs_resync' else status end,
         needs_resync = needs_resync or v_halt,
         reset_from_cursor = null, reset_from_generation = null,
         last_run_at = now(), updated_at = now()
   where installation_id = p_installation_id;
  insert into public.idr_sync_gaps (installation_id, kind, detected_at, detected_generation, expired_cursor, last_applied_at, last_observed_at)
    values (p_installation_id, p_kind, clock_timestamp(), v_detected, p_expected_cursor, v_last_applied,
            (select max(o.observed_at) from public.idr_observations o where o.installation_id = p_installation_id))
    on conflict (installation_id, kind) where resolved_at is null do nothing
    returning id into v_id;
  if v_id is not null then
    v_new := true;
  else
    select g.id into v_id from public.idr_sync_gaps g
     where g.installation_id = p_installation_id and g.kind = p_kind and g.resolved_at is null;
  end if;
  return jsonb_build_object('recorded', v_id is not null, 'new', v_new, 'superseded', false, 'needs_resync', v_halt, 'gap_id', v_id);
end;
$$;

-- Called by the engine after a run that drained the resolver's buffer while a
-- gap was open. Resolves only gaps detected before the resync request whose
-- replay has now drained (detected_generation < replay_generation: the replay
-- applied its first page from null after a resync requested after the
-- detection), only once that replay's final page was applied
-- (drained_generation = replay_generation, recorded by idr_apply_feed_page in
-- the transaction of that page: the proof of the drain, CHR-66 R2-8), only
-- while no new resync is pending, and only if the stored cursor is still the
-- one the run drained to (p_drained_cursor: no newer replay has started since
-- that drain). Generations, not timestamps: the order is the commit order
-- under the state row lock, so a transaction that started earlier cannot be
-- mis-ordered (CHR-66 R2-9). That is the meaning of resolved_at; the pruned
-- observations stay missing.
drop function if exists public.idr_resolve_sync_gaps(text);
create or replace function public.idr_resolve_sync_gaps(p_installation_id text, p_drained_cursor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_installation_id is null or char_length(p_installation_id) not between 1 and 128
     or char_length(p_drained_cursor) not between 1 and 4096 then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;
  update public.idr_sync_gaps g
     set resolved_at = clock_timestamp(), resolution = 'full_resync'
    from public.idr_sync_state s
   where g.installation_id = p_installation_id
     and g.resolved_at is null
     and s.installation_id = p_installation_id
     and not s.needs_resync
     and s.cursor is not distinct from p_drained_cursor
     and p_drained_cursor is not null
     and s.drained_generation = s.replay_generation
     and coalesce(g.detected_generation, 0) < s.replay_generation;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('resolved', v_rows);
end;
$$;

-- Counts for reconciliation against /v1/reporting/summary. Inclusive UTC days.
create or replace function public.idr_reconcile_counts(p_installation_id text, p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'observations', count(*),
    'observed_companies', count(distinct o.company_id))
  from public.idr_observations o
  where o.installation_id = p_installation_id
    and (o.observed_at at time zone 'utc')::date between p_from and p_to;
$$;

-- Exact function privileges (G4-L4): EXECUTE for service_role only.
revoke all on function public.idr_get_sync_state(text) from public, anon, authenticated, service_role;
revoke all on function public.idr_apply_feed_page(text, text, text, jsonb, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.idr_record_sync_status(text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.idr_begin_resync(text) from public, anon, authenticated, service_role;
revoke all on function public.idr_reset_cursor(text, text) from public, anon, authenticated, service_role;
revoke all on function public.idr_reconcile_counts(text, date, date) from public, anon, authenticated, service_role;
revoke all on function public.idr_record_sync_gap(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.idr_resolve_sync_gaps(text, text) from public, anon, authenticated, service_role;
-- A trigger function is never called directly, and nobody needs it to create
-- a trigger: no role but the owner may execute it.
revoke all on function public.idr_sync_gaps_guard() from public, anon, authenticated, service_role;
grant execute on function public.idr_get_sync_state(text) to service_role;
grant execute on function public.idr_apply_feed_page(text, text, text, jsonb, text, boolean) to service_role;
grant execute on function public.idr_record_sync_status(text, text, boolean) to service_role;
grant execute on function public.idr_begin_resync(text) to service_role;
grant execute on function public.idr_reset_cursor(text, text) to service_role;
grant execute on function public.idr_reconcile_counts(text, date, date) to service_role;
grant execute on function public.idr_record_sync_gap(text, text, text) to service_role;
grant execute on function public.idr_resolve_sync_gaps(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- LAST: the projection schema this script installs. The Edge function refuses
-- to run (status schema_mismatch, HTTP 500) unless it matches the version its
-- code expects, so code/SQL skew can never silently drop gap evidence.
-- (The script's one-statement form changes nothing that is installed, so it
-- does not change this version.)
-- 6 = this release: the writing functions are SECURITY DEFINER, service_role
-- has no direct table write, and a gap resolves only after a drained replay
-- (drained_generation; CHR-66 R2-8). 5 = exact privileges under Supabase's
-- default privileges (CHR-66 G4-L4). 4 = the gap log with compare-and-set, the reset_from_cursor
-- re-check after a 400 and after a voluntary resync, generations. Earlier
-- releases had no version function. Defined after everything else, in the
-- same statement, so it never reports a version for a partially applied
-- script.
-- ---------------------------------------------------------------------------
create or replace function public.idr_schema_version()
returns integer
language sql
immutable
set search_path = ''
as $$ select 6 $$;
revoke all on function public.idr_schema_version() from public, anon, authenticated, service_role;
grant execute on function public.idr_schema_version() to service_role;

end
$idr_projection$;
