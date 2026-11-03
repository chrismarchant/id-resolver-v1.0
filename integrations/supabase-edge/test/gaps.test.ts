/**
 * idr_sync_gaps (CHR-66 N1 follow-up): the durable record of a potential
 * synchronisation continuity gap (resolver 410 cursor_expired). Proven at the
 * SQL level against PostgreSQL with the Supabase roles: one open gap per
 * incident, recorded with needs_resync in one call, never deleted, resolved
 * once, readable only with the idr_reader claim, writable only through the
 * service_role functions.
 */
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXPECTED_FUNCTION_GRANTS, EXPECTED_RELATION_GRANTS, functionGrants, relationGrants } from "./helpers/acl.ts";
import { INSTALLATION, SQL_PATH, asRole, freshPublicSchema, gapRows, newPool, resetDatabase, truncateAll } from "./helpers/db.ts";

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
/** Records against the cursor currently stored (what a run that just got 410 holds). */
const recordGap = async () =>
  (
    await svc<{ r: { recorded: boolean; new: boolean; superseded: boolean; gap_id: number } }>(
      "select public.idr_record_sync_gap($1, 'cursor_expired', (select s.cursor from public.idr_sync_state s where s.installation_id = $1)) as r",
      [INSTALLATION],
    )
  ).rows[0]!.r;
/** Resolve as a run that drained to the cursor currently stored. */
const resolveGaps = async (drained?: string) =>
  (
    await svc<{ r: { resolved: number } }>(
      "select public.idr_resolve_sync_gaps($1, coalesce($2, (select s.cursor from public.idr_sync_state s where s.installation_id = $1))) as r",
      [INSTALLATION, drained ?? null],
    )
  ).rows[0]!.r.resolved;
const PENDING = "(select s.reset_from_cursor from public.idr_sync_state s where s.installation_id = $1)";
/**
 * The first page of a replay from the start of the buffer (the stored cursor must be null). By default it is
 * also the replay's final page (has_more = false): the drained flag records the drain, which resolve requires
 * (R2-8). `final: false` uses the five-argument call of schema 4 and 5; the flag then defaults to false.
 */
const replay = (next: string, { final = true }: { final?: boolean } = {}) =>
  final
    ? svc(`select public.idr_apply_feed_page($1, null, $2, '[]'::jsonb, ${PENDING}, true)`, [INSTALLATION, next])
    : svc(`select public.idr_apply_feed_page($1, null, $2, '[]'::jsonb, ${PENDING})`, [INSTALLATION, next]);
/** A later page of the current replay; final by default. */
const nextPage = (expected: string, next: string, { final = true }: { final?: boolean } = {}) =>
  svc("select public.idr_apply_feed_page($1, $2, $3, '[]'::jsonb, null, $4)", [INSTALLATION, expected, next, final]);
const generations = async () =>
  (await pool.query<{ resync: string; replay: string }>("select resync_generation::text as resync, replay_generation::text as replay from public.idr_sync_state")).rows[0];
/** The operator's action, as the owner (the pool's role): service_role may not call it (CHR-66 G5R1-L3). */
const beginResync = () => pool.query("select public.idr_begin_resync($1)", [INSTALLATION]);
const READER = { role: "authenticated", app_metadata: { idr_reader: true } };

describe("recording", () => {
  it("410: one gap row and needs_resync in the same call; bounds come from the stored state", async () => {
    await svc("select public.idr_apply_feed_page($1, null, 'c2', $2::jsonb, null)", [
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
    for (let i = 0; i < 3; i++) expect(await recordGap()).toEqual({ recorded: true, new: false, superseded: false, needs_resync: true, gap_id: first.gap_id });
    expect(await gapRows(pool)).toHaveLength(1);
    expect((await gapRows(pool))[0]).toMatchObject({ expired_cursor: null, last_applied_at: null, last_observed_at: null });
  });

  it("R2-7: a record for a cursor other than the stored one is superseded and writes nothing", async () => {
    await svc("select public.idr_apply_feed_page($1, null, 'c6', '[]'::jsonb, null)", [INSTALLATION]);
    const before = (await pool.query("select cursor, status, needs_resync, updated_at from public.idr_sync_state")).rows[0];
    for (const stale of ["c2", null]) {
      const r = (await svc<{ r: unknown }>("select public.idr_record_sync_gap($1, 'cursor_expired', $2) as r", [INSTALLATION, stale])).rows[0]!.r;
      expect(r, String(stale)).toEqual({ recorded: false, new: false, superseded: true, needs_resync: false, gap_id: null });
    }
    expect((await pool.query("select cursor, status, needs_resync, updated_at from public.idr_sync_state")).rows[0]).toEqual(before);
    expect(await gapRows(pool)).toHaveLength(0);
    // The matching cursor records, and the row carries exactly that cursor.
    expect(await recordGap()).toMatchObject({ recorded: true, new: true, superseded: false });
    expect((await gapRows(pool))[0]!.expired_cursor).toBe("c6");
  });

  it("rejects unknown kinds and empty installation ids", async () => {
    await expect(svc("select public.idr_record_sync_gap($1, 'other', null)", [INSTALLATION])).rejects.toThrow(/invalid_arguments/);
    await expect(svc("select public.idr_record_sync_gap('', 'cursor_expired', null)")).rejects.toThrow(/invalid_arguments/);
    // As the owner (service_role cannot insert at all, R2-8): the table's own check still holds.
    await expect(pool.query("insert into public.idr_sync_gaps (installation_id, kind) values ($1, 'other')", [INSTALLATION])).rejects.toThrow(/check constraint/);
  });
});

describe("resolution", () => {
  it("begin_resync, the replay, then resolve sets resolved_at once; the row persists; nothing before the replay is resolved", async () => {
    await recordGap();
    expect(await resolveGaps("c0")).toBe(0); // needs_resync still set, no resync requested
    await beginResync();
    expect(await resolveGaps("c0")).toBe(0); // requested, but no replay has started
    await replay("c1");
    expect(await resolveGaps("c0")).toBe(0); // not the cursor the replay drained to
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
    await replay("c1");
    await recordGap(); // e.g. retention overtook the replay
    await pool.query("update public.idr_sync_state set needs_resync = false"); // cleared by hand, no new request
    expect(await resolveGaps()).toBe(0);
    expect((await gapRows(pool))[0]!.resolved_at).toBeNull();
  });

  it("R2-9: a resync whose transaction started BEFORE a concurrent gap record but committed after it still resolves that gap (row-lock order, not start time)", async () => {
    const a = await pool.connect();
    try {
      await a.query("begin"); // the operator's transaction, as the owner
      await a.query("select now()"); // the transaction's start timestamp is now fixed
      await new Promise((r) => setTimeout(r, 20));
      const g = await recordGap(); // commits while A is open
      expect(g.new).toBe(true);
      await a.query("select public.idr_begin_resync($1)", [INSTALLATION]);
      await a.query("commit");
    } finally {
      a.release();
    }
    const [gap] = await gapRows(pool);
    const st = (await pool.query<{ t: Date }>("select resync_requested_at as t from public.idr_sync_state")).rows[0]!;
    expect(st.t.getTime()).toBeGreaterThanOrEqual(gap!.detected_at.getTime()); // clock_timestamp() after the lock
    expect(await generations()).toEqual({ resync: "1", replay: "0" });
    await replay("c1");
    expect(await generations()).toEqual({ resync: "1", replay: "1" });
    expect(await resolveGaps()).toBe(1);
  });

  it("R2-9: a drained run cannot resolve once a newer replay has started (cursor compare-and-set), and a gap detected during a replay needs the next resync", async () => {
    await recordGap(); // generation 0
    await beginResync(); // generation 1
    await replay("c1"); // replay of generation 1 drains at c1 ...
    await beginResync(); // ... but before its resolve call the operator resyncs again (generation 2)
    await replay("k2c1"); // and a new replay starts
    expect(await resolveGaps("c1")).toBe(0); // the late resolve of the old drain changes nothing
    expect(await resolveGaps("k2c1")).toBe(1); // the new replay's drain may
    // A gap detected during replay generation 2 is not resolved by that replay.
    await recordGap();
    await pool.query("update public.idr_sync_state set needs_resync = false");
    expect(await resolveGaps()).toBe(0);
    expect((await gapRows(pool)).map((g) => [g.detected_generation, g.resolved_at === null])).toEqual([
      [0, false],
      [2, true],
    ]);
  });
});

describe("R2-6: begin_resync never clears needs_resync without a gap on record", () => {
  const flagOnly = (cursor: string) =>
    // What survives when idr_record_sync_gap failed but the status write succeeded.
    svc("select public.idr_apply_feed_page($1, null, $2, '[]'::jsonb, null)", [INSTALLATION, cursor]).then(() =>
      svc("select public.idr_record_sync_status($1, 'needs_resync', true)", [INSTALLATION]),
    );

  it("records the missing gap itself, bounded by the stored state, before clearing the flag; resolvable after the replay", async () => {
    await flagOnly("c2");
    expect(await gapRows(pool)).toHaveLength(0);
    const r = (await pool.query<{ r: unknown }>("select public.idr_begin_resync($1) as r", [INSTALLATION])).rows[0]!.r;
    expect(r).toEqual({ ok: true, gap_recorded: true });
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "cursor_expired", expired_cursor: "c2", detected_generation: 0, resolved_at: null });
    expect((await pool.query("select needs_resync, cursor from public.idr_sync_state")).rows[0]).toEqual({ needs_resync: false, cursor: null });
    await replay("c1");
    expect(await resolveGaps()).toBe(1);
  });

  it("adds no second row when a gap is already open, and none when needs_resync is not set", async () => {
    await recordGap();
    expect((await pool.query<{ r: unknown }>("select public.idr_begin_resync($1) as r", [INSTALLATION])).rows[0]!.r).toEqual({ ok: true, gap_recorded: false });
    expect(await gapRows(pool)).toHaveLength(1);
    await replay("c1");
    expect((await pool.query<{ r: unknown }>("select public.idr_begin_resync($1) as r", [INSTALLATION])).rows[0]!.r).toEqual({ ok: true, gap_recorded: false });
    expect(await gapRows(pool)).toHaveLength(1);
  });

  it("a voluntary resync keeps the stored cursor (and its generation) for the re-check; one with needs_resync does not", async () => {
    await svc("select public.idr_apply_feed_page($1, null, 'c4', '[]'::jsonb, null)", [INSTALLATION]);
    await beginResync();
    const v = await pool.query("select cursor, reset_from_cursor, reset_from_generation::int as g, resync_generation::int as r from public.idr_sync_state");
    expect(v.rows[0]).toEqual({ cursor: null, reset_from_cursor: "c4", g: 0, r: 1 });
    // A second voluntary resync before any run keeps the same pending position and generation.
    await beginResync();
    expect((await pool.query("select reset_from_cursor, reset_from_generation::int as g from public.idr_sync_state")).rows[0]).toEqual({ reset_from_cursor: "c4", g: 0 });
    // Its 410 records the gap at generation 0 without halting (a resync was requested after it).
    const r = (await svc<{ r: { recorded: boolean; needs_resync: boolean } }>("select public.idr_record_sync_gap($1, 'cursor_expired', 'c4') as r", [INSTALLATION])).rows[0]!.r;
    expect(r).toMatchObject({ recorded: true, needs_resync: false });
    expect((await gapRows(pool))[0]).toMatchObject({ expired_cursor: "c4", detected_generation: 0 });
    expect((await pool.query("select needs_resync, reset_from_cursor from public.idr_sync_state")).rows[0]).toEqual({ needs_resync: false, reset_from_cursor: null });
  });

  it("idr_schema_version() reports the version the engine requires", async () => {
    const { PROJECTION_SCHEMA_VERSION } = await import("../src/core/index.ts");
    expect((await svc<{ v: number }>("select public.idr_schema_version() as v")).rows[0]!.v).toBe(PROJECTION_SCHEMA_VERSION);
    const st = (await svc<{ s: { schema_version: number } }>("select public.idr_get_sync_state($1) as s", [INSTALLATION])).rows[0]!.s;
    expect(st.schema_version).toBe(PROJECTION_SCHEMA_VERSION);
    // The operator documentation names the same version.
    const setup = readFileSync(new URL("../SETUP.md", import.meta.url), "utf8");
    expect(setup).toContain(`(\`idr_schema_version()\`, ${PROJECTION_SCHEMA_VERSION} for this release)`);
  });
});

describe("R2-8: a gap resolves only after a drained replay; service_role cannot assert a resolution", () => {
  it("a replay that has started but not drained cannot resolve the gap, even when service_role calls the resolve itself", async () => {
    await recordGap();
    await beginResync();
    await replay("c1", { final: false }); // the replay's first page; more pages to come
    expect(await generations()).toEqual({ resync: "1", replay: "1" });
    expect(await resolveGaps()).toBe(0); // earlier releases resolved here, on the caller's word alone
    expect((await gapRows(pool))[0]!.resolved_at).toBeNull();
    await nextPage("c1", "c2", { final: false });
    expect(await resolveGaps()).toBe(0);
    await nextPage("c2", "c3"); // the final page: the drain is recorded with it
    expect((await pool.query("select drained_generation::int as d from public.idr_sync_state")).rows[0]).toEqual({ d: 1 });
    expect(await resolveGaps()).toBe(1);
    expect((await gapRows(pool))[0]).toMatchObject({ resolution: "full_resync" });
  });

  it("a drain recorded for an earlier replay does not count for a newer one", async () => {
    await replay("c1"); // replay of generation 0 drains
    await recordGap(); // detected at generation 0
    await beginResync(); // generation 1
    await replay("k2c1", { final: false }); // the new replay starts but has not drained
    expect((await pool.query("select drained_generation::int as d, replay_generation::int as r from public.idr_sync_state")).rows[0]).toEqual({ d: 0, r: 1 });
    expect(await resolveGaps()).toBe(0);
    await nextPage("k2c1", "k2c2");
    expect(await resolveGaps()).toBe(1);
  });

  it("service_role cannot insert or update gap rows, nor write idr_sync_state or the projection tables directly", async () => {
    await svc("select public.idr_apply_feed_page($1, null, 'c2', $2::jsonb, null)", [
      INSTALLATION,
      JSON.stringify([{ type: "observation", observation_id: "1", company_id: 7, domain: "example.com", organisation_name: null, observed_at: "2026-11-02T09:00:00.000Z", method: "cache", page_key: "/", acquisition: null, entrance_contract: null }]),
    ]);
    const g = await recordGap();
    await beginResync();
    const snapshot = async () => ({
      state: (await pool.query("select * from public.idr_sync_state")).rows,
      gaps: await gapRows(pool),
      counts: (await pool.query("select (select count(*) from public.idr_companies)::int c, (select count(*) from public.idr_observations)::int o, (select count(*) from public.idr_tombstones)::int t")).rows,
    });
    const before = await snapshot();
    const writes: Array<[string, unknown[]]> = [
      // A fabricated gap, already resolved or open, and a resolution without a replay.
      ["insert into public.idr_sync_gaps (installation_id, kind, resolved_at, resolution) values ($1, 'cursor_expired', now(), 'full_resync')", [INSTALLATION]],
      ["insert into public.idr_sync_gaps (installation_id, kind) values ('other', 'cursor_expired')", []],
      [`update public.idr_sync_gaps set resolved_at = now(), resolution = 'full_resync' where id = ${g.gap_id}`, []],
      // The resync and gap columns of the state, which decide whether a gap may resolve.
      ["update public.idr_sync_state set replay_generation = replay_generation + 5", []],
      ["update public.idr_sync_state set drained_generation = replay_generation", []],
      ["update public.idr_sync_state set resync_generation = 0, resync_requested_at = now()", []],
      ["update public.idr_sync_state set needs_resync = false", []],
      ["update public.idr_sync_state set reset_from_cursor = null, reset_from_generation = null", []],
      ["update public.idr_sync_state set cursor = 'c9', status = 'ok'", []],
      ["insert into public.idr_sync_state (installation_id) values ('other')", []],
      ["delete from public.idr_sync_state", []],
      // The projection itself.
      ["insert into public.idr_companies (installation_id, company_id, domain) values ($1, 99, 'example.org')", [INSTALLATION]],
      ["update public.idr_observations set method = 'x'", []],
      ["delete from public.idr_companies", []],
      ["delete from public.idr_tombstones", []],
    ];
    for (const [sql, args] of writes) await expect(svc(sql, args), sql).rejects.toThrow(/permission denied/);
    expect(await snapshot()).toEqual(before);
    expect(before.gaps[0]!.resolved_at).toBeNull();
  });

  it("not even the owner (nor so any function) can insert an already resolved gap: the guard checks inserts too", async () => {
    await expect(
      pool.query("insert into public.idr_sync_gaps (installation_id, kind, resolved_at, resolution) values ($1, 'cursor_expired', now(), 'full_resync')", [INSTALLATION]),
    ).rejects.toThrow(/recorded open/);
    expect(await gapRows(pool)).toHaveLength(0);
  });

  it("the normal resync-then-drain path still resolves, through the functions alone", async () => {
    await replay("c2");
    await recordGap();
    expect(await resolveGaps()).toBe(0); // needs_resync, no resync requested
    await beginResync();
    await replay("c1", { final: false });
    await nextPage("c1", "c2");
    expect(await resolveGaps()).toBe(1);
    expect((await gapRows(pool)).map((x) => [x.resolution, x.detected_generation])).toEqual([["full_resync", 0]]);
  });

  it("the writing functions refuse malformed arguments and write nothing", async () => {
    const many = `(select jsonb_agg(jsonb_build_object('type', 'observation')) from generate_series(1, 1001))`;
    const bad: Array<[string, unknown[]]> = [
      ["select public.idr_apply_feed_page($1, null, 'c1', '[]'::jsonb, null, null)", [INSTALLATION]],
      ["select public.idr_apply_feed_page($1, null, 'c1', '{}'::jsonb, null, false)", [INSTALLATION]],
      ["select public.idr_apply_feed_page($1, null, 'c1', '[1]'::jsonb, null, false)", [INSTALLATION]],
      [`select public.idr_apply_feed_page($1, null, 'c1', '[{"type":"other"}]'::jsonb, null, false)`, [INSTALLATION]],
      [`select public.idr_apply_feed_page($1, null, 'c1', '[{"kind":"observation"}]'::jsonb, null, false)`, [INSTALLATION]],
      [`select public.idr_apply_feed_page($1, null, 'c1', ${many}, null, false)`, [INSTALLATION]],
      ["select public.idr_apply_feed_page($1, '', 'c1', '[]'::jsonb, null, false)", [INSTALLATION]],
      ["select public.idr_apply_feed_page($1, null, '', '[]'::jsonb, null, false)", [INSTALLATION]],
      ["select public.idr_apply_feed_page($1, null, 'c1', '[]'::jsonb, '', false)", [INSTALLATION]],
      ["select public.idr_apply_feed_page(repeat('x', 129), null, 'c1', '[]'::jsonb, null, false)", []],
      ["select public.idr_apply_feed_page($1, null, repeat('c', 4097), '[]'::jsonb, null, false)", [INSTALLATION]],
      ["select public.idr_reset_cursor($1, '')", [INSTALLATION]],
      ["select public.idr_record_sync_status('', 'ok', null)", []],
      ["select public.idr_record_sync_status($1, null, null)", [INSTALLATION]],
      ["select public.idr_record_sync_gap($1, 'cursor_expired', '')", [INSTALLATION]],
      ["select public.idr_resolve_sync_gaps('', 'c1')", []],
      ["select public.idr_resolve_sync_gaps($1, '')", [INSTALLATION]],
    ];
    for (const [sql, args] of bad) await expect(svc(sql, args), sql).rejects.toThrow(/invalid_arguments/);
    // The operator's function, called as the owner.
    for (const sql of ["select public.idr_begin_resync('')", "select public.idr_begin_resync(null)"]) await expect(pool.query(sql), sql).rejects.toThrow(/invalid_arguments/);
    expect((await pool.query("select count(*)::int as n from public.idr_sync_state")).rows[0].n).toBe(0);
    expect(await gapRows(pool)).toHaveLength(0);
  });
});

describe("G5R1-L3: only the owner may release a halted gap (idr_begin_resync is not executable by service_role)", () => {
  it("service_role, anon and authenticated cannot execute idr_begin_resync; the owner can", async () => {
    await recordGap();
    for (const role of ["service_role", "anon", "authenticated"]) {
      await expect(asRole(pool, role, (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION])), role).rejects.toThrow(/permission denied/);
    }
    expect((await pool.query("select needs_resync from public.idr_sync_state")).rows[0]).toEqual({ needs_resync: true });
    expect((await beginResync()).rows[0]).toBeDefined();
    expect((await pool.query("select needs_resync from public.idr_sync_state")).rows[0]).toEqual({ needs_resync: false });
  });

  it("the review's forged-drain sequence (P2) no longer resolves a halted gap: service_role cannot release it, and every other call leaves it open", async () => {
    await svc("select public.idr_apply_feed_page($1, null, 'real-c1', '[]'::jsonb, null)", [INSTALLATION]);
    await recordGap(); // halted: needs_resync
    // 1. release the halt: refused (it was allowed before G5R1-L3)
    await expect(svc("select public.idr_begin_resync($1)", [INSTALLATION])).rejects.toThrow(/permission denied/);
    // 2. a fabricated "final" page, from null and from the stored cursor
    expect((await svc<{ r: { applied: boolean } }>("select public.idr_apply_feed_page($1, null, 'forged', '[]'::jsonb, null, true) as r", [INSTALLATION])).rows[0]!.r.applied).toBe(false);
    expect((await svc<{ r: { applied: boolean } }>("select public.idr_apply_feed_page($1, 'real-c1', 'forged', '[]'::jsonb, null, true) as r", [INSTALLATION])).rows[0]!.r.applied).toBe(true);
    // 3. resolve: nothing, the halt is still in place
    expect(await resolveGaps("forged")).toBe(0);
    expect((await gapRows(pool)).map((g) => g.resolved_at)).toEqual([null]);
    expect((await pool.query("select needs_resync from public.idr_sync_state")).rows[0]).toEqual({ needs_resync: true });
  });

  it("documented residual: once the owner has requested a resync, the key can still assert a drain (the SQL cannot verify the feed)", async () => {
    await svc("select public.idr_apply_feed_page($1, null, 'real-c1', '[]'::jsonb, null)", [INSTALLATION]);
    await recordGap();
    await beginResync(); // the operator's legitimate request
    await svc("select public.idr_apply_feed_page($1, null, 'forged', '[]'::jsonb, null, true)", [INSTALLATION]);
    expect(await resolveGaps("forged")).toBe(1);
  });
});

describe("append-only guard", () => {
  it("rejects DELETE, TRUNCATE, re-resolving and changing any other column, even for the table owner", async () => {
    await recordGap();
    await beginResync();
    await replay("c1");
    expect(await resolveGaps()).toBe(1);
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
      "select public.idr_record_sync_gap('x', 'cursor_expired', null)",
      "select public.idr_resolve_sync_gaps('x', 'c1')",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        await expect(asRole(pool, role, (c) => c.query(sql), READER), `${role}: ${sql}`).rejects.toThrow(/permission denied/);
      }
    }
    expect((await gapRows(pool))[0]!.resolved_at).toBeNull();
  });
});

describe("R2-8 with an ordinary owner: the script applied by a role that is neither superuser nor BYPASSRLS (on Supabase, postgres is not a superuser)", () => {
  const OWNER = "idr_test_owner";
  beforeAll(async () => {
    await freshPublicSchema(pool);
    await pool.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${OWNER}') then create role ${OWNER} nologin nosuperuser nobypassrls; end if; end $$`);
    await pool.query(`grant usage, create on schema public to ${OWNER}`);
    await pool.query(`grant usage on schema auth to ${OWNER}`);
    // Supabase's default privileges, for objects this role creates.
    for (const kind of ["tables", "sequences", "functions"]) {
      await pool.query(`alter default privileges for role ${OWNER} in schema public grant all on ${kind} to anon, authenticated, service_role`);
    }
    const c = await pool.connect();
    try {
      await c.query(`set role ${OWNER}`);
      await c.query(readFileSync(SQL_PATH, "utf8"));
    } finally {
      await c.query("reset role").catch(() => undefined);
      c.release();
    }
  });
  afterAll(async () => {
    await resetDatabase(pool);
    await pool.query(`drop owned by ${OWNER}`);
    await pool.query(`drop role ${OWNER}`);
  });

  it("everything is owned by that role, which has no superuser or BYPASSRLS attribute; the grants are exactly as with any owner", async () => {
    const owners = await pool.query<{ o: string }>(
      `select distinct o from (select relowner::regrole::text o from pg_class where relnamespace = 'public'::regnamespace and relname like 'idr\\_%'
                               union all select proowner::regrole::text from pg_proc where pronamespace = 'public'::regnamespace and proname like 'idr\\_%') x`,
    );
    expect(owners.rows).toEqual([{ o: OWNER }]);
    expect((await pool.query("select rolsuper, rolbypassrls from pg_roles where rolname = $1", [OWNER])).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(await relationGrants(pool)).toEqual(EXPECTED_RELATION_GRANTS);
    expect(await functionGrants(pool)).toEqual(EXPECTED_FUNCTION_GRANTS);
  });

  it("through the definer functions only: the engine's calls as service_role, the resync as the owner; apply, record, resync, a partial replay (no resolution), the final page, resolve", async () => {
    const item = { type: "observation", observation_id: "1", company_id: 7, domain: "example.com", organisation_name: null, observed_at: "2026-11-02T09:00:00.000Z", method: "cache", page_key: "/", acquisition: null, entrance_contract: null };
    expect((await svc<{ r: unknown }>("select public.idr_apply_feed_page($1, null, 'c2', $2::jsonb, null, true) as r", [INSTALLATION, JSON.stringify([item])])).rows[0]!.r).toEqual({ applied: true, observations: 1, tombstones: 0 });
    expect(await recordGap()).toMatchObject({ recorded: true, new: true });
    await expect(svc("select public.idr_begin_resync($1)", [INSTALLATION])).rejects.toThrow(/permission denied/);
    await asRole(pool, OWNER, (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    await replay("c1", { final: false });
    expect(await resolveGaps()).toBe(0);
    await nextPage("c1", "c2");
    expect(await resolveGaps()).toBe(1);
    await svc("select public.idr_record_sync_status($1, 'ok', null)", [INSTALLATION]);
    await svc("select public.idr_reset_cursor($1, 'c2')", [INSTALLATION]);
    expect((await pool.query("select status, cursor, reset_from_cursor from public.idr_sync_state")).rows[0]).toEqual({ status: "ok", cursor: null, reset_from_cursor: "c2" });
    // The read function is SECURITY INVOKER and works with service_role's SELECT.
    const st = (await svc<{ s: { gap_open: boolean; schema_version: number } }>("select public.idr_get_sync_state($1) as s", [INSTALLATION])).rows[0]!.s;
    expect(st).toMatchObject({ gap_open: false });
    // Direct writes are still refused.
    await expect(svc("update public.idr_sync_state set needs_resync = false")).rejects.toThrow(/permission denied/);
    await expect(svc("insert into public.idr_sync_gaps (installation_id, kind) values ($1, 'cursor_expired')", [INSTALLATION])).rejects.toThrow(/permission denied/);
  });
});
