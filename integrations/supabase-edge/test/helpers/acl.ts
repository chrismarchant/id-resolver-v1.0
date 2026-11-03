/**
 * Exact privileges of the projection objects (CHR-66 G4-L4). Read from the
 * catalog with aclexplode(), so a NULL ACL (the built-in default, which for a
 * function means EXECUTE for PUBLIC) is expanded too. The owner is left out:
 * its privileges are implicit. PUBLIC is reported as "PUBLIC".
 */
import type pg from "pg";

export type Grants = Record<string, Record<string, string[]>>;

/** Read only: service_role writes through the SECURITY DEFINER functions alone (CHR-66 R2-8). */
const READ = ["SELECT"];

/** Every idr_* table, view and sequence: grantee -> privileges, nothing else. */
export const EXPECTED_RELATION_GRANTS: Grants = {
  idr_companies: { authenticated: READ, service_role: READ },
  idr_observations: { authenticated: READ, service_role: READ },
  idr_tombstones: { authenticated: READ, service_role: READ },
  idr_sync_state: { authenticated: READ, service_role: READ },
  idr_sync_gaps: { authenticated: READ, service_role: READ },
  idr_daily_company_activity: { authenticated: READ, service_role: READ },
  // An identity column needs no sequence privilege to insert.
  idr_sync_gaps_id_seq: {},
};

/** Every idr_* function: grantee -> privileges. */
export const EXPECTED_FUNCTION_GRANTS: Grants = {
  "idr_apply_feed_page(text,text,text,jsonb,text,boolean)": { service_role: ["EXECUTE"] },
  // The operator's action: the owner only (CHR-66 G5R1-L3).
  "idr_begin_resync(text)": {},
  "idr_get_sync_state(text)": { service_role: ["EXECUTE"] },
  "idr_reconcile_counts(text,date,date)": { service_role: ["EXECUTE"] },
  "idr_record_sync_gap(text,text,text)": { service_role: ["EXECUTE"] },
  "idr_record_sync_status(text,text,boolean)": { service_role: ["EXECUTE"] },
  "idr_reset_cursor(text,text)": { service_role: ["EXECUTE"] },
  "idr_resolve_sync_gaps(text,text)": { service_role: ["EXECUTE"] },
  "idr_schema_version()": { service_role: ["EXECUTE"] },
  // A trigger function is never called directly: nobody needs EXECUTE on it.
  "idr_sync_gaps_guard()": {},
};

function collect(rows: Array<{ obj: string; grantee: string | null; privilege: string | null }>): Grants {
  const out: Grants = {};
  for (const r of rows) {
    const g = (out[r.obj] ??= {});
    if (r.grantee !== null && r.privilege !== null) (g[r.grantee] ??= []).push(r.privilege);
  }
  for (const g of Object.values(out)) for (const k of Object.keys(g)) g[k]!.sort();
  return out;
}

export async function relationGrants(pool: pg.Pool): Promise<Grants> {
  const r = await pool.query<{ obj: string; grantee: string | null; privilege: string | null }>(
    `select c.relname as obj,
            case when a.grantee is null then null when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
            a.privilege_type as privilege
       from pg_class c
       left join lateral aclexplode(coalesce(c.relacl, acldefault(case c.relkind when 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
         on a.grantee <> c.relowner
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and c.relkind in ('r', 'v', 'S')
      order by 1, 2, 3`,
  );
  return collect(r.rows);
}

export async function functionGrants(pool: pg.Pool): Promise<Grants> {
  const r = await pool.query<{ obj: string; grantee: string | null; privilege: string | null }>(
    `select p.oid::regprocedure::text as obj,
            case when a.grantee is null then null when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
            a.privilege_type as privilege
       from pg_proc p
       left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         on a.grantee <> p.proowner
      where p.pronamespace = 'public'::regnamespace and p.proname like 'idr\\_%'
      order by 1, 2, 3`,
  );
  return collect(r.rows);
}

/** Column-level grants on any idr_* relation (there must be none: every grant is table-wide). */
export async function columnGrants(pool: pg.Pool): Promise<string[]> {
  const r = await pool.query<{ col: string }>(
    `select c.relname || '.' || a.attname as col
       from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and c.relname like 'idr\\_%' and a.attacl is not null
      order by 1`,
  );
  return r.rows.map((x) => x.col);
}
