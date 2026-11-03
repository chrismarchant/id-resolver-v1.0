/**
 * The least-privilege runtime role for tests (Gate 5). Roles are cluster-wide
 * in PostgreSQL; the name is fixed and provisioning is idempotent, so every
 * suite can (re)provision it in the database it uses. The password is a
 * synthetic test value.
 */
import { createDb, type Db } from "../../src/db/index.js";
import { applyMigrations, type MigrateOptions } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/pool.js";
import { getTestDatabaseUrl } from "./db.js";

export const TEST_RUNTIME_ROLE = "idr_test_runtime";
export const TEST_RUNTIME_PASSWORD = "0123456789abcdef0123456789abcdef";

/** Migrates `databaseUrl` (as the owner, plaintext test connection) and provisions the test runtime role there. */
export async function provisionTestRuntimeRole(databaseUrl = getTestDatabaseUrl(), options: Omit<MigrateOptions, "runtimeRole"> = {}) {
  const owner = createPool({ databaseUrl, ssl: "disable", max: 1 });
  try {
    return await applyMigrations(owner, undefined, { ...options, runtimeRole: { role: TEST_RUNTIME_ROLE, password: TEST_RUNTIME_PASSWORD } });
  } finally {
    await owner.end();
  }
}

/** A Db that logs in as the runtime role (host and database of `databaseUrl`). */
export function createRuntimeDb(opts: { databaseUrl?: string; max?: number } = {}): Db {
  return createDb({
    databaseUrl: opts.databaseUrl ?? getTestDatabaseUrl(),
    ssl: "disable",
    credentials: { user: TEST_RUNTIME_ROLE, password: TEST_RUNTIME_PASSWORD },
    max: opts.max ?? 10,
  });
}

/** The variables a production-posture service process needs to log in as the runtime role. */
export const runtimeRoleEnv = { DATABASE_RUNTIME_ROLE: TEST_RUNTIME_ROLE, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD } as const;
