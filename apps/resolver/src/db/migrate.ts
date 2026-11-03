/**
 * Plain-SQL migration runner.
 *
 * - Reads migrations/*.sql in lexical order.
 * - Each file is applied in its own transaction together with its
 *   schema_migrations row.
 * - A session-level pg_advisory_lock serialises concurrent deploy instances;
 *   the applied set is re-read after the lock is taken, so a loser of the race
 *   sees the winner's work and does nothing.
 *
 * CLI: `npm run migrate` needs only DATABASE_URL (and optionally DATABASE_SSL,
 * default "require").
 */
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Logger } from "../log/index.js";
import { createPool, DbError, guarded, toDbError, type Pool, type SslMode } from "./pool.js";

/** Arbitrary constant namespace for the migration advisory lock. */
const MIGRATION_LOCK_KEY = "7262021001";
const MIGRATION_STATEMENT_TIMEOUT = "120s";

export interface MigrateOptions {
  /** Directory containing *.sql files. Defaults to the repository's migrations/. */
  dir?: string | URL;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

function defaultDir(): URL {
  // src/db/migrate.ts and dist/db/migrate.js are both two levels below the repo root.
  return new URL("../../migrations/", import.meta.url);
}

export async function applyMigrations(pool: Pool, logger?: Logger, options: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = options.dir ?? defaultDir();
  const names = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const sqlByName = new Map<string, string>();
  for (const name of names) {
    const base = typeof dir === "string" ? pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`) : dir;
    sqlByName.set(name, await readFile(new URL(name, base), "utf8"));
  }

  return guarded(logger, async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
      await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
      try {
        await client.query(
          "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
        );
        const done = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
        const doneSet = new Set(done.rows.map((r) => r.name));
        const applied: string[] = [];
        const alreadyApplied: string[] = [];
        for (const name of names) {
          if (doneSet.has(name)) {
            alreadyApplied.push(name);
            continue;
          }
          try {
            await client.query("BEGIN");
            await client.query(sqlByName.get(name) as string);
            await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, now())", [name]);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw new MigrationError(name, toDbError(err).code);
          }
          applied.push(name);
        }
        return { applied, alreadyApplied };
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
      }
    } finally {
      // Always destroy this connection: it carries a non-default
      // statement_timeout, and closing it also drops the advisory lock should
      // the explicit unlock have failed.
      client.release(true);
    }
  });
}

export class MigrationError extends DbError {
  readonly migration: string;
  constructor(migration: string, code: string) {
    super(code);
    this.migration = migration;
    this.name = "MigrationError";
  }
}

function parseSsl(raw: string | undefined): SslMode {
  const v = raw ?? "require";
  if (v === "require" || v === "disable" || v === "no-verify") return v;
  throw new Error("DATABASE_SSL must be one of: require, disable, no-verify");
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("migrate: DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  let ssl: SslMode;
  try {
    ssl = parseSsl(process.env["DATABASE_SSL"]);
  } catch (e) {
    console.error(`migrate: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const pool = createPool({ databaseUrl, ssl, max: 1 });
  try {
    const result = await applyMigrations(pool);
    console.log(
      JSON.stringify({ migrated: result.applied, already_applied: result.alreadyApplied.length }),
    );
  } catch (err) {
    const e = err instanceof MigrationError ? err : toDbError(err);
    const where = e instanceof MigrationError ? ` in ${e.migration}` : "";
    console.error(`migrate: failed${where} (${e.code})`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
