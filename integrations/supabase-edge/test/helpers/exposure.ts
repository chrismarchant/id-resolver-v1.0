/**
 * Exposure invariants of the projection (docs/GUARDRAILS.md G4) and its
 * column catalogue (G5), as detectors that return every violation they find
 * (empty = clean). Unlike the exact grant lists in acl.ts, these are rules:
 * they also hold for any idr_* object a later release (or a mistake) adds.
 *
 * G4, for every object in public whose name starts with idr_:
 *   - anon and PUBLIC hold no privilege at all (ACL or effective, incl. through
 *     role membership), and no RLS policy applies to them;
 *   - authenticated holds SELECT only, on tables with RLS enabled and at least
 *     one non-trivial SELECT policy for it, or on a security_invoker view;
 *     no other policy command, no materialised view, no sequence;
 *   - no column-level grant;
 *   - no idr_* function is executable by anon, authenticated or PUBLIC;
 *   - every SECURITY DEFINER idr_* function pins search_path, with pg_temp
 *     explicitly last (CHR-66 G5R1-M1);
 *   - the platform's default privileges (ALL to anon, authenticated and
 *     service_role) have not leaked: service_role holds SELECT only on
 *     relations, nothing on sequences, EXECUTE only on functions; no other
 *     role but the owner holds anything.
 */
import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const API_ROLES = ["anon", "authenticated"];

export async function exposureViolations(q: Queryable): Promise<string[]> {
  const out: string[] = [];

  // Relation ACLs (NULL = the built-in default, expanded).
  const relAcl = await q.query<{ rel: string; kind: string; grantee: string; privilege: string }>(
    `select c.relname as rel, c.relkind::text as kind,
            case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type as privilege
       from pg_class c
       cross join lateral aclexplode(coalesce(c.relacl, acldefault(case c.relkind when 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and a.grantee <> c.relowner
      order by 1, 3, 4`,
  );
  for (const r of relAcl.rows) {
    const where = `${r.rel}: ${r.privilege} for ${r.grantee}`;
    if (r.grantee === "PUBLIC" || r.grantee === "anon") out.push(`${where} (anon/PUBLIC must hold nothing)`);
    else if (r.grantee === "authenticated") {
      if (r.privilege !== "SELECT" || r.kind === "S" || r.kind === "m") out.push(`${where} (authenticated: SELECT on tables and views only)`);
    } else if (r.grantee === "service_role") {
      if (r.privilege !== "SELECT" || r.kind === "S") out.push(`${where} (platform default privilege leaked: service_role reads only)`);
    } else out.push(`${where} (unexpected grantee)`);
  }

  // Effective privileges (role membership included) of the API roles.
  const eff = await q.query<{ rel: string; role: string; privilege: string }>(
    `select c.relname as rel, r.role, p.privilege
       from pg_class c
       cross join unnest(array['anon', 'authenticated']) r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(privilege)
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and exists (select 1 from pg_roles where rolname = r.role)
        and has_table_privilege(r.role, c.oid, p.privilege)
        and not (r.role = 'authenticated' and p.privilege = 'SELECT')
      order by 1, 2, 3`,
  );
  for (const r of eff.rows) out.push(`${r.rel}: effective ${r.privilege} for ${r.role}`);

  // Column-level grants.
  const cols = await q.query<{ col: string }>(
    `select c.relname || '.' || a.attname as col from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and a.attacl is not null order by 1`,
  );
  for (const r of cols.rows) out.push(`${r.col}: column-level grant`);

  // Tables: RLS on; authenticated reads only through a non-trivial SELECT policy; no policy for anon or PUBLIC.
  const tables = await q.query<{ rel: string; rls: boolean; auth_select: boolean; auth_select_policies: number }>(
    `select c.relname as rel, c.relrowsecurity as rls,
            has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
            (select count(*)::int from pg_policy p
              where p.polrelid = c.oid and p.polcmd in ('r', '*') and 'authenticated'::regrole = any(p.polroles)
                and coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') not in ('true', '(true)')) as auth_select_policies
       from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and c.relkind in ('r', 'p')
      order by 1`,
  );
  for (const t of tables.rows) {
    if (!t.rls) out.push(`${t.rel}: row level security is disabled`);
    if (t.auth_select && t.auth_select_policies === 0) out.push(`${t.rel}: authenticated can SELECT without a non-trivial RLS policy`);
  }
  const policies = await q.query<{ rel: string; pol: string; cmd: string; roles: string[]; qual: string | null }>(
    `select c.relname as rel, p.polname as pol, p.polcmd::text as cmd,
            array(select case when r = 0 then 'PUBLIC' else r::regrole::text end from unnest(p.polroles) r order by 1) as roles,
            pg_get_expr(p.polqual, p.polrelid) as qual
       from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%'
      order by 1, 2`,
  );
  for (const p of policies.rows) {
    if (p.roles.some((r) => r === "PUBLIC" || r === "anon")) out.push(`${p.rel}: policy ${p.pol} applies to ${p.roles.join(",")}`);
    if (p.roles.includes("authenticated") && p.cmd !== "r") out.push(`${p.rel}: policy ${p.pol} lets authenticated do more than SELECT (${p.cmd})`);
    if (p.roles.includes("authenticated") && (p.qual === null || p.qual === "true")) out.push(`${p.rel}: policy ${p.pol} for authenticated is unconditional`);
  }

  // Views readable by authenticated must run with the caller's rights (security_invoker), or RLS is bypassed.
  const views = await q.query<{ rel: string; invoker: boolean }>(
    `select c.relname as rel,
            coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker') in ('true', 'on', '1', 'yes'), false) as invoker
       from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and c.relkind = 'v'
        and has_table_privilege('authenticated', c.oid, 'SELECT')`,
  );
  for (const v of views.rows) if (!v.invoker) out.push(`${v.rel}: view readable by authenticated is not security_invoker`);

  // Functions.
  const fnAcl = await q.query<{ fn: string; grantee: string; privilege: string }>(
    `select p.oid::regprocedure::text as fn,
            case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type as privilege
       from pg_proc p
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace and p.proname like 'idr\\_%' and a.grantee <> p.proowner
      order by 1, 2`,
  );
  for (const r of fnAcl.rows) {
    if (r.grantee === "PUBLIC" || API_ROLES.includes(r.grantee)) out.push(`${r.fn}: ${r.privilege} for ${r.grantee}`);
    else if (r.grantee !== "service_role") out.push(`${r.fn}: ${r.privilege} for ${r.grantee} (unexpected grantee)`);
  }
  const fnEff = await q.query<{ fn: string; role: string }>(
    `select p.oid::regprocedure::text as fn, r.role
       from pg_proc p cross join unnest(array['anon', 'authenticated']) r(role)
      where p.pronamespace = 'public'::regnamespace and p.proname like 'idr\\_%'
        and exists (select 1 from pg_roles where rolname = r.role)
        and has_function_privilege(r.role, p.oid, 'EXECUTE')
      order by 1, 2`,
  );
  for (const r of fnEff.rows) out.push(`${r.fn}: effective EXECUTE for ${r.role}`);
  const definers = await q.query<{ fn: string; config: string[] | null }>(
    `select p.oid::regprocedure::text as fn, p.proconfig as config from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname like 'idr\\_%' and p.prosecdef order by 1`,
  );
  for (const d of definers.rows) {
    const sp = (d.config ?? []).find((c) => c.startsWith("search_path="));
    if (sp === undefined) out.push(`${d.fn}: SECURITY DEFINER without a pinned search_path`);
    else {
      const parts = sp.slice("search_path=".length).split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
      if (parts[parts.length - 1] !== "pg_temp") out.push(`${d.fn}: SECURITY DEFINER search_path does not list pg_temp last`);
      if (parts.some((x) => x === "$user" || x === "public")) out.push(`${d.fn}: SECURITY DEFINER search_path includes a writable schema`);
    }
  }
  return out;
}

// ---- G5: column catalogue -------------------------------------------------

export interface CatalogColumn {
  rel: string;
  col: string;
  type: string;
}

/** Every column of every public idr_* relation, sorted (order of creation is irrelevant: upgrades add columns). */
export async function projectionColumns(q: Queryable): Promise<CatalogColumn[]> {
  const r = await q.query<CatalogColumn>(
    `select c.relname as rel, a.attname as col, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and a.attnum > 0 and not a.attisdropped
      order by 1, 2`,
  );
  return r.rows;
}

/** Types that can hold an address or arbitrary bytes (a raw or packed address). Domains and arrays are resolved. */
export const BANNED_TYPES = ["inet", "cidr", "macaddr", "macaddr8", "bytea"];
/** Names that suggest visitor-level data. Matched anywhere in the column name, case-insensitive. */
export const BANNED_NAME = /ip|addr|fingerprint|hmac|visitor|session|user_agent|referrer|email|observation_ref|entrance/i;
/**
 * Columns whose names match BANNED_NAME but hold no visitor-level data:
 *   idr_observations.entrance_contract: the name of the contract the
 *     observation came through, e.g. "entrance.v1" (not an entrance id);
 *   idr_daily_company_activity.entrances: a count per company and UTC day.
 */
export const NAME_ALLOWLIST: ReadonlySet<string> = new Set(["idr_observations.entrance_contract", "idr_daily_company_activity.entrances"]);

export async function rawIpCapableColumns(q: Queryable): Promise<string[]> {
  const r = await q.query<{ rel: string; col: string; types: string[] }>(
    `with recursive cols as (
       select c.relname as rel, a.attname as col, a.atttypid as typ
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and a.attnum > 0 and not a.attisdropped),
     walk as (
       select rel, col, typ, 0 as depth from cols
       union all
       select w.rel, w.col, case when t.typtype = 'd' then t.typbasetype else t.typelem end, w.depth + 1
         from walk w join pg_type t on t.oid = w.typ
        where w.depth < 16 and (t.typtype = 'd' or (t.typcategory = 'A' and t.typelem <> 0)))
     select rel, col, array_agg(distinct format_type(typ, null)) as types from walk group by rel, col order by 1, 2`,
  );
  const out: string[] = [];
  for (const c of r.rows) {
    const key = `${c.rel}.${c.col}`;
    const banned = c.types.filter((t) => BANNED_TYPES.includes(t));
    if (banned.length > 0) out.push(`${key}: banned type ${banned.join(",")}`);
    if (BANNED_NAME.test(c.col) && !NAME_ALLOWLIST.has(key)) out.push(`${key}: banned column name`);
  }
  return out;
}

// ---- G4: Supabase's RLS auto-enable event trigger ---------------------------

/**
 * Emulates the event trigger Supabase installs to enable row level security on
 * every table created in public (`ensure_rls`, function `rls_auto_enable`):
 * on ddl_command_end of CREATE TABLE / CREATE TABLE AS / SELECT INTO, every
 * new table or partitioned table in public gets ENABLE ROW LEVEL SECURITY.
 * The function lives in its own schema so a test that recreates public keeps
 * it. Event triggers are database-wide: install it only in a scratch database.
 * Needs superuser (the test role and CI's POSTGRES_USER are).
 */
export async function installEnsureRls(q: Queryable): Promise<void> {
  await q.query("create schema if not exists idr_test_platform");
  await q.query(`create or replace function idr_test_platform.rls_auto_enable() returns event_trigger
    language plpgsql security definer set search_path = pg_catalog as $f$
    declare cmd record;
    begin
      for cmd in select * from pg_event_trigger_ddl_commands()
                  where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
                    and object_type in ('table', 'partitioned table') and schema_name = 'public'
      loop
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
      end loop;
    end $f$`);
  await q.query("drop event trigger if exists ensure_rls");
  await q.query("create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function idr_test_platform.rls_auto_enable()");
}
