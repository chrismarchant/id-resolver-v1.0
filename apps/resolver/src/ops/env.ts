/**
 * Shared environment loading for operator CLIs. Only the variables the ops
 * commands need are required (no auth token, HMAC secret or provider key), and
 * validation reuses the service's ConfigSchema so semantics are identical.
 * Errors name variables only, never values.
 */
import { assertNoSupabaseConfiguration, ConfigSchema, loadDatabaseTls } from "../config/index.js";
import type { DbTlsConfig } from "../db/tls.js";

const OpsSchema = ConfigSchema.pick({
  INSTALLATION_ID: true,
  WEBSITE_ID: true,
  DATABASE_URL: true,
  USAGE_PERIOD: true,
  CACHE_PRUNE_BATCH: true,
});

/** Only the prune command needs the (required, bounded) retention window. */
const RetentionSchema = ConfigSchema.pick({ OBSERVATION_RETENTION_DAYS: true });

/**
 * Ops commands connect as the DATABASE_URL user (the owner), never as the
 * runtime role: erasure and the kill switch need privileges the runtime role
 * deliberately lacks. TLS follows the same policy as the service
 * (DATABASE_SSL and friends; production refuses disable and unverified TLS).
 */
export type OpsConfig = ReturnType<typeof OpsSchema.parse> & { DATABASE_TLS: DbTlsConfig };

export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  // Three-database separation (docs/GUARDRAILS.md G3a): the same refusal as the service and migrate.
  try {
    assertNoSupabaseConfiguration(env);
  } catch (e) {
    // ConfigError messages name variables only; rethrown as a plain Error so failOps prints them.
    throw new Error((e as Error).message);
  }
  const parsed = OpsSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration: ${names.join("; ")}`);
  }
  let db: ReturnType<typeof loadDatabaseTls>;
  try {
    db = loadDatabaseTls(env);
  } catch (e) {
    // ConfigError messages name variables only; rethrown as a plain Error so failOps prints them.
    throw new Error((e as Error).message);
  }
  for (const w of db.warnings) console.error(w);
  return { ...parsed.data, DATABASE_TLS: db.tls };
}

export function loadRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = RetentionSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration: ${names.join("; ")}`);
  }
  return parsed.data.OBSERVATION_RETENTION_DAYS;
}

/** Prints a generic failure without echoing arbitrary error text from the driver. */
export function failOps(prefix: string, err: unknown): void {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const msg = err instanceof Error && err.name === "Error" ? err.message : typeof code === "string" ? `error (${code})` : "failed";
  console.error(`${prefix}: ${msg}`);
  process.exitCode = 1;
}
