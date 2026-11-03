import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../../src/config/index.js";
import { testConfig, TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";

describe("bounded configuration", () => {
  it("rejects timing combinations that would kill children before they can commit or drain", () => {
    expect(() => testConfig({ SHUTDOWN_GRACE_MS: "1000", REQUEST_DEADLINE_MS: "2000", CHILD_HARD_KILL_GRACE_MS: "500" })).toThrow(ConfigError);
    expect(() => testConfig({ ENRICH_TIMEOUT_MS: "5000", REQUEST_DEADLINE_MS: "4000", LEASE_MS: "6000" })).toThrow(ConfigError);
    expect(() => testConfig({ LEASE_MS: "500", ENRICH_TIMEOUT_MS: "800" })).toThrow(ConfigError);
    expect(() => testConfig({ PROVIDER_MODE: "live", ENRICH_API_KEY: "" })).toThrow(ConfigError);
  });

  it("names variables but never values in configuration errors", () => {
    let message = "";
    try {
      loadConfig({ INSTALLATION_ID: "Bad Id!", WEBSITE_ID: "site", RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN, IP_HMAC_SECRET: TEST_HMAC_SECRET, DATABASE_URL: "postgres://u:supersecretpw@h/db", PERIOD_CALL_CAP: "-5" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("INSTALLATION_ID");
    expect(message).toContain("PERIOD_CALL_CAP");
    expect(message).not.toContain("supersecretpw");
    expect(message).not.toContain(TEST_AUTH_TOKEN);
    expect(message).not.toContain("Bad Id!");
  });

  it("never describes secrets", () => {
    const text = JSON.stringify(describeConfig(testConfig()));
    expect(text).not.toContain(TEST_AUTH_TOKEN);
    expect(text).not.toContain(TEST_HMAC_SECRET);
    expect(text).not.toContain("resolver:resolver");
    expect(text).not.toContain("sk_test");
  });

  it("validates the reporting credential and retention bounds without describing them", () => {
    const token = "r".repeat(40);
    expect(() => testConfig({ REPORTING_AUTH_TOKEN: testConfig().RESOLVER_AUTH_TOKEN })).toThrow(/REPORTING_AUTH_TOKEN/);
    expect(() => testConfig({ REPORTING_AUTH_TOKEN: "short" })).toThrow(ConfigError);
    expect(() => testConfig({ OBSERVATION_RETENTION_DAYS: "3651" })).toThrow(ConfigError);
    expect(() => testConfig({ OBSERVATION_RETENTION_DAYS: "-1" })).toThrow(ConfigError);
    const cfg = testConfig({ REPORTING_AUTH_TOKEN: token, OBSERVATION_RETENTION_DAYS: "90" });
    expect(cfg.REPORTING_AUTH_TOKEN).toBe(token);
    expect(cfg.OBSERVATION_RETENTION_DAYS).toBe(90);
    expect(testConfig().OBSERVATION_RETENTION_DAYS).toBe(0);
    expect(testConfig().REPORTING_AUTH_TOKEN).toBeUndefined();
    const described = describeConfig(cfg);
    expect(JSON.stringify(described)).not.toContain(token);
    expect(described["REPORTING_ENABLED"]).toBe(true);
    expect(describeConfig(testConfig())["REPORTING_ENABLED"]).toBe(false);
    try {
      testConfig({ REPORTING_AUTH_TOKEN: "short" });
    } catch (err) {
      expect(String(err)).not.toContain("short");
    }
  });
});
