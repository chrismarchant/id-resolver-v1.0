/**
 * idr_sync_gaps (CHR-66 N1 follow-up): the durable record of a potential
 * synchronisation continuity gap (resolver 410 cursor_expired). Proven at the
 * SQL level against PostgreSQL with the Supabase roles: one open gap per
 * incident, recorded with needs_resync in one call, never deleted, resolved
 * once, readable only with the idr_reader claim, writable only through the
 * service_role functions.
 */
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INSTALLATION, asRole, gapRows, newPool, resetDatabase, truncateAll } from "./helpers/db.ts";

let pool: pg.Pool;

beforeAll(async () => {
  pool = newPool();
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});

const svc = <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => asRole(pool, "service_role", (c) => c.query<T>(sql, args));
const recordGap = async () => (await svc<{ r: { recorded: boolean; new: boolean; gap_id: number } }>("select public.idr_record_sync_gap($1, 'cursor_expired') as r", [INSTALLATION])).rows[0]!.r;
const resolveGaps = async () => (await svc<{ r: { resolved: number } }>("select public.idr_resolve_sync_gaps($1) as r", [INSTALLATION])).rows[0]!.r.resolved;
const beginResync = () => svc("select public.idr_begin_resync($1)", [INSTALLATION]);
const READER = { role: "authenticated", app_metadata: { idr_reader: true } };

describe("recording", () => {
  it("410: one gap row and needs_resync in the same call; bounds come from the stored state", async () => {
    await svc("select public.idr_apply_feed_page($1, null, 'c2', $2::jsonb)", [
      INSTALLATION,
      JSON.stringify([{ type: "observation", observation_id: "1", company_id: 7, domain: "example.com", organisation_name: null, observed_at: "2026-11-02T09:00:00.000Z", method: "cache", page_key: "/", acquisition: null, entrance_contract: null }]),
    ]);
    const r = await recordGap();
    expect(r).toMatchObject({ recorded: true, new: true });
    const st = await pool.query("select status, needs_resync from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ status: "needs_resync", needs_resync: true });
    const [g] = await gapRows(pool);
    expect(g).toMatchObject({ id: r.gap_id, kind: "cursor_expired", expired_cursor: "c2", resolved_at: null, resolution: null });
    expect(g!.last_observed_at).toEqual(new Date("2026-11-02T09:00:00.000Z"));
    expect(g!.last_applied_at).toBeInstanceOf(Date);
  });

  it("repeated records while the gap is open return the same row; a gap with no prior state still records", async () => {
    const first = await recordGap();
    for (let i = 0; i < 3; i++) expect(await recordGap()).toEqual({ recorded: true, new: false, gap_id: first.gap_id });
    expect(await gapRows(pool)).toHaveLength(1);
    expect((await gapRows(pool))[0]).toMatchObject({ expired_cursor: null, last_applied_at: null, last_observed_at: null });
  });

  it("rejects unknown kinds and empty installation ids", async () => {
    await expect(svc("select public.idr_record_sync_gap($1, 'other')", [INSTALLATION])).rejects.toThrow(/invalid_arguments/);
    await expect(svc("select public.idr_record_sync_gap('', 'cursor_expired')")).rejects.toThrow(/invalid_arguments/);
    await expect(svc("insert into public.idr_sync_gaps (installation_id, kind) values ($1, 'other')", [INSTALLATION])).rejects.toThrow(/check constraint/);
  });
});

describe("resolution", () => {
  it("begin_resync then resolve sets resolved_at once; the row persists; nothing before a resync request is resolved", async () => {
    await recordGap();
    expect(await resolveGaps()).toBe(0); // needs_resync still set, no resync requested
    await beginResync();
    expect(await resolveGaps()).toBe(1);
    const [g] = await gapRows(pool);
    expect(g).toMatchObject({ resolution: "full_resync" });
    expect(g!.resolved_at).toBeInstanceOf(Date);
    expect(await resolveGaps()).toBe(0);
    expect((await gapRows(pool))[0]!.resolved_at).toEqual(g!.resolved_at);
    // A new incident is a new row; the old one stays.
    const next = await recordGap();
    expect(next.new).toBe(true);
    expect((await gapRows(pool)).map((x) => x.resolved_at === null)).toEqual([false, true]);
  });

  it("a gap detected after the latest resync request stays open", async () => {
    await beginResync();
    await recordGap(); // e.g. retention overtook the replay
    await pool.query("update public.idr_sync_state set needs_resync = false"); // cleared by hand, no new request
    expect(await resolveGaps()).toBe(0);
    expect((await gapRows(pool))[0]!.resolved_at).toBeNull();
  });
});

describe("append-only guard", () => {
  it("rejects DELETE, TRUNCATE, re-resolving and changing any other column, even for the table owner", async () => {
    await recordGap();
    await beginResync();
    await resolveGaps();
    const open = await recordGap();
    for (const sql of [
      "delete from public.idr_sync_gaps",
      "truncate public.idr_sync_gaps",
      "update public.idr_sync_gaps set resolved_at = now(), resolution = 'full_resync' where resolved_at is not null", // re-resolve
      `update public.idr_sync_gaps set kind = 'cursor_expired', detected_at = now() where id = ${open.gap_id}`,
      `update public.idr_sync_gaps set expired_cursor = 'c0', resolved_at = now(), resolution = 'full_resync' where id = ${open.gap_id}`,
      `update public.idr_sync_gaps set resolution = 'full_resync' where id = ${open.gap_id}`, // pair check / guard
      `update public.idr_sync_gaps set installation_id = 'other' where id = ${open.gap_id}`,
    ]) {
      await expect(pool.query(sql), sql).rejects.toThrow(/append-only|already resolved|only an open gap|resolution_pair/);
    }
    expect(await gapRows(pool)).toHaveLength(2);
  });

  it("service_role has no DELETE or TRUNCATE privilege on the table", async () => {
    await recordGap();
    await expect(svc("delete from public.idr_sync_gaps")).rejects.toThrow(/permission denied/);
    await expect(svc("truncate public.idr_sync_gaps")).rejects.toThrow(/permission denied/);
    expect(await gapRows(pool)).toHaveLength(1);
  });
});

describe("row level security", () => {
  it("a reader with the app_metadata.idr_reader claim can read the gaps", async () => {
    await recordGap();
    const r = await asRole(pool, "authenticated", (c) => c.query("select kind, resolved_at from public.idr_sync_gaps"), READER);
    expect(r.rows).toEqual([{ kind: "cursor_expired", resolved_at: null }]);
  });

  it("anon is denied; authenticated without the claim (or with it only in user_metadata) sees nothing", async () => {
    await recordGap();
    await expect(asRole(pool, "anon", (c) => c.query("select * from public.idr_sync_gaps"))).rejects.toThrow(/permission denied/);
    for (const claims of [undefined, {}, { role: "authenticated", user_metadata: { idr_reader: true } }, { app_metadata: { idr_reader: "true " } }]) {
      const r = await asRole(pool, "authenticated", (c) => c.query("select count(*)::int as n from public.idr_sync_gaps"), claims);
      expect(r.rows[0].n, JSON.stringify(claims)).toBe(0);
    }
  });

  it("authenticated users (even readers) cannot write, delete or call the gap functions", async () => {
    const g = await recordGap();
    for (const sql of [
      "insert into public.idr_sync_gaps (installation_id, kind) values ('x', 'cursor_expired')",
      `update public.idr_sync_gaps set resolved_at = now(), resolution = 'full_resync' where id = ${g.gap_id}`,
      "delete from public.idr_sync_gaps",
      "select public.idr_record_sync_gap('x', 'cursor_expired')",
      "select public.idr_resolve_sync_gaps('x')",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        await expect(asRole(pool, role, (c) => c.query(sql), READER), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
      }
    }
    expect((await gapRows(pool))[0]!.resolved_at).toBeNull();
  });
});
