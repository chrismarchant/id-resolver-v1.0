/**
 * Upgrade path of sql/0001_idr_projection.sql (CHR-66 round 3): the script
 * must stay re-runnable over installs of earlier releases, keeping every
 * existing row. Fixtures are verbatim copies of the script as released at
 * 6318ab2 (before the gap log) and f12b1ad (gap log, round 2).
 */
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSync } from "../src/core/index.ts";
import { INSTALLATION, PgStore, asRole, counts, ensureProjection, gapRows, newPool, resetDatabase, storedCursor } from "./helpers/db.ts";
import { MockResolver, obs } from "./helpers/mock-resolver.ts";
import { testConfig, testDeps } from "./helpers/setup.ts";

const fixture = (rel: string) => fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
const LEGACY = {
  "6318ab2": fixture("0001_idr_projection.6318ab2.sql"),
  f12b1ad: fixture("0001_idr_projection.f12b1ad.sql"),
} as const;
const D = "2026-11-02T12:00:00.000Z";

let pool: pg.Pool;
const mock = new MockResolver();

beforeAll(async () => {
  pool = newPool();
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
  // Leave the current schema behind for any later suite.
  await resetDatabase(pool);
  await pool.end();
});
beforeEach(() => {
  mock.reset();
});

async function installLegacy(version: keyof typeof LEGACY): Promise<void> {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await ensureProjection(pool, LEGACY[version]);
}

/** A consumer that applied obs 1-2 (cursor c2) through the legacy functions. */
async function seedLegacyState(version: keyof typeof LEGACY): Promise<void> {
  await asRole(pool, "service_role", (c) =>
    c.query("select public.idr_apply_feed_page($1, null, 'c2', $2::jsonb)", [INSTALLATION, JSON.stringify([obs(1, 7, D), obs(2, 7, D)])]),
  );
  if (version === "f12b1ad") {
    // Round-2 gap record (two-argument function of that release): an open gap with needs_resync.
    await asRole(pool, "service_role", (c) => c.query("select public.idr_record_sync_gap($1, 'cursor_expired')", [INSTALLATION]));
  } else {
    await asRole(pool, "service_role", (c) => c.query("select public.idr_record_sync_status($1, 'needs_resync', true)", [INSTALLATION]));
  }
}

const idrFunctions = async () =>
  (
    await pool.query<{ sig: string; acl: string[] }>(
      "select p.oid::regprocedure::text as sig, p.proacl::text[] as acl from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'idr\\_%' order by 1",
    )
  ).rows;

describe.each(["6318ab2", "f12b1ad"] as const)("upgrade from the %s release", (version) => {
  it("re-running the current script (twice) keeps every row, drops superseded signatures and converges grants", async () => {
    await installLegacy(version);
    await seedLegacyState(version);
    const before = { counts: await counts(pool), gaps: version === "6318ab2" ? [] : await gapRows(pool) };
    if (version === "f12b1ad") expect(before.gaps).toHaveLength(1);
    expect(before.counts.observations).toBe(2);

    await ensureProjection(pool);
    await ensureProjection(pool);

    expect(await counts(pool)).toEqual(before.counts);
    expect(await storedCursor(pool)).toBe("c2");
    const st = await pool.query("select needs_resync, reset_from_cursor from public.idr_sync_state");
    expect(st.rows[0]).toEqual({ needs_resync: true, reset_from_cursor: null });
    expect((await gapRows(pool)).map((g) => [g.id, g.kind, g.resolved_at])).toEqual(before.gaps.map((g) => [g.id, g.kind, g.resolved_at]));

    const fns = await idrFunctions();
    const sigs = fns.map((f) => f.sig);
    expect(sigs).not.toContain("idr_apply_feed_page(text,text,text,jsonb)");
    expect(sigs).not.toContain("idr_record_sync_gap(text,text)");
    expect(sigs).toContain("idr_apply_feed_page(text,text,text,jsonb,text)");
    expect(sigs).toContain("idr_record_sync_gap(text,text,text)");
    for (const f of fns) expect(f.acl.map((a) => a.split("=")[0]).sort(), f.sig).toEqual(["resolver", "service_role"]);
  });

  it("the current engine then records (or keeps) exactly one gap, and resync + drain resolves it without losing the row", async () => {
    await installLegacy(version);
    await seedLegacyState(version);
    await ensureProjection(pool);
    const store = new PgStore(pool);
    mock.items = [1, 2, 3, 4].map((i) => obs(i, 7, D));

    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r.status).toBe("needs_resync");
    expect(r.gap).toMatchObject({ recorded: true, newGap: version === "6318ab2" });
    expect(await gapRows(pool)).toHaveLength(1);

    await asRole(pool, "service_role", (c) => c.query("select public.idr_begin_resync($1)", [INSTALLATION]));
    const ok = await runSync(testConfig(mock), testDeps(store));
    expect(ok).toMatchObject({ status: "ok", gapsResolved: 1 });
    const gaps = await gapRows(pool);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ resolution: "full_resync" });
    expect((await counts(pool)).observations).toBe(4);
  });
});
