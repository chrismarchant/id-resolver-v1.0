/**
 * Bounded runtime configuration. Every value is validated with explicit
 * bounds so a mis-set variable cannot disable a safety control silently.
 * Secrets are read once and never logged; `describeConfig()` returns only
 * non-secret values.
 */
import { z } from "zod";
import { IDENTIFIER_PATTERN } from "../contracts/api.js";

const intInRange = (min: number, max: number, def: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const boolFromString = (def: boolean) =>
  z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(def ? "true" : "false")
    .transform((v) => v === true || v === "true" || v === "1");

const csv = (def: string[]) =>
  z
    .string()
    .default(def.join(","))
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    );

const identifier = z.string().regex(IDENTIFIER_PATTERN, "lowercase letters, digits, hyphens; 1-63 chars");

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]).default("production"),
  PORT: intInRange(1, 65535, 8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),

  INSTALLATION_ID: identifier,
  WEBSITE_ID: identifier,

  // Secrets (never logged)
  RESOLVER_AUTH_TOKEN: z.string().min(32).max(256),
  /** Read-only reporting credential for the Insights project. Unset = reporting routes refuse every request. */
  REPORTING_AUTH_TOKEN: z.string().min(32).max(256).optional(),
  IP_HMAC_SECRET: z.string().min(32).max(512),
  IP_HMAC_KEY_VERSION: intInRange(1, 1_000_000, 1),
  ENRICH_API_KEY: z.string().max(512).default(""),
  DATABASE_URL: z.string().url().max(2048),
  DATABASE_SSL: z.enum(["require", "disable", "no-verify"]).default("require"),

  // Provider
  PROVIDER_MODE: z.enum(["live", "mock", "disabled"]).default("disabled"),
  /** The mock provider is refused when NODE_ENV=production unless this is set (isolated development deployment only). */
  ALLOW_MOCK_PROVIDER: boolFromString(false),
  ENRICH_API_BASE_URL: z.string().url().max(512).default("https://dev.enrich.so/api/v3"),
  ENRICH_AUTH_HEADER: z.enum(["x-api-key", "authorization-bearer"]).default("x-api-key"),
  ENRICH_TIMEOUT_MS: intInRange(200, 10_000, 2_500),

  // Request handling (single-process runtime, CHR-70)
  REQUEST_DEADLINE_MS: intInRange(300, 15_000, 4_000),
  /** Resolution jobs executing at once in this process; one more is refused with 503 overloaded. */
  MAX_CONCURRENT_JOBS: intInRange(1, 64, 8),
  /** The event-loop watchdog kills the process when the loop has been blocked longer than this. */
  EVENT_LOOP_BLOCK_EXIT_MS: intInRange(1_000, 60_000, 10_000),
  RATE_LIMIT_PER_MINUTE: intInRange(1, 100_000, 600),
  AUTH_FAILURE_LIMIT_PER_MINUTE: intInRange(1, 100_000, 60),
  BODY_LIMIT_BYTES: intInRange(128, 8_192, 1_024),
  SHUTDOWN_GRACE_MS: intInRange(500, 30_000, 8_000),

  // Enrichment controls
  ENRICHMENT_ENABLED: boolFromString(true),
  PERIOD_CALL_CAP: intInRange(0, 10_000_000, 1_000),
  USAGE_PERIOD: z.enum(["day", "month"]).default("month"),

  // Cache policy (seconds)
  TTL_QUALIFIED_S: intInRange(60, 90 * 86_400, 7 * 86_400),
  TTL_NO_MATCH_S: intInRange(60, 30 * 86_400, 86_400),
  TTL_EXCLUDED_S: intInRange(60, 90 * 86_400, 7 * 86_400),
  TTL_UNKNOWN_S: intInRange(60, 30 * 86_400, 86_400),
  TTL_PROVIDER_ERROR_S: intInRange(10, 86_400, 600),
  TTL_UNCERTAIN_S: intInRange(60, 7 * 86_400, 3_600),
  LEASE_MS: intInRange(500, 60_000, 6_000),
  PENDING_WAIT_MS: intInRange(0, 10_000, 1_500),
  PENDING_POLL_MS: intInRange(10, 1_000, 75),
  /** Period of the maintenance run (expired cache rows and observation retention); it also runs once at startup. */
  CACHE_PRUNE_INTERVAL_S: intInRange(30, 86_400, 600),
  /** Rows per delete statement; a run repeats batches until one comes back short or its budget is spent. */
  CACHE_PRUNE_BATCH: intInRange(10, 100_000, 1_000),
  /** Time budget of one maintenance run; must be below the interval. A run that exhausts it logs maintenance_backlog. */
  CACHE_PRUNE_BUDGET_MS: intInRange(1_000, 300_000, 20_000),
  /**
   * Observation retention (owner decision D3): a bounded synchronisation
   * buffer, not commercial history. REQUIRED with no default: the operator
   * must choose it, longer than the longest Insights sync outage to be
   * tolerated (see RUNTIME.md). Companies and scope stats are never pruned.
   */
  OBSERVATION_RETENTION_DAYS: z
    .string({ error: (issue) => (issue.input === undefined ? "required: whole days 1-365, no default (owner decision D3)" : "must be whole days 1-365") })
    .regex(/^[0-9]{1,3}$/, "must be whole days 1-365")
    .transform(Number)
    .pipe(z.number().int().min(1, "must be at least 1 day").max(365, "must be at most 365 days")),

  // Qualification policy
  QUALIFIED_USAGE_TYPES: csv(["COM", "ORG", "GOV", "EDU", "MIL", "LIB"]),
  EXCLUDED_USAGE_TYPES: csv(["ISP", "MOB", "DCH", "CDN", "SES", "AIC", "RSV"]),
  DENIED_DOMAINS: csv([]),
  /** RFC 5737/3849 documentation ranges are ineligible in production; tests enable them. */
  ALLOW_DOCUMENTATION_RANGES: boolFromString(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Minimum shutdown time beyond one request deadline, so in-flight jobs can settle before the process exits. */
export const SHUTDOWN_DRAIN_MARGIN_MS = 500;

export const SECRET_KEYS = ["RESOLVER_AUTH_TOKEN", "REPORTING_AUTH_TOKEN", "IP_HMAC_SECRET", "ENRICH_API_KEY", "DATABASE_URL"] as const;

/**
 * Variables that existed in V0.1 / before CHR-70 and no longer have any
 * effect. Setting one is refused rather than silently ignored, so an operator
 * never believes a bound (e.g. a concurrency limit) is in force when it is not.
 */
export const REMOVED_VARIABLES: Readonly<Record<string, string>> = {
  MAX_CONCURRENT_CHILDREN: "use MAX_CONCURRENT_JOBS (single-process runtime)",
  CHILD_HARD_KILL_GRACE_MS: "no replacement (there are no child processes)",
  RUN_MIGRATIONS_ON_START: "no replacement (migrations run only as the deploy pre-step: node dist/db/migrate.js)",
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const removed = Object.keys(REMOVED_VARIABLES).filter((k) => env[k] !== undefined);
  if (removed.length > 0) {
    throw new ConfigError(`invalid configuration: removed variable(s) set: ${removed.map((k) => `${k} (${REMOVED_VARIABLES[k]})`).join("; ")}`);
  }
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Only variable names are reported, never values.
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid configuration: ${names.join("; ")}`);
  }
  const cfg = parsed.data;
  if (cfg.PROVIDER_MODE === "mock" && cfg.NODE_ENV === "production" && !cfg.ALLOW_MOCK_PROVIDER) {
    throw new ConfigError("invalid configuration: PROVIDER_MODE=mock is refused when NODE_ENV=production unless ALLOW_MOCK_PROVIDER=true");
  }
  if (cfg.PROVIDER_MODE === "live" && cfg.ENRICH_API_KEY.length < 8) {
    throw new ConfigError("invalid configuration: ENRICH_API_KEY required when PROVIDER_MODE=live");
  }
  if (cfg.ENRICH_TIMEOUT_MS >= cfg.REQUEST_DEADLINE_MS) {
    throw new ConfigError("invalid configuration: ENRICH_TIMEOUT_MS must be below REQUEST_DEADLINE_MS");
  }
  if (cfg.LEASE_MS <= cfg.ENRICH_TIMEOUT_MS) {
    throw new ConfigError("invalid configuration: LEASE_MS must exceed ENRICH_TIMEOUT_MS");
  }
  if (cfg.REPORTING_AUTH_TOKEN !== undefined && cfg.REPORTING_AUTH_TOKEN === cfg.RESOLVER_AUTH_TOKEN) {
    throw new ConfigError("invalid configuration: REPORTING_AUTH_TOKEN must differ from RESOLVER_AUTH_TOKEN");
  }
  if (cfg.CACHE_PRUNE_BUDGET_MS >= cfg.CACHE_PRUNE_INTERVAL_S * 1000) {
    throw new ConfigError("invalid configuration: CACHE_PRUNE_BUDGET_MS must be below CACHE_PRUNE_INTERVAL_S x 1000");
  }
  if (cfg.SHUTDOWN_GRACE_MS < cfg.REQUEST_DEADLINE_MS + SHUTDOWN_DRAIN_MARGIN_MS) {
    throw new ConfigError(`invalid configuration: SHUTDOWN_GRACE_MS must be at least REQUEST_DEADLINE_MS + ${SHUTDOWN_DRAIN_MARGIN_MS}`);
  }
  return cfg;
}

/**
 * Removes the secrets from the live process environment once the validated
 * configuration holds them, so no later code path (a dependency reading
 * process.env, a diagnostic dump) can pick them up from there. The
 * environment the process was started with is unchanged (/proc/<pid>/environ
 * is fixed at exec); that copy is protected by the platform, not by this.
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of SECRET_KEYS) delete env[k];
}

/** Non-secret view for startup logging. */
export function describeConfig(cfg: Config): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if ((SECRET_KEYS as readonly string[]).includes(k)) continue;
    if (v === undefined) continue;
    out[k] = v as string | number | boolean | string[];
  }
  out["REPORTING_ENABLED"] = cfg.REPORTING_AUTH_TOKEN !== undefined;
  return out;
}
