/**
 * Configuration of the separate runtime database role (Gate 5): production
 * requires it unless the dev-only ALLOW_OWNER_DATABASE_ROLE override is set;
 * the password is a secret (never logged, scrubbed from the environment);
 * names and passwords are validated without echoing values. Database-side
 * behaviour is in test/integration/runtime-role.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, configOverrides, describeConfig, loadConfig, resolveRuntimeCredentials, SECRET_KEYS } from "../../src/config/index.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { TEST_RUNTIME_PASSWORD } from "../helpers/runtime-role.js";

const BASE = {
  INSTALLATION_ID: "inst-test",
  WEBSITE_ID: "site-test",
  RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN,
  IP_HMAC_SECRET: TEST_HMAC_SECRET,
  DATABASE_URL: "postgres://owner:ownerpw@db.invalid:5432/resolver",
  OBSERVATION_RETENTION_DAYS: "14",
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

describe("runtime database role configuration", () => {
  it("production refuses to run as the DATABASE_URL owner unless ALLOW_OWNER_DATABASE_ROLE=true (then reported as an active override)", () => {
    const msg = errorOf(() => loadConfig(BASE));
    expect(msg).toContain("NODE_ENV=production requires the separate runtime database role: set DATABASE_RUNTIME_PASSWORD");
    expect(msg).toContain("ALLOW_OWNER_DATABASE_ROLE=true on a development deployment only");
    const cfg = loadConfig({ ...BASE, ALLOW_OWNER_DATABASE_ROLE: "true" });
    expect(resolveRuntimeCredentials(cfg)).toBeUndefined();
    expect(configOverrides(cfg)).toEqual([{ variable: "ALLOW_OWNER_DATABASE_ROLE", state: "active" }]);
  });

  it("outside production the owner login is allowed without an override", () => {
    for (const env of ["development", "test"]) {
      expect(resolveRuntimeCredentials(loadConfig({ ...BASE, NODE_ENV: env }))).toBeUndefined();
    }
  });

  it("with DATABASE_RUNTIME_PASSWORD the service logs in as DATABASE_RUNTIME_ROLE (default idr_runtime); a leftover override is inert", () => {
    const cfg = loadConfig({ ...BASE, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD });
    expect(cfg.DATABASE_RUNTIME_ROLE).toBe("idr_runtime");
    expect(resolveRuntimeCredentials(cfg)).toEqual({ user: "idr_runtime", password: TEST_RUNTIME_PASSWORD });
    const custom = loadConfig({ ...BASE, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD, DATABASE_RUNTIME_ROLE: "idr_app_2", ALLOW_OWNER_DATABASE_ROLE: "true" });
    expect(resolveRuntimeCredentials(custom)).toEqual({ user: "idr_app_2", password: TEST_RUNTIME_PASSWORD });
    expect(configOverrides(custom)).toEqual([{ variable: "ALLOW_OWNER_DATABASE_ROLE", state: "inert" }]);
  });

  it("refuses a runtime role equal to the owner in DATABASE_URL", () => {
    expect(errorOf(() => loadConfig({ ...BASE, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD, DATABASE_RUNTIME_ROLE: "owner" }))).toContain(
      "DATABASE_RUNTIME_ROLE must differ from the DATABASE_URL user",
    );
  });

  it.each(["pg_monitor", "Idr", "1idr", "idr-runtime", "a".repeat(64), ""])("refuses the role name %j", (role) => {
    expect(errorOf(() => loadConfig({ ...BASE, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD, DATABASE_RUNTIME_ROLE: role }))).toContain("DATABASE_RUNTIME_ROLE");
  });

  it.each([
    ["too short", "a".repeat(31)],
    ["too long", "a".repeat(257)],
    ["a percent sign", `${"a".repeat(40)}%41`],
    ["a space", `${"a".repeat(40)} b`],
    ["non-ASCII", `${"a".repeat(40)}é`],
  ])("refuses a password with %s, without echoing it", (_label, pw) => {
    const msg = errorOf(() => loadConfig({ ...BASE, DATABASE_RUNTIME_PASSWORD: pw }));
    expect(msg).toContain("DATABASE_RUNTIME_PASSWORD");
    expect(msg).not.toContain(pw);
  });

  it("the password is a secret: scrubbed from the environment, absent from the logged view; the role name is shown", () => {
    expect(SECRET_KEYS).toContain("DATABASE_RUNTIME_PASSWORD");
    const view = describeConfig(loadConfig({ ...BASE, DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD }));
    expect(view).not.toHaveProperty("DATABASE_RUNTIME_PASSWORD");
    expect(JSON.stringify(view)).not.toContain(TEST_RUNTIME_PASSWORD);
    expect(view["DATABASE_RUNTIME_ROLE"]).toBe("idr_runtime");
  });
});
