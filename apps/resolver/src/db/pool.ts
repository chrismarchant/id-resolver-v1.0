/**
 * PostgreSQL pool factory and error hygiene shared by every repository.
 *
 * SSL modes (DATABASE_SSL):
 *  - "require":   TLS with certificate verification (rejectUnauthorized: true).
 *  - "no-verify": TLS without certificate verification
 *                 (rejectUnauthorized: false). Railway's internal/proxied
 *                 Postgres commonly presents a certificate that does not
 *                 chain to a public CA, so this is often required there. The
 *                 connection is still encrypted, but not authenticated.
 *  - "disable":   plaintext. Local development and tests only.
 *
 * Any `sslmode=` in the connection string is stripped so DATABASE_SSL is the
 * single source of truth (node-postgres would otherwise let it override).
 */
import pg from "pg";
import type { Logger } from "../log/index.js";

export type Pool = pg.Pool;
export type SslMode = "require" | "disable" | "no-verify";

export interface CreatePoolOptions {
  databaseUrl: string;
  ssl: SslMode;
  /** Small by default; the service sizes its single shared pool from MAX_CONCURRENT_JOBS. */
  max?: number;
  statementTimeoutMs?: number;
  /** Client-side bound per query; defaults to the statement timeout plus QUERY_TIMEOUT_MARGIN_MS. */
  queryTimeoutMs?: number;
  /**
   * Server-side bound on a session idling inside an open transaction. A stalled
   * writer otherwise holds its transaction id open and with it the
   * reporting-feed horizon (CHR-71), which statement_timeout alone cannot bound.
   */
  idleInTransactionTimeoutMs?: number;
}

export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 5_000;

export const DEFAULT_POOL_MAX = 2;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 3_000;
/**
 * statement_timeout is enforced by the server and cannot fire when the server
 * stops answering (network partition, stalled proxy). With jobs running in
 * the service process there is no child to kill, so every query also gets a
 * client-side read timeout slightly above the statement timeout; a query that
 * hits it fails, and pool.query() then discards the connection.
 */
export const QUERY_TIMEOUT_MARGIN_MS = 1_000;

export function sslOption(mode: SslMode): false | { rejectUnauthorized: boolean } {
  switch (mode) {
    case "require":
      return { rejectUnauthorized: true };
    case "no-verify":
      return { rejectUnauthorized: false };
    case "disable":
      return false;
  }
}

/** Removes sslmode so DATABASE_SSL alone controls TLS. Never throws, never logs the URL. */
export function stripSslMode(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    if (!u.searchParams.has("sslmode")) return databaseUrl;
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return databaseUrl;
  }
}

export function createPool(opts: CreatePoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString: stripSslMode(opts.databaseUrl),
    ssl: sslOption(opts.ssl),
    max: opts.max ?? DEFAULT_POOL_MAX,
    statement_timeout: opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    query_timeout: opts.queryTimeoutMs ?? (opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS) + QUERY_TIMEOUT_MARGIN_MS,
    idle_in_transaction_session_timeout: opts.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: "id-resolver",
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
  });
  // An idle-client error (e.g. server restart) must not crash the process or
  // leak connection details to stderr.
  pool.on("error", () => undefined);
  return pool;
}

/** Generic database failure. Carries only a sanitised code, never values. */
export class DbError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`database error (${code})`);
    this.name = "DbError";
    this.code = code;
  }
}

const SAFE_CODE = /^[A-Za-z0-9_]{1,24}$/;

export function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return new DbError(typeof code === "string" && SAFE_CODE.test(code) ? code : "UNKNOWN");
}

/**
 * Runs a database operation; on failure logs db_error{category: code} and
 * throws a DbError. The original error (which may embed parameter values in
 * its detail) is discarded.
 */
export async function guarded<T>(logger: Logger | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = toDbError(err);
    logger?.error("db_error", { category: e.code, component: "db" });
    throw e;
  }
}
