/**
 * PostgreSQL pool factory and error hygiene shared by every repository.
 *
 * TLS (DATABASE_SSL: require | verify-pinned | no-verify | disable) is
 * documented and implemented in tls.ts; every connection path (service pool,
 * migrate, ops commands) goes through createPool, so all honour it.
 *
 * Every TLS-related parameter in the connection string (`sslmode`, `ssl`,
 * `sslrootcert`, `sslcert`, `sslkey`, `sslnegotiation`, `uselibpqcompat`, ...)
 * is stripped so DATABASE_SSL is the single source of truth: node-postgres
 * would otherwise let them override the explicit option (`?ssl=0` would turn
 * TLS off, `?sslrootcert=` would read a file).
 */
import pg from "pg";
import type { Logger } from "../log/index.js";
import { pgTlsOptions, type DbTlsInput } from "./tls.js";

export type Pool = pg.Pool;
export type { SslMode, DbTlsConfig, DbTlsInput } from "./tls.js";

/** Login credentials that replace the user and password of the connection string (the runtime role). */
export interface DbCredentials {
  user: string;
  password: string;
}

export interface CreatePoolOptions {
  databaseUrl: string;
  ssl: DbTlsInput;
  /** When set, connect as this role instead of the user in the URL (host, port and database stay). */
  credentials?: DbCredentials;
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

const TLS_URL_PARAMS = new Set([
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslcrl",
  "sslpassword",
  "sslnegotiation",
  "sslcompression",
  "sslsni",
  "uselibpqcompat",
]);

/**
 * Removes every TLS-related parameter so DATABASE_SSL alone controls TLS.
 * Fails closed (G5R2-L2): a connection string that WHATWG URL cannot parse
 * (e.g. the libpq form with an empty host and `?host=`) is refused with
 * DbError("INVALID_URL"), never passed on unstripped, because node-postgres
 * parses such strings itself and their `sslmode=disable` would override the
 * explicit TLS option. Never logs or echoes the URL.
 */
export function stripSslMode(databaseUrl: string): string {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    throw new DbError("INVALID_URL");
  }
  const drop = [...u.searchParams.keys()].filter((k) => TLS_URL_PARAMS.has(k.toLowerCase()));
  if (drop.length === 0) return databaseUrl;
  for (const k of drop) u.searchParams.delete(k);
  return u.toString();
}

/**
 * The connection string with its user and password replaced (the URL setters
 * percent-encode; node-postgres decodes). Throws a DbError with a fixed code,
 * never the URL, when the URL cannot be parsed.
 */
export function withCredentials(databaseUrl: string, credentials: DbCredentials): string {
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    throw new DbError("INVALID_URL");
  }
  u.username = credentials.user;
  u.password = credentials.password;
  return u.toString();
}

export function createPool(opts: CreatePoolOptions): Pool {
  const tls = pgTlsOptions(opts.ssl);
  const url = opts.credentials ? withCredentials(opts.databaseUrl, opts.credentials) : opts.databaseUrl;
  const pool = new pg.Pool({
    connectionString: stripSslMode(url),
    ssl: tls.ssl,
    ...(tls.stream ? { stream: tls.stream } : {}),
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
