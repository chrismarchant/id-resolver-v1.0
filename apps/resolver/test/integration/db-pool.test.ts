/**
 * Database bounds that the single-process runtime relies on (CHR-70): with no
 * child process to kill, every query is bounded both by the server's
 * statement_timeout and by a client-side read timeout, and a connection whose
 * transaction failed is discarded instead of being reused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivityRepository } from "../../src/db/activity-repo.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { createPool, DEFAULT_STATEMENT_TIMEOUT_MS, QUERY_TIMEOUT_MARGIN_MS, type Pool } from "../../src/db/pool.js";
import { createScratchDatabase, getTestDatabaseUrl } from "../helpers/db.js";

describe("pool bounds", () => {
  it("applies the statement timeout and a client-side query timeout just above it by default", async () => {
    const pool = createPool({ databaseUrl: getTestDatabaseUrl(), ssl: "disable" });
    try {
      const options = (pool as unknown as { options: { statement_timeout: number; query_timeout: number } }).options;
      expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
      expect(options.query_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS + QUERY_TIMEOUT_MARGIN_MS);
      const r = await pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(r.rows[0]!.statement_timeout).toBe("3s");
    } finally {
      await pool.end();
    }
  });

  it("the client-side timeout fires even when the server would keep the statement running, and the pool stays usable", async () => {
    const pool = createPool({ databaseUrl: getTestDatabaseUrl(), ssl: "disable", max: 2, statementTimeoutMs: 10_000, queryTimeoutMs: 200 });
    try {
      const started = Date.now();
      await expect(pool.query("SELECT pg_sleep(2)")).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
      const ok = await pool.query<{ one: number }>("SELECT 1 AS one");
      expect(ok.rows[0]!.one).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("a failed transaction discards its connection instead of returning it to the pool", async () => {
    const pool = createPool({ databaseUrl: getTestDatabaseUrl(), ssl: "disable", max: 2 });
    try {
      await pool.query("SELECT 1");
      expect(pool.totalCount).toBe(1);
      const activity = createActivityRepository(pool);
      // No such company: the transaction fails inside its body.
      await expect(
        activity.recordObservation({ scope: { installationId: "inst-pool", websiteId: "site-pool" }, companyId: 999_999_999, observationRef: "obsref-pool-000000001", source: "cache", observedAt: new Date() }),
      ).rejects.toThrow();
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

describe("migration statements and the client-side timeout", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let pool: Pool;
  beforeAll(async () => {
    scratch = await createScratchDatabase();
    // A pool whose own client-side timeout is far too short for any migration.
    pool = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 1, queryTimeoutMs: 1 });
  });
  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  it("are bounded by the migration timeout instead of the pool's short default", async () => {
    // The pool's own bound is live: an ordinary query cannot finish within it.
    await expect(pool.query("SELECT pg_sleep(0.05)")).rejects.toThrow();
    const r = await applyMigrations(pool);
    expect(r.applied).toContain("0001_initial.sql");
  });
});
