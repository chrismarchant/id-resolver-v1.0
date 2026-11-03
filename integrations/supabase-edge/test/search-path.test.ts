/**
 * CHR-66 G5R1-M1: the SECURITY DEFINER functions must not resolve a type name
 * in the caller's temporary schema.
 *
 * PostgreSQL searches the session's temporary schema for relation and type
 * names, and FIRST unless the search_path lists pg_temp explicitly (an empty
 * search_path does not). A caller could create pg_temp.text, jsonb or
 * timestamptz as a domain whose CHECK runs its own function; a definer
 * function that declared or cast to that type ran it with the OWNER's rights.
 * Every idr_* function now has `search_path = pg_catalog, pg_temp` (temp
 * schema last), and the writing functions also name pg_catalog types
 * explicitly.
 *
 * The script is applied by an ordinary owner (neither superuser nor
 * BYPASSRLS), as on hosted Supabase. The probes run in ONE service_role
 * session, since temporary objects belong to a session.
 */
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXPECTED_FUNCTION_GRANTS, EXPECTED_RELATION_GRANTS, functionGrants, relationGrants } from "./helpers/acl.ts";
import { INSTALLATION, dropOwner, ensureProjection, gapRows, installAsOwner, newPool, truncateAll } from "./helpers/db.ts";

const OWNER = "idr_test_owner";
const SHADOWED = ["text", "jsonb", "timestamptz"];
let pool: pg.Pool;

beforeAll(async () => {
  pool = newPool();
  await ensureProjection(pool); // the Supabase roles and auth.jwt()
  await installAsOwner(pool, OWNER);
});
afterAll(async () => {
  await dropOwner(pool, OWNER);
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

/**
 * A service_role session with the attack in place: pg_temp domains named after
 * the shadowable types, whose CHECK records `<tag>:<current_user>` in a session
 * setting and, when it runs as anyone but service_role, tries what an attacker
 * would do with the owner's rights (a persistent write grant, as in the
 * review's probe P1). Also pg_temp functions named after functions the bodies
 * call, which must never run (functions are never looked up in pg_temp).
 */
async function attackerSession(): Promise<{ c: pg.PoolClient; seen: () => Promise<string[]>; done: () => void }> {
  const c = await pool.connect();
  await c.query("set role service_role");
  await c.query(`
    create function pg_temp.idr_probe(tag pg_catalog.text) returns pg_catalog.bool
      language plpgsql set search_path = pg_catalog, pg_temp as $f$
    begin
      perform pg_catalog.set_config('idr_test.seen',
        coalesce(pg_catalog.current_setting('idr_test.seen', true), '')
          || coalesce(nullif(pg_catalog.current_setting('idr_test.fn', true), '') || '/', '')
          || tag || ':' || current_user::pg_catalog.text || ';', false);
      if current_user::pg_catalog.text <> 'service_role' then
        begin
          execute 'grant insert, update, delete on public.idr_sync_state, public.idr_sync_gaps to service_role';
        exception when others then null;
        end;
      end if;
      return true;
    end $f$`);
  for (const t of SHADOWED) {
    await c.query(`create domain pg_temp.${t} as pg_catalog.${t} check (pg_temp.idr_probe('${t}'))`);
  }
  for (const [name, args, ret] of [
    ["now", "", "pg_catalog.timestamptz"],
    ["clock_timestamp", "", "pg_catalog.timestamptz"],
    ["char_length", "v pg_catalog.text", "pg_catalog.int4"],
    ["jsonb_typeof", "v pg_catalog.jsonb", "pg_catalog.text"],
  ] as const) {
    await c.query(
      `create function pg_temp.${name}(${args}) returns ${ret} language plpgsql set search_path = pg_catalog, pg_temp as $f$
       begin perform pg_temp.idr_probe('fn_${name}'); return null; end $f$`,
    );
  }
  const seen = async () => {
    const r = await c.query<{ s: string | null }>("select pg_catalog.current_setting('idr_test.seen', true) as s");
    return (r.rows[0]!.s ?? "").split(";").filter((x) => x !== "");
  };
  // Destroy the connection afterwards, and with it the temporary objects.
  return { c, seen, done: () => c.release(true) };
}

describe("G5R1-M1: no SECURITY DEFINER function can be hijacked through pg_temp", () => {
  it("every idr_* function has search_path = pg_catalog, pg_temp (the temporary schema explicitly last)", async () => {
    const r = await pool.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      "select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname like 'idr\\_%' order by 1",
    );
    expect(r.rows.filter((x) => x.prosecdef)).toHaveLength(6);
    for (const row of r.rows) expect(row.proconfig, row.proname).toEqual(["search_path=pg_catalog, pg_temp"]);
  });

  it("control: in the attacker's session the shadowing domains are live, and their CHECK records the caller", async () => {
    const a = await attackerSession();
    try {
      // Unqualified type names in this session resolve to the pg_temp domains first.
      for (const [t, v] of [["text", "x"], ["jsonb", "{}"], ["timestamptz", "2026-11-03T00:00:00Z"]] as const) await a.c.query(`select $1::${t}`, [v]);
      expect(await a.seen()).toEqual(["text:service_role", "jsonb:service_role", "timestamptz:service_role"]);
    } finally {
      a.done();
    }
  });

  it("the six writing functions, called by a caller that shadows text, jsonb and timestamptz, never run its code as the owner; nothing is hijacked", async () => {
    // idr_begin_resync is the owner's action (G5R1-L3); grant it here so that it is attacked too,
    // as by any role a client might let call it.
    await pool.query("grant execute on function public.idr_begin_resync(text) to service_role");
    const a = await attackerSession();
    try {
      const call = async (sql: string, args: unknown[]) => {
        await a.c.query("select pg_catalog.set_config('idr_test.fn', $1, false)", [/public\.(idr_[a-z_]+)\(/.exec(sql)![1]]);
        return a.c.query(sql, args);
      };
      const item = { type: "observation", observation_id: "1", company_id: 7, domain: "example.com", organisation_name: null, observed_at: "2026-11-02T09:00:00.000Z", method: "cache", page_key: "/", acquisition: null, entrance_contract: null };
      const tomb = { type: "company_erased", tombstone_id: "1", company_id: 8, erased_at: "2026-11-02T10:00:00.000Z" };
      // A page with items (reaches every cast), its status, a 400 reset, the replay's first page,
      // a 410 record, the operator's resync, a drained replay and the resolution: all six functions.
      await call("select public.idr_apply_feed_page($1, null, 'c1', $2::pg_catalog.jsonb, null, true)", [INSTALLATION, JSON.stringify([item, tomb])]);
      await call("select public.idr_record_sync_status($1, 'ok', false)", [INSTALLATION]);
      await call("select public.idr_reset_cursor($1, 'c1')", [INSTALLATION]);
      await call("select public.idr_apply_feed_page($1, null, 'c2', $2::pg_catalog.jsonb, 'c1', true)", [INSTALLATION, JSON.stringify([item])]);
      await call("select public.idr_record_sync_gap($1, 'cursor_expired', 'c2')", [INSTALLATION]);
      await call("select public.idr_begin_resync($1)", [INSTALLATION]);
      await call("select public.idr_apply_feed_page($1, null, 'c3', $2::pg_catalog.jsonb, null, true)", [INSTALLATION, JSON.stringify([item])]);
      const resolved = await call("select public.idr_resolve_sync_gaps($1, 'c3') as r", [INSTALLATION]);
      expect(resolved.rows[0].r).toEqual({ resolved: 1 }); // the functions still work
      const seen = await a.seen();
      expect(seen.filter((x) => !x.endsWith(":service_role")), seen.join(" ")).toEqual([]); // never the owner
      expect(seen.filter((x) => x.includes("/fn_")), seen.join(" ")).toEqual([]); // pg_temp functions never resolve
    } finally {
      a.done();
      await pool.query("revoke execute on function public.idr_begin_resync(text) from service_role");
    }
    // Nothing was granted, disabled or written behind the functions' backs.
    expect(await relationGrants(pool)).toEqual(EXPECTED_RELATION_GRANTS);
    expect(await functionGrants(pool)).toEqual(EXPECTED_FUNCTION_GRANTS);
    const trig = await pool.query("select tgname, tgenabled from pg_trigger where tgrelid = 'public.idr_sync_gaps'::regclass and not tgisinternal order by 1");
    expect(trig.rows).toEqual([
      { tgname: "idr_sync_gaps_guard_row", tgenabled: "O" },
      { tgname: "idr_sync_gaps_guard_truncate", tgenabled: "O" },
    ]);
    expect((await gapRows(pool)).map((g) => g.resolution)).toEqual(["full_resync"]);
    expect((await pool.query("select count(*)::int as n from public.idr_observations")).rows[0].n).toBe(1);
  });
});
