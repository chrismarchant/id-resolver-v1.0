/**
 * Bounded runtime configuration. Every value is validated with explicit
 * bounds so a mis-set variable cannot disable a safety control silently.
 * Secrets are read once and never logged; `describeConfig()` returns only
 * non-secret values.
 */
import { z } from "zod";
import { IDENTIFIER_PATTERN } from "../contracts/api.js";
import { EVENT_CONSENT_MODES } from "../contracts/event.js";
import { parseCaCert, parseTlsPins, SSL_MODES, type DbTlsConfig } from "../db/tls.js";
import { DEFAULT_RUNTIME_ROLE, RUNTIME_PASSWORD_PATTERN, RUNTIME_ROLE_PATTERN } from "../db/runtime-role.js";

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

  // Database TLS (src/db/tls.ts; RUNTIME.md "Database TLS")
  DATABASE_SSL: z.enum(SSL_MODES).default("require"),
  /** verify-pinned only: SHA-256 fingerprint(s) of the server's leaf certificate, "current" or "current,next". */
  DATABASE_TLS_PIN_SHA256: z.string().max(400).optional(),
  /** PEM CA bundle: trust anchors for require; an additional chain check for verify-pinned. Not a secret. */
  DATABASE_CA_CERT: z.string().max(65_536).optional(),
  /** DATABASE_SSL=no-verify is refused when NODE_ENV=production unless this is set (development deployment only). */
  ALLOW_UNVERIFIED_DATABASE_TLS: boolFromString(false),

  // Database roles (src/db/runtime-role.ts; RUNTIME.md "Database roles")
  /** The least-privilege login role the service connects as; created and granted by the migrate step. */
  DATABASE_RUNTIME_ROLE: z.string().regex(RUNTIME_ROLE_PATTERN, "lowercase letters, digits, underscore; 1-63 chars; not starting with a digit or pg_").default(DEFAULT_RUNTIME_ROLE),
  /** Secret. Set = role separation on: migrate sets the role's password, the service logs in with it. */
  DATABASE_RUNTIME_PASSWORD: z.string().regex(RUNTIME_PASSWORD_PATTERN, "32-256 printable ASCII characters, no '%' (use openssl rand -hex 32)").optional(),
  /** NODE_ENV=production refuses to run as the DATABASE_URL owner role unless this is set (development deployment only). */
  ALLOW_OWNER_DATABASE_ROLE: boolFromString(false),

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

  // Browser events (contract event.v1, CHR-64; owner decision D4)
  /** POST /v1/events exists only when true; otherwise it answers 404 like any unknown route. Default off. */
  EVENTS_ENABLED: boolFromString(false),
  /** `required` (default): an event with consent `not_required` is refused with 403 consent_required. `not_required` accepts both values. */
  EVENT_CONSENT_MODE: z.enum(EVENT_CONSENT_MODES).default("required"),

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

export const SECRET_KEYS = ["RESOLVER_AUTH_TOKEN", "REPORTING_AUTH_TOKEN", "IP_HMAC_SECRET", "ENRICH_API_KEY", "DATABASE_URL", "DATABASE_RUNTIME_PASSWORD"] as const;

/** Kept out of describeConfig (not secret, but large and of no use in a log line). */
const UNLOGGED_KEYS = ["DATABASE_CA_CERT"] as const;

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

// ---- Three-database separation (docs/GUARDRAILS.md G3a) ---------------------
//
// The resolver (B: Railway service + its own PostgreSQL) is the operational
// system of record. The private Insights Supabase project (C) PULLS the
// sanitised reporting feed from it with its own Edge secret; the website's
// Supabase project (A) never talks to it. So the resolver holds no Supabase
// credential, URL or project ref, and never connects to a Supabase-hosted
// database. Both are refused at start-up, by migrate and by the ops commands,
// with fixed messages that name variables, never values.

/** Registrable domains Supabase serves projects, databases and its pooler (`*.pooler.supabase.com`) from. */
export const SUPABASE_HOST_SUFFIXES = ["supabase.co", "supabase.in", "supabase.com"] as const;

/** True for a Supabase-operated host name (case-insensitive, a trailing dot ignored). */
export function isSupabaseHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  return SUPABASE_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function decodedHost(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * True when a postgres URL would connect to a Supabase host: its host, or the
 * `host` / `hostaddr` query parameter that node-postgres (and libpq) let
 * override it, each percent-decoded and split on commas (libpq's host lists).
 * An unparsable URL is false here: the schema rejects it on its own.
 */
export function databaseUrlTargetsSupabase(databaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  const candidates = [url.hostname, ...url.searchParams.getAll("host"), ...url.searchParams.getAll("hostaddr")];
  return candidates.flatMap((c) => decodedHost(c).split(",")).some((h) => h.trim() !== "" && isSupabaseHost(h));
}

/**
 * The host node-postgres takes from a postgres URL, mirroring
 * pg-connection-string: the last `host` query parameter when it is not empty,
 * otherwise the URL's own host (brackets removed, percent-decoded). An empty
 * string means the URL names no host, and node-postgres then falls back to
 * the PGHOST environment variable (and to localhost). null: not a URL WHATWG
 * can parse (the schema and createPool refuse those on their own).
 */
export function databaseUrlHost(databaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  const param = url.searchParams.getAll("host").at(-1) ?? "";
  if (param !== "") return param;
  return decodedHost(url.hostname.replace(/^\[(.*)\]$/, "$1"));
}

/** True when a libpq-style host value (a comma-separated list, as in PGHOST) names a Supabase host. */
export function hostListTargetsSupabase(value: string): boolean {
  return decodedHost(value)
    .split(",")
    .some((h) => h.trim() !== "" && isSupabaseHost(h));
}

/** True when an http(s) or any other URL's host is a Supabase host. An unparsable URL is false (the schema rejects it). */
export function urlTargetsSupabase(value: string): boolean {
  try {
    return isSupabaseHost(decodedHost(new URL(value).hostname));
  } catch {
    return false;
  }
}

/**
 * Environment variables that node-postgres or libpq read as the database host
 * when a connection string names none. node-postgres reads PGHOST only; libpq
 * (psql, pg_dump) reads both. Their values are refused on a Supabase host;
 * otherwise they are left alone: an explicit DATABASE_URL host always wins in
 * node-postgres, and Railway's PostgreSQL service exposes a PGHOST that a
 * deployment may legitimately reference.
 */
export const PG_HOST_VARIABLES = ["PGHOST", "PGHOSTADDR"] as const;

/** Prefix of the variable names the resolver refuses outright (case-insensitive). */
export const SUPABASE_VARIABLE_PREFIX = "SUPABASE_";

/**
 * Refuses (ConfigError), before any connection: any SUPABASE_* variable; a
 * DATABASE_URL on a Supabase host, or naming no host at all (node-postgres
 * would then take it from PGHOST: the resolver always names its own
 * PostgreSQL host explicitly); PGHOST or PGHOSTADDR on a Supabase host; and an
 * ENRICH_API_BASE_URL on a Supabase host. The single shared check of loadConfig,
 * migrate, the ops commands and ops:db-tls-fingerprint. Fixed messages: they
 * name variables, never values, and a variable name that is not a plain
 * identifier is not echoed.
 */
export function assertNoSupabaseConfiguration(env: NodeJS.ProcessEnv): void {
  const names = Object.keys(env)
    .filter((k) => k.toUpperCase().startsWith(SUPABASE_VARIABLE_PREFIX))
    .map((k) => (/^[A-Za-z0-9_]{1,64}$/.test(k) ? k : `${SUPABASE_VARIABLE_PREFIX}<name not shown>`))
    .sort();
  if (names.length > 0) {
    throw new ConfigError(
      `invalid configuration: Supabase variable(s) set: ${names.join(", ")} (the resolver holds no Supabase credential, URL or project ref: the private Supabase project pulls the reporting feed; remove them)`,
    );
  }
  const databaseUrl = env["DATABASE_URL"];
  if (typeof databaseUrl === "string" && databaseUrlTargetsSupabase(databaseUrl)) {
    throw new ConfigError(
      "invalid configuration: DATABASE_URL points at a Supabase-hosted database (refused: the resolver's system of record is its own PostgreSQL, never a Supabase project)",
    );
  }
  if (typeof databaseUrl === "string" && databaseUrlHost(databaseUrl) === "") {
    throw new ConfigError(
      "invalid configuration: DATABASE_URL names no host (refused: node-postgres would take the host from PGHOST; name the resolver's own PostgreSQL host in DATABASE_URL)",
    );
  }
  for (const name of PG_HOST_VARIABLES) {
    const value = env[name];
    if (typeof value === "string" && hostListTargetsSupabase(value)) {
      throw new ConfigError(`invalid configuration: ${name} names a Supabase host (refused: the resolver never connects to a Supabase project)`);
    }
  }
  const enrichBaseUrl = env["ENRICH_API_BASE_URL"];
  if (typeof enrichBaseUrl === "string" && urlTargetsSupabase(enrichBaseUrl)) {
    throw new ConfigError(
      "invalid configuration: ENRICH_API_BASE_URL points at a Supabase host (refused: it is the enrichment provider, and the resolver never connects to a Supabase project)",
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const removed = Object.keys(REMOVED_VARIABLES).filter((k) => env[k] !== undefined);
  if (removed.length > 0) {
    throw new ConfigError(`invalid configuration: removed variable(s) set: ${removed.map((k) => `${k} (${REMOVED_VARIABLES[k]})`).join("; ")}`);
  }
  assertNoSupabaseConfiguration(env);
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Only variable names are reported, never values.
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid configuration: ${names.join("; ")}`);
  }
  const cfg = parsed.data;
  resolveDatabaseTls(cfg);
  resolveRuntimeCredentials(cfg);
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

/** The variables the database TLS policy reads (shared by the service, migrate and the ops commands). */
export type DatabaseTlsSettings = Pick<Config, "NODE_ENV" | "DATABASE_SSL" | "DATABASE_TLS_PIN_SHA256" | "DATABASE_CA_CERT" | "ALLOW_UNVERIFIED_DATABASE_TLS">;

/**
 * The validated TLS configuration for every database connection path.
 * Production (NODE_ENV=production, the default) refuses `disable` always and
 * `no-verify` unless ALLOW_UNVERIFIED_DATABASE_TLS=true. Throws ConfigError
 * naming variables only.
 */
export function resolveDatabaseTls(cfg: DatabaseTlsSettings): DbTlsConfig {
  const mode = cfg.DATABASE_SSL;
  const production = cfg.NODE_ENV === "production";
  if (production && mode === "disable") {
    throw new ConfigError("invalid configuration: DATABASE_SSL=disable is refused when NODE_ENV=production (use verify-pinned or require)");
  }
  if (production && mode === "no-verify" && !cfg.ALLOW_UNVERIFIED_DATABASE_TLS) {
    throw new ConfigError(
      "invalid configuration: DATABASE_SSL=no-verify is refused when NODE_ENV=production unless ALLOW_UNVERIFIED_DATABASE_TLS=true (development deployment only; use verify-pinned)",
    );
  }
  if (cfg.DATABASE_TLS_PIN_SHA256 !== undefined && mode !== "verify-pinned") {
    throw new ConfigError("invalid configuration: DATABASE_TLS_PIN_SHA256 is only used with DATABASE_SSL=verify-pinned");
  }
  if (cfg.DATABASE_CA_CERT !== undefined && mode !== "require" && mode !== "verify-pinned") {
    throw new ConfigError("invalid configuration: DATABASE_CA_CERT is only used with DATABASE_SSL=require or verify-pinned");
  }
  let pins: string[] | undefined;
  let caCert: string | undefined;
  try {
    if (mode === "verify-pinned") {
      if (cfg.DATABASE_TLS_PIN_SHA256 === undefined) throw new Error("DATABASE_SSL=verify-pinned requires DATABASE_TLS_PIN_SHA256");
      pins = parseTlsPins(cfg.DATABASE_TLS_PIN_SHA256);
    }
    if (cfg.DATABASE_CA_CERT !== undefined) caCert = parseCaCert(cfg.DATABASE_CA_CERT);
  } catch (e) {
    // The parsers' messages name variables only.
    throw new ConfigError(`invalid configuration: ${(e as Error).message}`);
  }
  return { mode, ...(pins ? { pins } : {}), ...(caCert ? { caCert } : {}) };
}

export type DatabaseRoleSettings = Pick<Config, "NODE_ENV" | "DATABASE_URL" | "DATABASE_RUNTIME_ROLE" | "DATABASE_RUNTIME_PASSWORD" | "ALLOW_OWNER_DATABASE_ROLE">;

/** The DATABASE_URL user name (decoded), or "" when the URL has none or cannot be parsed. */
export function databaseUrlUser(databaseUrl: string): string {
  try {
    return decodeURIComponent(new URL(databaseUrl).username);
  } catch {
    return "";
  }
}

/**
 * The service's login: the runtime role when DATABASE_RUNTIME_PASSWORD is set,
 * otherwise undefined (the DATABASE_URL user, i.e. the owner). Production
 * refuses the owner unless ALLOW_OWNER_DATABASE_ROLE=true. Throws ConfigError
 * naming variables only.
 */
export function resolveRuntimeCredentials(cfg: DatabaseRoleSettings): { user: string; password: string } | undefined {
  if (cfg.DATABASE_RUNTIME_PASSWORD !== undefined) {
    if (cfg.DATABASE_RUNTIME_ROLE === databaseUrlUser(cfg.DATABASE_URL)) {
      throw new ConfigError("invalid configuration: DATABASE_RUNTIME_ROLE must differ from the DATABASE_URL user (the owner that runs migrations)");
    }
    return { user: cfg.DATABASE_RUNTIME_ROLE, password: cfg.DATABASE_RUNTIME_PASSWORD };
  }
  if (cfg.NODE_ENV === "production" && !cfg.ALLOW_OWNER_DATABASE_ROLE) {
    throw new ConfigError(
      "invalid configuration: NODE_ENV=production requires the separate runtime database role: set DATABASE_RUNTIME_PASSWORD (see RUNTIME.md), or ALLOW_OWNER_DATABASE_ROLE=true on a development deployment only",
    );
  }
  return undefined;
}

const DatabaseTlsSchema = ConfigSchema.pick({
  NODE_ENV: true,
  DATABASE_SSL: true,
  DATABASE_TLS_PIN_SHA256: true,
  DATABASE_CA_CERT: true,
  ALLOW_UNVERIFIED_DATABASE_TLS: true,
});

/**
 * For the CLIs (migrate, ops commands): the same TLS policy as the service,
 * read from the environment (NODE_ENV defaults to production there too), and
 * one warning line per dev-only override that is set. Throws ConfigError
 * naming variables only.
 */
export function loadDatabaseTls(env: NodeJS.ProcessEnv = process.env): { tls: DbTlsConfig; warnings: string[] } {
  const parsed = DatabaseTlsSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid configuration: ${names.join("; ")}`);
  }
  const tls = resolveDatabaseTls(parsed.data);
  const warnings: string[] = [];
  if (parsed.data.ALLOW_UNVERIFIED_DATABASE_TLS) {
    warnings.push(
      parsed.data.NODE_ENV === "production" && parsed.data.DATABASE_SSL === "no-verify"
        ? "warning: override ALLOW_UNVERIFIED_DATABASE_TLS is active: the database certificate is not verified (development deployment only)"
        : "warning: override ALLOW_UNVERIFIED_DATABASE_TLS is set but has no effect; remove it",
    );
  }
  return { tls, warnings };
}

export interface OverrideState {
  variable: "ALLOW_MOCK_PROVIDER" | "ALLOW_UNVERIFIED_DATABASE_TLS" | "ALLOW_OWNER_DATABASE_ROLE";
  /** active: it is relaxing a production control right now; inert: set but without effect (remove it). */
  state: "active" | "inert";
}

/** Every dev-only override that is set, and whether it is in effect. Logged as warnings at startup (names only). */
export function configOverrides(cfg: Config): OverrideState[] {
  const production = cfg.NODE_ENV === "production";
  const out: OverrideState[] = [];
  if (cfg.ALLOW_MOCK_PROVIDER) out.push({ variable: "ALLOW_MOCK_PROVIDER", state: production && cfg.PROVIDER_MODE === "mock" ? "active" : "inert" });
  if (cfg.ALLOW_UNVERIFIED_DATABASE_TLS) out.push({ variable: "ALLOW_UNVERIFIED_DATABASE_TLS", state: production && cfg.DATABASE_SSL === "no-verify" ? "active" : "inert" });
  if (cfg.ALLOW_OWNER_DATABASE_ROLE) out.push({ variable: "ALLOW_OWNER_DATABASE_ROLE", state: production && cfg.DATABASE_RUNTIME_PASSWORD === undefined ? "active" : "inert" });
  return out;
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
    if ((SECRET_KEYS as readonly string[]).includes(k) || (UNLOGGED_KEYS as readonly string[]).includes(k)) continue;
    if (v === undefined) continue;
    out[k] = v as string | number | boolean | string[];
  }
  out["REPORTING_ENABLED"] = cfg.REPORTING_AUTH_TOKEN !== undefined;
  return out;
}
