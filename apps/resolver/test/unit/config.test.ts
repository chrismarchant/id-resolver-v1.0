import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig, REMOVED_VARIABLES, scrubSecretEnv, SECRET_KEYS } from "../../src/config/index.js";
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
