/**
 * Plain-SQL migration runner, and the startup check that the database is
 * current (the service never migrates on start: it refuses to start while a
 * migration in migrations/ is not recorded in schema_migrations).
 *
 * - Reads migrations/*.sql in lexical order.
 * - Each file is applied in its own transaction together with its
 *   schema_migrations row.
 * - A session-level pg_advisory_lock serialises concurrent deploy instances;
 *   the applied set is re-read after the lock is taken, so a loser of the race
 *   sees the winner's work and does nothing.
 *
 * CLI: `npm run migrate` / `node dist/db/migrate.js` needs DATABASE_URL (the
 * owner) and follows the service's database TLS policy (DATABASE_SSL, default
 * "require"; DATABASE_TLS_PIN_SHA256; DATABASE_CA_CERT; NODE_ENV=production,
 * the default, refuses disable and unverified TLS). With
 * DATABASE_RUNTIME_PASSWORD set it also provisions the runtime role
 * DATABASE_RUNTIME_ROLE (default idr_runtime): see runtime-role.ts.
 */
import { readdir, readFile } from "node:fs/promises";
import type { QueryConfig, QueryResultRow } from "pg";
import { pathToFileURL } from "node:url";
import type { Logger } from "../log/index.js";
import { ConfigError, ConfigSchema, databaseUrlUser, loadDatabaseTls } from "../config/index.js";
import { createPool, DbError, guarded, toDbError, type Pool } from "./pool.js";
import { provisionRuntimeRole, RuntimeRoleError, type ProvisionResult } from "./runtime-role.js";
import type { DbTlsConfig } from "./tls.js";

/** Arbitrary constant namespace for the migration advisory lock. */
const MIGRATION_LOCK_KEY = "7262021001";
const MIGRATION_STATEMENT_TIMEOUT = "120s";
/** Client-side bound for migration statements; above the session's 120 s statement_timeout, overriding the pool's short default. */
const MIGRATION_QUERY_TIMEOUT_MS = 125_000;

export interface MigrateOptions {
  /** Directory containing *.sql files. Defaults to the repository's migrations/. */
  dir?: string | URL;
  /**
   * Role separation (src/db/runtime-role.ts): after the migrations, under the
   * same advisory lock and in one transaction, create or update this login
   * role and apply its exact grants. Absent = no role is touched.
   */
  runtimeRole?: { role: string; password: string };
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  /** Set when options.runtimeRole was given and provisioning committed. */
  runtimeRole?: ProvisionResult;
}

function defaultDir(): URL {
  // src/db/migrate.ts and dist/db/migrate.js are both two levels below the repo root.
  return new URL("../../migrations/", import.meta.url);
}

async function migrationNames(dir: string | URL): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

export interface MigrationStatus {
  /** Files in migrations/ not recorded in schema_migrations (all of them when the table does not exist). */
  pending: string[];
  /** Recorded in schema_migrations but absent from this build (the database is ahead of the code). */
  unknown: string[];
}

/** Read-only comparison of the build's migrations with the database's schema_migrations. */
export async function migrationStatus(pool: Pool, logger?: Logger, options: MigrateOptions = {}): Promise<MigrationStatus> {
  const names = await migrationNames(options.dir ?? defaultDir());
  return guarded(logger, async () => {
    const table = await pool.query<{ t: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS t");
    const applied = table.rows[0]?.t ? (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name) : [];
    const done = new Set(applied);
    const known = new Set(names);
    return { pending: names.filter((n) => !done.has(n)), unknown: applied.filter((n) => !known.has(n)).sort() };
  });
}

/** The database is missing migrations this build needs. The message names files only (never a URL or credential). */
export class PendingMigrationsError extends Error {
  readonly pending: string[];
  constructor(pending: string[]) {
    super(
      `database schema is behind this build: ${pending.length} pending migration(s): ${pending.join(", ")}. ` +
        "Apply them with `node dist/db/migrate.js` (the Railway preDeployCommand; locally `npm run migrate`), then start the service.",
    );
    this.name = "PendingMigrationsError";
    this.pending = pending;
  }
}

/** Startup gate: throws PendingMigrationsError unless every migration in this build is applied. */
export async function assertSchemaCurrent(pool: Pool, logger?: Logger, options: MigrateOptions = {}): Promise<MigrationStatus> {
  const status = await migrationStatus(pool, logger, options);
  if (status.pending.length > 0) throw new PendingMigrationsError(status.pending);
  return status;
}

export async function applyMigrations(pool: Pool, logger?: Logger, options: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = options.dir ?? defaultDir();
  const names = await migrationNames(dir);
  const sqlByName = new Map<string, string>();
  for (const name of names) {
    const base = typeof dir === "string" ? pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`) : dir;
    sqlByName.set(name, await readFile(new URL(name, base), "utf8"));
  }

  return guarded(logger, async () => {
    const client = await pool.connect();
    // Every statement on this connection gets the migration bound instead of the pool's short client-side timeout.
    const query = <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
      client.query<R>({ text, ...(values ? { values } : {}), query_timeout: MIGRATION_QUERY_TIMEOUT_MS } as QueryConfig);
    try {
      await query(`SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
      await query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
      try {
        await query(
          "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        );
        const done = await query<{ name: string }>("SELECT name FROM schema_migrations");
        const doneSet = new Set(done.rows.map((r) => r.name));
        const applied: string[] = [];
        const alreadyApplied: string[] = [];
        for (const name of names) {
          if (doneSet.has(name)) {
            alreadyApplied.push(name);
            continue;
          }
          try {
            await query("BEGIN");
            await query(sqlByName.get(name) as string);
            await query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, now())", [name]);
            await query("COMMIT");
          } catch (err) {
            await query("ROLLBACK").catch(() => undefined);
            throw new MigrationError(name, toDbError(err).code);
          }
          applied.push(name);
        }
        if (!options.runtimeRole) return { applied, alreadyApplied };
        let runtimeRole: ProvisionResult;
        try {
          await query("BEGIN");
          runtimeRole = await provisionRuntimeRole(query, options.runtimeRole);
          await query("COMMIT");
        } catch (err) {
          await query("ROLLBACK").catch(() => undefined);
          throw err instanceof RuntimeRoleError ? err : toDbError(err);
        }
        return { applied, alreadyApplied, runtimeRole };
      } finally {
        await query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
      }
    } finally {
      // Always destroy this connection: it carries a non-default
      // statement_timeout, and closing it also drops the advisory lock should
      // the explicit unlock have failed.
      client.release(true);
    }
  });
}

const RuntimeRoleSchema = ConfigSchema.pick({ DATABASE_RUNTIME_ROLE: true, DATABASE_RUNTIME_PASSWORD: true });

export class MigrationError extends DbError {
  readonly migration: string;
  constructor(migration: string, code: string) {
    super(code);
    this.migration = migration;
    this.name = "MigrationError";
  }
}

/** DATABASE_RUNTIME_ROLE / DATABASE_RUNTIME_PASSWORD, validated like the service does; undefined when the password is unset. */
function loadRuntimeRole(env: NodeJS.ProcessEnv): { role: string; password: string } | undefined {
  const parsed = RuntimeRoleSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const { DATABASE_RUNTIME_ROLE: role, DATABASE_RUNTIME_PASSWORD: password } = parsed.data;
  if (password === undefined) return undefined;
  if (role === databaseUrlUser(env["DATABASE_URL"] ?? "")) {
    throw new ConfigError("invalid configuration: DATABASE_RUNTIME_ROLE must differ from the DATABASE_URL user (the owner that runs migrations)");
  }
  return { role, password };
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("migrate: DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  let ssl: DbTlsConfig;
  try {
    const loaded = loadDatabaseTls(process.env);
    for (const w of loaded.warnings) console.error(`migrate: ${w}`);
    ssl = loaded.tls;
  } catch (e) {
    // ConfigError messages name variables only, never values.
    console.error(`migrate: ${e instanceof ConfigError ? e.message : "invalid configuration"}`);
    process.exitCode = 1;
    return;
  }
  let runtimeRole: { role: string; password: string } | undefined;
  try {
    runtimeRole = loadRuntimeRole(process.env);
  } catch (e) {
    console.error(`migrate: ${e instanceof ConfigError ? e.message : "invalid configuration"}`);
    process.exitCode = 1;
    return;
  }
  if (!runtimeRole) {
    console.error(
      "migrate: runtime role not configured (DATABASE_RUNTIME_PASSWORD unset); the service refuses to start in production unless ALLOW_OWNER_DATABASE_ROLE=true",
    );
  }
  const pool = createPool({ databaseUrl, ssl, max: 1 });
  try {
    const result = await applyMigrations(pool, undefined, runtimeRole ? { runtimeRole } : {});
    if (result.runtimeRole && result.runtimeRole.unmapped.length > 0) {
      // Object names from this database's schema only; the runtime role holds no privilege on them.
      console.error(`migrate: warning: no runtime grant decision for ${result.runtimeRole.unmapped.join(", ")} (the runtime role has no privilege on them)`);
    }
    console.log(
      JSON.stringify({
        migrated: result.applied,
        already_applied: result.alreadyApplied.length,
        runtime_role: result.runtimeRole ? (result.runtimeRole.created ? "created" : "updated") : "not_configured",
      }),
    );
  } catch (err) {
    const e = err instanceof MigrationError || err instanceof RuntimeRoleError ? err : toDbError(err);
    const where = e instanceof MigrationError ? ` in ${e.migration}` : e instanceof RuntimeRoleError ? " provisioning the runtime role" : "";
    // RuntimeRoleError reasons are fixed tokens or object names from this schema, never values.
    const why = e instanceof RuntimeRoleError && e.reasons.length > 0 ? `: ${e.reasons.join(", ")}` : "";
    console.error(`migrate: failed${where} (${e.code}${why})`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
