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
  ENRICH_API_BASE_URL: z.string().url().max(512).default("https://dev.enrich.so/api/v3"),
  ENRICH_AUTH_HEADER: z.enum(["x-api-key", "authorization-bearer"]).default("x-api-key"),
  ENRICH_TIMEOUT_MS: intInRange(200, 10_000, 2_500),

  // Request handling
  REQUEST_DEADLINE_MS: intInRange(300, 15_000, 4_000),
  CHILD_HARD_KILL_GRACE_MS: intInRange(100, 10_000, 1_000),
  MAX_CONCURRENT_CHILDREN: intInRange(1, 64, 8),
  RATE_LIMIT_PER_MINUTE: intInRange(1, 100_000, 600),
  AUTH_FAILURE_LIMIT_PER_MINUTE: intInRange(1, 100_000, 60),
  BODY_LIMIT_BYTES: intInRange(128, 8_192, 1_024),
  SHUTDOWN_GRACE_MS: intInRange(500, 30_000, 8_000),

  /** V1: migrations run only via the deploy pre-step (railway.json preDeployCommand) or `npm run migrate`. */
  RUN_MIGRATIONS_ON_START: boolFromString(false),

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
  CACHE_PRUNE_INTERVAL_S: intInRange(30, 86_400, 600),
  CACHE_PRUNE_BATCH: intInRange(10, 100_000, 1_000),
  /** Durable observation retention in days; 0 keeps observations indefinitely. Companies and scope stats are never pruned. */
  OBSERVATION_RETENTION_DAYS: intInRange(0, 3_650, 0),

  // Qualification policy
  QUALIFIED_USAGE_TYPES: csv(["COM", "ORG", "GOV", "EDU", "MIL", "LIB"]),
  EXCLUDED_USAGE_TYPES: csv(["ISP", "MOB", "DCH", "CDN", "SES", "AIC", "RSV"]),
  DENIED_DOMAINS: csv([]),
  /** RFC 5737/3849 documentation ranges are ineligible in production; tests enable them. */
  ALLOW_DOCUMENTATION_RANGES: boolFromString(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export const SECRET_KEYS = ["RESOLVER_AUTH_TOKEN", "REPORTING_AUTH_TOKEN", "IP_HMAC_SECRET", "ENRICH_API_KEY", "DATABASE_URL"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Only variable names are reported, never values.
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid configuration: ${names.join("; ")}`);
  }
  const cfg = parsed.data;
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
  if (cfg.SHUTDOWN_GRACE_MS < cfg.REQUEST_DEADLINE_MS + cfg.CHILD_HARD_KILL_GRACE_MS) {
    throw new ConfigError("invalid configuration: SHUTDOWN_GRACE_MS must be at least REQUEST_DEADLINE_MS + CHILD_HARD_KILL_GRACE_MS");
  }
  return cfg;
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
