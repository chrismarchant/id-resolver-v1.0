/**
 * The test-only reset lock diagnostic (Gate 5 CI reliability, PR #8).
 *
 * A separate connection holds a lock on a reset table inside an open
 * transaction, so the reset's TRUNCATE waits until statement_timeout cancels
 * it. The reset must still fail exactly as before (the same error is rethrown),
 * and the diagnostic must name the holder with its pid, state, lock mode,
 * wait event and transaction age, without any query text.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { RESET_TABLE_NAMES, isResetTimeout, type ResetLockDiagnostic } from "../helpers/db-lock-diagnostic.js";
import { RESET_TABLES_SQL, createTestDb, getTestDatabaseUrl, resetTestDb } from "../helpers/db.js";

const SECRET_MARKER = "do-not-print-7f3a.example";

describe("resetTestDb lock diagnostic (test-only)", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb({ max: 4 });
    await resetTestDb(db);
  });
  afterAll(async () => {
    await resetTestDb(db);
    await db.close();
  });

  it("names the reset tables exactly as RESET_TABLES_SQL truncates them", () => {
    const listed = RESET_TABLES_SQL.replace(/^TRUNCATE TABLE /, "").replace(/ RESTART IDENTITY CASCADE$/, "").split(", ");
    expect(listed).toEqual([...RESET_TABLE_NAMES]);
  });

  it("on a lock-wait timeout: the original error is rethrown, and the holder is reported with pid, state, lock mode, wait event and transaction age, without query text", async () => {
    const holder = new pg.Client({ connectionString: getTestDatabaseUrl(), application_name: "diag-test-holder" });
    await holder.connect();
    const seen: ResetLockDiagnostic[] = [];
    try {
      await holder.query("BEGIN");
      // A plain read takes AccessShareLock on companies, which blocks TRUNCATE's AccessExclusiveLock.
      await holder.query(`SELECT count(*) FROM companies WHERE domain = '${SECRET_MARKER}'`);
      const holderPid = (holder as unknown as { processID: number }).processID;

      const err = await resetTestDb(db, { onLockDiagnostic: (d) => seen.push(d) }).then(
        () => null,
        (e: unknown) => e,
      );
      // Failure behaviour is unchanged: the reset still rejects with the lock-wait timeout itself.
      expect(err).not.toBeNull();
      expect(isResetTimeout(err)).toBe(true);
      expect((err as { code?: string }).code ?? (err as Error).message).toMatch(/^(57014|Query read timeout)$/);

      expect(seen).toHaveLength(1);
      const d = seen[0]!;
      expect(d.event).toBe("reset_lock_diagnostic");
      expect(typeof d.reset_pid).toBe("number");
      expect("holders" in d).toBe(true);
      if (!("holders" in d)) return;
      const h = d.holders.find((x) => x.pid === holderPid);
      expect(h, JSON.stringify(d)).toBeDefined();
      expect(h).toMatchObject({
        application_name: "diag-test-holder",
        backend_type: "client backend",
        state: "idle in transaction",
        wait_event_type: "Client",
        wait_event: "ClientRead",
        statement_kind: "SELECT",
        own_pool: false,
      });
      expect(h!.xact_age_ms).toBeGreaterThan(0);
      expect(h!.locks).toContainEqual({ relation: "companies", mode: "AccessShareLock", granted: true });

      // Redaction: no query text, literal or connection detail reaches the report.
      const text = JSON.stringify(seen);
      expect(text).not.toContain(SECRET_MARKER);
      expect(text).not.toContain("count(");
      expect(text).not.toContain("WHERE");
      expect(text).not.toContain(getTestDatabaseUrl());
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  }, 30_000);

  it("a successful reset reports nothing", async () => {
    const seen: ResetLockDiagnostic[] = [];
    await resetTestDb(db, { onLockDiagnostic: (d) => seen.push(d) });
    expect(seen).toEqual([]);
  });
});
