import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, describeConfig, loadConfig, REMOVED_VARIABLES, scrubSecretEnv, SECRET_KEYS, shadowSourcesState } from "../../src/config/index.js";
import { loadOpsConfig, loadRetentionDays } from "../../src/ops/env.js";
import { testConfig, TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { TEST_RUNTIME_PASSWORD } from "../helpers/runtime-role.js";

/** The minimum a deployment must set (no defaults exist for these). */
const REQUIRED = {
  INSTALLATION_ID: "inst-test",
  WEBSITE_ID: "site-test",
  RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN,
  IP_HMAC_SECRET: TEST_HMAC_SECRET,
  DATABASE_URL: "postgres://user:pw@db.invalid:5432/resolver",
  OBSERVATION_RETENTION_DAYS: "14",
  // Production (the default NODE_ENV) requires the separate runtime role (Gate 5).
  DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD,
};

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("bounded configuration", () => {
  it("rejects timing combinations that would answer or drain too late", () => {
    expect(() => testConfig({ SHUTDOWN_GRACE_MS: "2499", REQUEST_DEADLINE_MS: "2000" })).toThrow(/SHUTDOWN_GRACE_MS/);
    expect(testConfig({ SHUTDOWN_GRACE_MS: "2500", REQUEST_DEADLINE_MS: "2000" }).SHUTDOWN_GRACE_MS).toBe(2500);
    expect(() => testConfig({ ENRICH_TIMEOUT_MS: "5000", REQUEST_DEADLINE_MS: "4000", LEASE_MS: "6000" })).toThrow(ConfigError);
    expect(() => testConfig({ LEASE_MS: "500", ENRICH_TIMEOUT_MS: "800" })).toThrow(ConfigError);
    expect(() => testConfig({ PROVIDER_MODE: "live", ENRICH_API_KEY: "" })).toThrow(ConfigError);
  });

  it("bounds the maintenance budget and keeps it below the interval (CHR-66 F1)", () => {
    expect(testConfig().CACHE_PRUNE_BUDGET_MS).toBe(20_000);
    expect(testConfig({ CACHE_PRUNE_INTERVAL_S: "30", CACHE_PRUNE_BUDGET_MS: "29999" }).CACHE_PRUNE_BUDGET_MS).toBe(29_999);
    expect(() => testConfig({ CACHE_PRUNE_INTERVAL_S: "30", CACHE_PRUNE_BUDGET_MS: "30000" })).toThrow(/CACHE_PRUNE_BUDGET_MS must be below/);
    for (const bad of ["999", "300001", "abc"]) expect(() => testConfig({ CACHE_PRUNE_BUDGET_MS: bad })).toThrow(/CACHE_PRUNE_BUDGET_MS/);
  });

  it("names variables but never values in configuration errors", () => {
    const message = errorOf(() => loadConfig({ ...REQUIRED, INSTALLATION_ID: "Bad Id!", DATABASE_URL: "postgres://u:supersecretpw@h/db", PERIOD_CALL_CAP: "-5" }));
    expect(message).toContain("INSTALLATION_ID");
    expect(message).toContain("PERIOD_CALL_CAP");
    expect(message).not.toContain("supersecretpw");
    expect(message).not.toContain(TEST_AUTH_TOKEN);
    expect(message).not.toContain("Bad Id!");
  });

  it("PERIOD_RESOLVED_CAP is optional and bounded; unset means no limit beyond PERIOD_CALL_CAP", () => {
    expect(loadConfig(REQUIRED).PERIOD_RESOLVED_CAP).toBeUndefined();
    expect(loadConfig({ ...REQUIRED, PERIOD_RESOLVED_CAP: "50" }).PERIOD_RESOLVED_CAP).toBe(50);
    expect(loadConfig({ ...REQUIRED, PERIOD_RESOLVED_CAP: "0" }).PERIOD_RESOLVED_CAP).toBe(0);
    for (const bad of ["-1", "1.5", "lots", "10000001"]) {
      expect(errorOf(() => loadConfig({ ...REQUIRED, PERIOD_RESOLVED_CAP: bad }))).toContain("PERIOD_RESOLVED_CAP");
    }
  });

  it("HOSTING_RANGES_MODE is off by default and accepts only off, shadow or enforce", () => {
    expect(loadConfig(REQUIRED).HOSTING_RANGES_MODE).toBe("off");
    for (const mode of ["off", "shadow", "enforce"]) expect(loadConfig({ ...REQUIRED, HOSTING_RANGES_MODE: mode }).HOSTING_RANGES_MODE).toBe(mode);
    for (const bad of ["on", "true", "SHADOW", ""]) expect(errorOf(() => loadConfig({ ...REQUIRED, HOSTING_RANGES_MODE: bad }))).toContain("HOSTING_RANGES_MODE");
  });

  it("never describes secrets", () => {
    const text = JSON.stringify(describeConfig(testConfig()));
    expect(text).not.toContain(TEST_AUTH_TOKEN);
    expect(text).not.toContain(TEST_HMAC_SECRET);
    expect(text).not.toContain("resolver:resolver");
    expect(text).not.toContain("sk_test");
  });

  it("validates the reporting credential without describing it", () => {
    const token = "r".repeat(40);
    expect(() => testConfig({ REPORTING_AUTH_TOKEN: testConfig().RESOLVER_AUTH_TOKEN })).toThrow(/REPORTING_AUTH_TOKEN/);
    expect(() => testConfig({ REPORTING_AUTH_TOKEN: "short" })).toThrow(ConfigError);
    const cfg = testConfig({ REPORTING_AUTH_TOKEN: token });
    expect(cfg.REPORTING_AUTH_TOKEN).toBe(token);
    expect(testConfig().REPORTING_AUTH_TOKEN).toBeUndefined();
    const described = describeConfig(cfg);
    expect(JSON.stringify(described)).not.toContain(token);
    expect(described["REPORTING_ENABLED"]).toBe(true);
    expect(describeConfig(testConfig())["REPORTING_ENABLED"]).toBe(false);
    expect(errorOf(() => testConfig({ REPORTING_AUTH_TOKEN: "short" }))).not.toContain("short");
  });
});

describe("observation retention (owner decision D3): required, bounded, no default", () => {
  it("is required: an unset value refuses to start and says there is no default", () => {
    const { OBSERVATION_RETENTION_DAYS: _r, ...withoutRetention } = REQUIRED;
    const message = errorOf(() => loadConfig(withoutRetention));
    expect(message).toContain("OBSERVATION_RETENTION_DAYS");
    expect(message).toContain("no default");
  });

  it.each(["0", "366", "3650", "-1", "", "1.5", "30d", " 30"])("rejects %j", (value) => {
    expect(errorOf(() => loadConfig({ ...REQUIRED, OBSERVATION_RETENTION_DAYS: value }))).toContain("OBSERVATION_RETENTION_DAYS");
  });

  it.each([
    ["1", 1],
    ["30", 30],
    ["365", 365],
  ])("accepts %s", (value, days) => {
    expect(loadConfig({ ...REQUIRED, OBSERVATION_RETENTION_DAYS: value }).OBSERVATION_RETENTION_DAYS).toBe(days);
  });

  it("the prune command needs it too, while the other operator commands do not", () => {
    expect(loadRetentionDays({ OBSERVATION_RETENTION_DAYS: "7" })).toBe(7);
    expect(() => loadRetentionDays({})).toThrow(/OBSERVATION_RETENTION_DAYS/);
    expect(() => loadRetentionDays({ OBSERVATION_RETENTION_DAYS: "400" })).toThrow(/OBSERVATION_RETENTION_DAYS/);
    const { OBSERVATION_RETENTION_DAYS: _r, ...ops } = REQUIRED;
    expect(loadOpsConfig(ops).INSTALLATION_ID).toBe("inst-test");
  });
});

describe("browser events (event.v1, CHR-64): off by default, consent required by default, fail closed", () => {
  it("defaults: EVENTS_ENABLED=false and EVENT_CONSENT_MODE=required", () => {
    const cfg = loadConfig(REQUIRED);
    expect(cfg.EVENTS_ENABLED).toBe(false);
    expect(cfg.EVENT_CONSENT_MODE).toBe("required");
    expect(describeConfig(cfg)).toMatchObject({ EVENTS_ENABLED: false, EVENT_CONSENT_MODE: "required" });
  });

  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("EVENTS_ENABLED accepts %j", (value, enabled) => {
    expect(loadConfig({ ...REQUIRED, EVENTS_ENABLED: value }).EVENTS_ENABLED).toBe(enabled);
  });

  it.each(["yes", "on", "TRUE", "", " true", "2", "enabled-sentinel-value"])("EVENTS_ENABLED refuses %j instead of guessing", (value) => {
    const message = errorOf(() => loadConfig({ ...REQUIRED, EVENTS_ENABLED: value }));
    expect(message).toContain("EVENTS_ENABLED");
    expect(message).not.toContain("enabled-sentinel-value");
  });

  it.each(["required", "not_required"] as const)("EVENT_CONSENT_MODE accepts %s", (mode) => {
    expect(loadConfig({ ...REQUIRED, EVENT_CONSENT_MODE: mode }).EVENT_CONSENT_MODE).toBe(mode);
  });

  it.each(["off", "none", "", "REQUIRED", "optional", "granted"])("EVENT_CONSENT_MODE refuses %j", (value) => {
    expect(errorOf(() => loadConfig({ ...REQUIRED, EVENT_CONSENT_MODE: value }))).toContain("EVENT_CONSENT_MODE");
  });
});

describe("mock provider in production", () => {
  it("is refused when NODE_ENV=production unless ALLOW_MOCK_PROVIDER=true", () => {
    expect(errorOf(() => loadConfig({ ...REQUIRED, NODE_ENV: "production", PROVIDER_MODE: "mock" }))).toContain("ALLOW_MOCK_PROVIDER");
    expect(errorOf(() => loadConfig({ ...REQUIRED, PROVIDER_MODE: "mock" }))).toContain("PROVIDER_MODE=mock"); // NODE_ENV defaults to production
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: "production", PROVIDER_MODE: "mock", ALLOW_MOCK_PROVIDER: "false" })).toThrow(ConfigError);
    const dev = loadConfig({ ...REQUIRED, NODE_ENV: "production", PROVIDER_MODE: "mock", ALLOW_MOCK_PROVIDER: "true" });
    expect(dev.PROVIDER_MODE).toBe("mock");
    expect(dev.ALLOW_MOCK_PROVIDER).toBe(true);
  });

  it("is allowed outside production without the flag, and the flag never affects other modes", () => {
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "development", PROVIDER_MODE: "mock" }).PROVIDER_MODE).toBe("mock");
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "test", PROVIDER_MODE: "mock" }).PROVIDER_MODE).toBe("mock");
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "production", PROVIDER_MODE: "disabled" }).PROVIDER_MODE).toBe("disabled");
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "production" }).ALLOW_MOCK_PROVIDER).toBe(false);
  });
});

describe("single-process runtime variables (CHR-70)", () => {
  it("bounds MAX_CONCURRENT_JOBS and EVENT_LOOP_BLOCK_EXIT_MS", () => {
    expect(loadConfig(REQUIRED).MAX_CONCURRENT_JOBS).toBe(8);
    expect(loadConfig(REQUIRED).EVENT_LOOP_BLOCK_EXIT_MS).toBe(10_000);
    for (const v of ["0", "65"]) expect(() => loadConfig({ ...REQUIRED, MAX_CONCURRENT_JOBS: v })).toThrow(/MAX_CONCURRENT_JOBS/);
    for (const v of ["999", "60001"]) expect(() => loadConfig({ ...REQUIRED, EVENT_LOOP_BLOCK_EXIT_MS: v })).toThrow(/EVENT_LOOP_BLOCK_EXIT_MS/);
  });

  it.each(Object.keys(REMOVED_VARIABLES))("refuses the removed variable %s instead of silently ignoring it", (name) => {
    const message = errorOf(() => loadConfig({ ...REQUIRED, [name]: "4" }));
    expect(message).toContain(name);
    expect(message).not.toContain('"4"');
  });

  it("scrubs the secrets from the live environment once loaded", () => {
    const env: NodeJS.ProcessEnv = { ...REQUIRED, ENRICH_API_KEY: "sk_test_placeholder", REPORTING_AUTH_TOKEN: "r".repeat(40), PORT: "8080" };
    const cfg = loadConfig(env);
    scrubSecretEnv(env);
    for (const k of SECRET_KEYS) expect(env[k], k).toBeUndefined();
    expect(env["PORT"]).toBe("8080");
    expect(cfg.IP_HMAC_SECRET).toBe(TEST_HMAC_SECRET);
  });
});

describe("watch-only source comparison (SHADOW_SOURCES_MODE)", () => {
  const IPAPI_KEY = "0123456789abcdef0123456789abcdef";
  const IPLOCATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";

  it("is off by default with the documented defaults", () => {
    const cfg = loadConfig(REQUIRED);
    expect(cfg).toMatchObject({
      SHADOW_SOURCES_MODE: "off",
      IPAPI_IS_API_KEY: "",
      IPLOCATE_API_KEY: "",
      SHADOW_IPAPI_DAILY_LIMIT: 900,
      SHADOW_IPLOCATE_DAILY_LIMIT: 900,
      SHADOW_TIMEOUT_MS: 2_000,
      SHADOW_CONCURRENCY: 4,
      SHADOW_QUEUE_MAX: 200,
      IPNETDB_ENABLED: true,
      IPNETDB_MANIFEST_URL: "https://ipnetdb.com/latest.json",
      IPNETDB_DIR: join(tmpdir(), "ipnetdb"),
    });
    expect(shadowSourcesState(cfg)).toEqual({ mode: "off", ipapi: "off", iplocate: "off", ipnetdb: "off" });
    // Keys alone never switch it on.
    expect(shadowSourcesState(loadConfig({ ...REQUIRED, IPAPI_IS_API_KEY: IPAPI_KEY })).mode).toBe("off");
  });

  it("on: a source is active only with a key; IPNetDB follows IPNETDB_ENABLED", () => {
    expect(shadowSourcesState(loadConfig({ ...REQUIRED, SHADOW_SOURCES_MODE: "on" }))).toEqual({ mode: "on", ipapi: "no_key", iplocate: "no_key", ipnetdb: "enabled" });
    const both = loadConfig({ ...REQUIRED, SHADOW_SOURCES_MODE: "on", IPAPI_IS_API_KEY: IPAPI_KEY, IPLOCATE_API_KEY: IPLOCATE_KEY, IPNETDB_ENABLED: "false" });
    expect(shadowSourcesState(both)).toEqual({ mode: "on", ipapi: "active", iplocate: "active", ipnetdb: "disabled" });
  });

  it("the keys are secrets: never described, scrubbed from the environment, never in an error", () => {
    expect(SECRET_KEYS).toContain("IPAPI_IS_API_KEY");
    expect(SECRET_KEYS).toContain("IPLOCATE_API_KEY");
    const env: NodeJS.ProcessEnv = { ...REQUIRED, SHADOW_SOURCES_MODE: "on", IPAPI_IS_API_KEY: IPAPI_KEY, IPLOCATE_API_KEY: IPLOCATE_KEY };
    const cfg = loadConfig(env);
    const described = describeConfig(cfg);
    const text = JSON.stringify(described);
    expect(text).not.toContain(IPAPI_KEY);
    expect(text).not.toContain(IPLOCATE_KEY);
    expect(described).toMatchObject({ SHADOW_SOURCES_MODE: "on", SHADOW_IPAPI: "active", SHADOW_IPLOCATE: "active", SHADOW_IPNETDB: "enabled", SHADOW_IPAPI_DAILY_LIMIT: 900 });
    expect(described).not.toHaveProperty("IPAPI_IS_API_KEY");
    expect(described).not.toHaveProperty("IPLOCATE_API_KEY");
    scrubSecretEnv(env);
    expect(env["IPAPI_IS_API_KEY"]).toBeUndefined();
    expect(env["IPLOCATE_API_KEY"]).toBeUndefined();
    expect(cfg.IPAPI_IS_API_KEY).toBe(IPAPI_KEY);
    const message = errorOf(() => loadConfig({ ...REQUIRED, IPAPI_IS_API_KEY: "short7!" }));
    expect(message).toContain("IPAPI_IS_API_KEY");
    expect(message).not.toContain("short7!");
    expect(errorOf(() => loadConfig({ ...REQUIRED, IPLOCATE_API_KEY: "x" }))).toContain("IPLOCATE_API_KEY");
  });

  it.each([
    ["SHADOW_SOURCES_MODE", ["true", "shadow", "ON", ""]],
    ["SHADOW_IPAPI_DAILY_LIMIT", ["-1", "100001", "1.5", "lots"]],
    ["SHADOW_IPLOCATE_DAILY_LIMIT", ["-1", "100001"]],
    ["SHADOW_TIMEOUT_MS", ["199", "10001"]],
    ["SHADOW_CONCURRENCY", ["0", "33"]],
    ["SHADOW_QUEUE_MAX", ["0", "10001"]],
    ["IPNETDB_ENABLED", ["yes", "on"]],
    ["IPNETDB_MANIFEST_URL", ["not a url", "http://ipnetdb.com/latest.json", "ftp://ipnetdb.com/latest.json"]],
    ["IPNETDB_DIR", [""]],
  ])("%s refuses out-of-range values", (name, values) => {
    for (const v of values) expect(errorOf(() => loadConfig({ ...REQUIRED, [name]: v })), `${name}=${v}`).toContain(name);
  });

  it("accepts the bounds", () => {
    const cfg = loadConfig({
      ...REQUIRED,
      SHADOW_SOURCES_MODE: "on",
      SHADOW_IPAPI_DAILY_LIMIT: "0",
      SHADOW_IPLOCATE_DAILY_LIMIT: "100000",
      SHADOW_TIMEOUT_MS: "200",
      SHADOW_CONCURRENCY: "32",
      SHADOW_QUEUE_MAX: "10000",
      IPNETDB_DIR: "/var/tmp/ipnetdb",
    });
    expect(cfg).toMatchObject({ SHADOW_IPAPI_DAILY_LIMIT: 0, SHADOW_IPLOCATE_DAILY_LIMIT: 100_000, SHADOW_TIMEOUT_MS: 200, SHADOW_CONCURRENCY: 32, SHADOW_QUEUE_MAX: 10_000, IPNETDB_DIR: "/var/tmp/ipnetdb" });
  });
});
