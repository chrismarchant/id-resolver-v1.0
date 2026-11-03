/**
 * Shared environment loading for operator CLIs. Only the variables the ops
 * commands need are required (no auth token, HMAC secret or provider key), and
 * validation reuses the service's ConfigSchema so semantics are identical.
 * Errors name variables only, never values.
 */
import { ConfigSchema } from "../config/index.js";

const OpsSchema = ConfigSchema.pick({
  INSTALLATION_ID: true,
  WEBSITE_ID: true,
  DATABASE_URL: true,
  DATABASE_SSL: true,
  USAGE_PERIOD: true,
  CACHE_PRUNE_BATCH: true,
});

/** Only the prune command needs the (required, bounded) retention window. */
const RetentionSchema = ConfigSchema.pick({ OBSERVATION_RETENTION_DAYS: true });

export type OpsConfig = ReturnType<typeof OpsSchema.parse>;

export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const parsed = OpsSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration: ${names.join("; ")}`);
  }
  return parsed.data;
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
