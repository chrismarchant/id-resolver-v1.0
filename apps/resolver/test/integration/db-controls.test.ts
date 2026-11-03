import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";

describe("controls repository", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  it("defaults to enabled when no row exists", async () => {
    expect(await db.controls.isEnrichmentEnabled("fresh-install")).toBe(true);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM deployment_controls");
    expect(n.rows[0].n).toBe(0);
  });

  it("set off then on, recording the reason", async () => {
    await db.controls.setEnrichmentEnabled("inst", false, "budget spike");
    expect(await db.controls.isEnrichmentEnabled("inst")).toBe(false);
    let row = await db.pool.query("SELECT enrichment_enabled, reason FROM deployment_controls WHERE installation_id='inst'");
    expect(row.rows[0]).toEqual({ enrichment_enabled: false, reason: "budget spike" });

    await db.controls.setEnrichmentEnabled("inst", true, "resolved");
    expect(await db.controls.isEnrichmentEnabled("inst")).toBe(true);
    row = await db.pool.query("SELECT enrichment_enabled, reason FROM deployment_controls WHERE installation_id='inst'");
    expect(row.rows[0]).toEqual({ enrichment_enabled: true, reason: "resolved" });
  });

  it("is idempotent and keeps a single row", async () => {
    await db.controls.setEnrichmentEnabled("inst", false, "a");
    await db.controls.setEnrichmentEnabled("inst", false, "a");
    await Promise.all(Array.from({ length: 10 }, () => db.controls.setEnrichmentEnabled("inst", false, "b")));
    expect(await db.controls.isEnrichmentEnabled("inst")).toBe(false);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM deployment_controls");
    expect(n.rows[0].n).toBe(1);
  });

  it("installations are independent", async () => {
    await db.controls.setEnrichmentEnabled("a", false, "x");
    expect(await db.controls.isEnrichmentEnabled("a")).toBe(false);
    expect(await db.controls.isEnrichmentEnabled("b")).toBe(true);
  });
});
