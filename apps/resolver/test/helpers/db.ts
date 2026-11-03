import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import type { CacheKey } from "../../src/contracts/db.js";
import { createDb, type Db } from "../../src/db/index.js";
import { applyMigrations } from "../../src/db/migrate.js";

export const DEFAULT_TEST_DATABASE_URL = "postgres://resolver:resolver@127.0.0.1:5432/id_resolver_test";

export function getTestDatabaseUrl(): string {
  return process.env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
}

/** Creates a Db against the test database with migrations applied. */
export async function createTestDb(opts: { max?: number } = {}): Promise<Db> {
  const db = createDb({ databaseUrl: getTestDatabaseUrl(), ssl: "disable", max: opts.max ?? 10 });
  await applyMigrations(db.pool);
  return db;
}

export const RESET_TABLES_SQL =
  "TRUNCATE TABLE feed_tombstones, feed_retention_watermarks, company_observation_refs, company_observations, company_scope_stats, ip_resolution_cache, companies, usage_periods, deployment_controls, browser_events RESTART IDENTITY CASCADE";

/**
 * Truncates every application table (not schema_migrations).
 *
 * Migration 0007 rejects TRUNCATE (and tombstone or watermark deletes) of the
 * feed tables, so the reset runs in one transaction with
 * `SET LOCAL session_replication_role = replica`, which fires no ordinary
 * trigger for that transaction only. That setting needs superuser (the test
 * role is one; the CI service container's POSTGRES_USER is one) and is an
 * out-of-band, test-only bypass: the service never uses it, and using it on a
 * live deployment requires every feed consumer to resynchronise.
 */
export async function resetTestDb(db: Db): Promise<void> {
  const client = await db.pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(RESET_TABLES_SQL);
    await client.query("COMMIT");
  } catch (err) {
    failed = true;
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release(failed);
  }
}

/** Synthetic fingerprint: sha256 of a label. Never derived from a real IP. */
export function syntheticFingerprint(label: string): Buffer {
  return createHash("sha256").update(`test-fingerprint:${label}`).digest();
}

export function testKey(label: string, overrides: Partial<CacheKey> = {}): CacheKey {
  return {
    installationId: "test-install",
    websiteId: "test-site",
    keyVersion: 1,
    ipFingerprint: syntheticFingerprint(label),
    ...overrides,
  };
}

/** Creates an empty throwaway database for migration tests; call drop() when done. */
export async function createScratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = new URL(getTestDatabaseUrl());
  const name = `id_resolver_scratch_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const scratch = new URL(base.toString());
  scratch.pathname = `/${name}`;
  return {
    url: scratch.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: base.toString() });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
