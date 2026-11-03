/**
 * Gate 5: the smoke test's read-only events probe (src/ops/smoke-events-db.ts)
 * against PostgreSQL with the real event repository:
 *   - it reads this run's rows by page_key, with exactly the 0008 columns and
 *     the inserting transaction ids;
 *   - the same-transaction check is clean for the real event insert, and
 *     catches a company or observation written in the same transaction (a
 *     simulated D4 violation, by trigger);
 *   - the page_key-scoped observation check and the high-water marks catch a
 *     write made in a separate transaction;
 *   - it never writes: every statement is a SELECT inside BEGIN READ ONLY.
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { BROWSER_EVENT_COLUMNS, createEventsDbProbe, NON_EVENT_TABLES, windowVerdict } from "../../src/ops/smoke-events-db.js";
import type { Pool } from "../../src/db/pool.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";

const SCOPE = { installationId: "inst-test", websiteId: "site-test" };
const RUN = "abcdef0123";
const PAGE_KEY = `/smoke/${RUN}/ev`;
let seq = 0;
const eventId = () => `smoke_evdb_${String(++seq).padStart(12, "0")}`;

describe("smoke events probe against PostgreSQL", () => {
  let db: Db;
  const record = (pageKey = PAGE_KEY, over: { type?: string; name?: string; installationId?: string } = {}) =>
    db.events.record({
      installationId: over.installationId ?? SCOPE.installationId,
      websiteId: SCOPE.websiteId,
      eventId: eventId(),
      type: over.type ?? "page_view",
      name: over.name ?? "page_view",
      pageKey,
      consent: "granted",
      occurredAt: new Date(),
    });
  const dropLeak = async () => {
    await db.pool.query("DROP TRIGGER IF EXISTS g5c_events_leak ON browser_events");
    await db.pool.query("DROP FUNCTION IF EXISTS g5c_events_leak()");
  };

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
  });
  afterAll(async () => {
    await dropLeak();
    await db.close();
  });
  beforeEach(async () => {
    await dropLeak();
    await resetTestDb(db);
  });

  it("reads exactly this run's rows, with exactly the 0008 columns and the inserting transactions", async () => {
    const probe = createEventsDbProbe(db.pool, SCOPE);
    expect(await record()).toBe(true);
    expect(await record(PAGE_KEY, { type: "engagement", name: "scroll_50" })).toBe(true);
    expect(await record("/smoke/otherrun/ev")).toBe(true);
    expect(await record(PAGE_KEY, { installationId: "other-inst" })).toBe(true);
    const rows = await probe.runEvents(PAGE_KEY);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Object.keys(r.row).sort()).toEqual([...BROWSER_EVENT_COLUMNS]);
      expect(r.row).toMatchObject({ installation_id: "inst-test", website_id: "site-test", page_key: PAGE_KEY, origin: "browser", consent: "granted" });
      expect(r.xid).toMatch(/^[0-9]+$/);
    }
    // The column list is the table's, so a migration that added a column would fail here and in the smoke.
    const cols = (await db.pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'browser_events' ORDER BY column_name")).rows.map((r) => r.column_name);
    expect(cols).toEqual([...BROWSER_EVENT_COLUMNS]);
    // Each autocommitted insert is its own transaction, and it wrote nothing else.
    expect(new Set(rows.map((r) => r.xid)).size).toBe(2);
    const written = await probe.writtenByTransactions(rows.map((r) => r.xid));
    expect(Object.keys(written).sort()).toEqual([...NON_EVENT_TABLES].sort());
    expect(Object.values(written).every((n) => n === 0)).toBe(true);
  });

  it("catches a D4 violation in the same transaction: a company and an observation written by the event insert", async () => {
    const probe = createEventsDbProbe(db.pool, SCOPE);
    const before = await probe.snapshot();
    await db.pool.query(`CREATE FUNCTION g5c_events_leak() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cid bigint;
      BEGIN
        INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at)
          VALUES ('leak-' || lower(NEW.event_id) || '.example', NULL, now(), now()) RETURNING id INTO cid;
        INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source, page_key)
          VALUES (NEW.installation_id, NEW.website_id, cid, now(), NEW.event_id, 'provider', NEW.page_key);
        RETURN NEW;
      END $$`);
    await db.pool.query("CREATE TRIGGER g5c_events_leak AFTER INSERT ON browser_events FOR EACH ROW EXECUTE FUNCTION g5c_events_leak()");
    expect(await record()).toBe(true);
    const rows = await probe.runEvents(PAGE_KEY);
    const written = await probe.writtenByTransactions(rows.map((r) => r.xid));
    expect(written).toMatchObject({ companies: 1, company_observations: 1, ip_resolution_cache: 0 });
    expect(await probe.runObservations(PAGE_KEY, before.observationsMaxId, `/smoke/${RUN}`)).toEqual({ withEventPageKey: 1, runSinceMark: 1 });
    const after = await probe.snapshot();
    expect(windowVerdict(before, after)).toEqual({ kind: "written_without_resolver_traffic", grew: ["companies", "company_observations"] });
  });

  it("catches a write in a separate transaction through the scoped observation check and the high-water marks", async () => {
    const probe = createEventsDbProbe(db.pool, SCOPE);
    const before = await probe.snapshot();
    expect(await record()).toBe(true);
    const cid = (await db.pool.query<{ id: string }>("INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at) VALUES ('separate.example', NULL, now(), now()) RETURNING id")).rows[0]!.id;
    await db.pool.query("INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source, page_key) VALUES ($1, $2, $3, now(), 'separate_ref_0001', 'provider', $4)", [
      SCOPE.installationId,
      SCOPE.websiteId,
      cid,
      `/smoke/${RUN}`,
    ]);
    const rows = await probe.runEvents(PAGE_KEY);
    // Not the event's transaction: the same-transaction check is clean ...
    expect(Object.values(await probe.writtenByTransactions(rows.map((r) => r.xid))).every((n) => n === 0)).toBe(true);
    // ... but the run-scoped observation check and the window catch it.
    expect(await probe.runObservations(PAGE_KEY, before.observationsMaxId, `/smoke/${RUN}`)).toEqual({ withEventPageKey: 0, runSinceMark: 1 });
    expect(windowVerdict(before, await probe.snapshot())).toMatchObject({ kind: "written_without_resolver_traffic" });
    // An observation of another page in the same window (concurrent traffic) is out of the run scope.
    expect(await probe.runObservations(PAGE_KEY, BigInt(Number.MAX_SAFE_INTEGER), `/smoke/${RUN}`)).toEqual({ withEventPageKey: 0, runSinceMark: 0 });
  });

  it("the snapshot counts resolver traffic for this scope only, over all periods", async () => {
    const probe = createEventsDbProbe(db.pool, SCOPE);
    await db.pool.query("INSERT INTO usage_periods (installation_id, website_id, period_key, resolver_requests) VALUES ($1, $2, '2026-10', 3), ($1, $2, '2026-11', 4), ('other-inst', $2, '2026-11', 100)", [
      SCOPE.installationId,
      SCOPE.websiteId,
    ]);
    expect((await probe.snapshot()).resolverRequests).toBe(7n);
  });

  it("never writes: every statement is a SELECT inside BEGIN READ ONLY ... COMMIT", async () => {
    const statements: string[] = [];
    // A delegating client: the pooled client itself is never modified.
    const spy = {
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: (text: string, values?: unknown[]) => {
            statements.push(text.trim().split(/\s+/)[0]!.toUpperCase() + (text.includes("READ ONLY") ? " READ ONLY" : ""));
            return client.query(text, values);
          },
          release: (destroy?: boolean) => client.release(destroy),
        };
      },
    } as unknown as Pool;
    const probe = createEventsDbProbe(spy, SCOPE);
    await record();
    const rows = await probe.runEvents(PAGE_KEY);
    await probe.snapshot();
    await probe.runObservations(PAGE_KEY, 0n, `/smoke/${RUN}`);
    await probe.writtenByTransactions(rows.map((r) => r.xid));
    expect(new Set(statements)).toEqual(new Set(["BEGIN READ ONLY", "SELECT", "COMMIT"]));
    expect(statements.filter((s) => s === "BEGIN READ ONLY")).toHaveLength(4);
    // And the database itself refuses a write inside such a transaction.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await expect(client.query("DELETE FROM browser_events")).rejects.toMatchObject({ code: "25006" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
