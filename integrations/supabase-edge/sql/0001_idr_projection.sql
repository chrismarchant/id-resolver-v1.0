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
                      'reconcile_mismatch')),
  needs_resync    boolean not null default false,
  updated_at      timestamptz not null default now()
);

comment on table public.idr_companies is
  'Companies resolved by the ID Resolver. INTERPRETATION: a company appearing here means at least one website entrance was attributed to it; it does not identify a person.';
comment on table public.idr_observations is
  'One row per feed observation. INTERPRETATION: an entrance is not a visitor or a session. Activity after outreach is temporal association, not causation.';
comment on table public.idr_tombstones is
  'Company erasures received from the resolver; the company and its observations are deleted from this projection.';
comment on table public.idr_sync_state is
  'Sync cursor and last run status per installation. needs_resync is set when the resolver reports cursor_expired and is cleared only by idr_begin_resync().';

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
-- may only read. There are deliberately no INSERT/UPDATE/DELETE policies for
-- authenticated, and table privileges are revoked as well (defence in depth).
-- service_role bypasses RLS on Supabase; the explicit policy keeps the intent
-- visible and works if the role lacks BYPASSRLS.
-- ---------------------------------------------------------------------------
alter table public.idr_companies    enable row level security;
alter table public.idr_observations enable row level security;
alter table public.idr_tombstones   enable row level security;
alter table public.idr_sync_state   enable row level security;

revoke all on table public.idr_companies, public.idr_observations, public.idr_tombstones,
  public.idr_sync_state, public.idr_daily_company_activity from public, anon, authenticated;
grant select on public.idr_companies, public.idr_observations, public.idr_tombstones,
  public.idr_sync_state, public.idr_daily_company_activity to authenticated;
grant select, insert, update, delete on public.idr_companies, public.idr_observations,
  public.idr_tombstones, public.idr_sync_state to service_role;
grant select on public.idr_daily_company_activity to service_role;

do $$
declare t text;
begin
  foreach t in array array['idr_companies','idr_observations','idr_tombstones','idr_sync_state'] loop
    execute format('drop policy if exists %I on public.%I', t || '_authenticated_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_authenticated_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_service_all', t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', t || '_service_all', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Functions. All are SECURITY INVOKER with an empty search_path (every object
-- is schema-qualified). SECURITY DEFINER is deliberately NOT used: the only
-- caller is service_role, which is granted the table privileges above, so no
-- privilege elevation is needed and a mistake here cannot widen access.
-- ---------------------------------------------------------------------------

create or replace function public.idr_get_sync_state(p_installation_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('cursor', s.cursor, 'needs_resync', s.needs_resync)
       from public.idr_sync_state s where s.installation_id = p_installation_id),
    jsonb_build_object('cursor', null, 'needs_resync', false));
$$;

-- Applies one feed page atomically, only if the stored cursor equals
-- p_expected_cursor (NULL = "no cursor yet"). Observations are idempotent on
-- (installation_id, observation_id). A company_erased item deletes that
-- company's rows. Items are processed in stream order. The row lock on
-- idr_sync_state serialises concurrent callers; the loser sees the advanced
-- cursor and gets {"applied": false} without writing anything.
create or replace function public.idr_apply_feed_page(
  p_installation_id text,
  p_expected_cursor text,
  p_next_cursor text,
  p_items jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_cursor text;
  v_item jsonb;
  v_obs int := 0;
  v_tomb int := 0;
  v_rows int;
begin
  if p_installation_id is null or p_installation_id = '' or p_next_cursor is null or p_next_cursor = ''
     or p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid_arguments' using errcode = '22023';
  end if;

  insert into public.idr_sync_state (installation_id) values (p_installation_id)
    on conflict (installation_id) do nothing;
  select s.cursor into v_cursor from public.idr_sync_state s
    where s.installation_id = p_installation_id for update;

  if v_cursor is distinct from p_expected_cursor then
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

  update public.idr_sync_state
    set cursor = p_next_cursor, last_applied_at = now(), updated_at = now()
    where installation_id = p_installation_id;

  return jsonb_build_object('applied', true, 'observations', v_obs, 'tombstones', v_tomb);
end;
$$;

create or replace function public.idr_record_sync_status(
  p_installation_id text,
  p_status text,
  p_needs_resync boolean
) returns jsonb
language plpgsql
set search_path = ''
as $$
begin
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

-- Operator action after cursor_expired: restart from the start of the
-- resolver's retained buffer. The projection is kept (the client owns
-- commercial-history retention); replays are idempotent.
create or replace function public.idr_begin_resync(p_installation_id text)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  insert into public.idr_sync_state as s (installation_id, status, needs_resync, cursor)
    values (p_installation_id, 'resync_requested', false, null)
    on conflict (installation_id) do update
      set cursor = null, needs_resync = false, status = 'resync_requested', updated_at = now();
  return jsonb_build_object('ok', true);
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

revoke all on function public.idr_get_sync_state(text) from public, anon, authenticated;
revoke all on function public.idr_apply_feed_page(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.idr_record_sync_status(text, text, boolean) from public, anon, authenticated;
revoke all on function public.idr_begin_resync(text) from public, anon, authenticated;
revoke all on function public.idr_reconcile_counts(text, date, date) from public, anon, authenticated;
grant execute on function public.idr_get_sync_state(text) to service_role;
grant execute on function public.idr_apply_feed_page(text, text, text, jsonb) to service_role;
grant execute on function public.idr_record_sync_status(text, text, boolean) to service_role;
grant execute on function public.idr_begin_resync(text) to service_role;
grant execute on function public.idr_reconcile_counts(text, date, date) to service_role;
