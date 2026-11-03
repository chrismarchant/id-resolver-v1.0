/**
 * Database TLS configuration (Gate 5): pin and CA parsing, the production
 * policy shared by the service, migrate and the ops commands, the dev-only
 * override, and the node-postgres options each mode produces. The live
 * behaviour against a TLS endpoint is in test/integration/db-tls.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, configOverrides, describeConfig, loadConfig, loadDatabaseTls, resolveDatabaseTls } from "../../src/config/index.js";
import { stripSslMode, withCredentials } from "../../src/db/pool.js";
import { DbTlsError, parseCaCert, parseTlsPins, pgTlsOptions, PinnedTlsSocket } from "../../src/db/tls.js";
import { loadOpsConfig } from "../../src/ops/env.js";
import { targetOf } from "../../src/ops/db-tls-fingerprint.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { makeCertificate } from "../helpers/tls.js";

const PIN_A = "a".repeat(64);
const PIN_B = "0123456789abcdef".repeat(4);

const REQUIRED = {
  INSTALLATION_ID: "inst-test",
  WEBSITE_ID: "site-test",
  RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN,
  IP_HMAC_SECRET: TEST_HMAC_SECRET,
  DATABASE_URL: "postgres://user:pw@db.invalid:5432/resolver",
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

describe("DATABASE_TLS_PIN_SHA256 parsing", () => {
  it("accepts one or two fingerprints, hex or colon-separated, any case, and normalises to lowercase hex", () => {
    expect(parseTlsPins(PIN_A)).toEqual([PIN_A]);
    expect(parseTlsPins(` ${PIN_A.toUpperCase()} , ${PIN_B} `)).toEqual([PIN_A, PIN_B]);
    const colon = PIN_B.toUpperCase().match(/../g)!.join(":");
    expect(parseTlsPins(colon)).toEqual([PIN_B]);
  });

  it.each([
    ["empty", ""],
    ["too short", "ab".repeat(31)],
    ["not hex", "g".repeat(64)],
    ["three pins (only current and next)", `${PIN_A},${PIN_B},${"c".repeat(64)}`],
    ["duplicate", `${PIN_A},${PIN_A.toUpperCase()}`],
    ["sha1 length", "ab".repeat(20)],
  ])("refuses %s, naming the variable only", (_label, value) => {
    expect(() => parseTlsPins(value)).toThrow(/^DATABASE_TLS_PIN_SHA256/);
  });
});

describe("DATABASE_CA_CERT parsing", () => {
  const ca = makeCertificate({ cn: "root-ca", ca: true });

  it("accepts a PEM bundle, also pasted as one line with literal \\n", () => {
    expect(parseCaCert(ca.certPem)).toContain("BEGIN CERTIFICATE");
    const two = parseCaCert(`${ca.certPem}\n${makeCertificate({ cn: "other", ca: true }).certPem}`);
    expect(two.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(parseCaCert(ca.certPem.trim().replace(/\n/g, "\\n"))).toBe(parseCaCert(ca.certPem));
  });

  it("refuses key material, garbage and broken certificates without echoing the value", () => {
    const withKey = `${ca.certPem}\n${ca.keyPem}`;
    expect(() => parseCaCert(withKey)).toThrow("DATABASE_CA_CERT must contain certificates only (it contains key material)");
    expect(() => parseCaCert("hello")).toThrow("DATABASE_CA_CERT: no PEM certificate found");
    const broken = ca.certPem.replace(/\n[A-Za-z0-9+/]{10}/, "\n!!!!!!!!!!");
    expect(() => parseCaCert(broken)).toThrow("DATABASE_CA_CERT: a certificate could not be parsed");
  });
});

describe("production database TLS policy (service, migrate and ops share it)", () => {
  it("default is require; production refuses disable always", () => {
    expect(loadConfig(REQUIRED).DATABASE_SSL).toBe("require");
    expect(errorOf(() => loadConfig({ ...REQUIRED, DATABASE_SSL: "disable" }))).toContain("DATABASE_SSL=disable is refused when NODE_ENV=production");
    expect(errorOf(() => loadConfig({ ...REQUIRED, NODE_ENV: "production", DATABASE_SSL: "disable", ALLOW_UNVERIFIED_DATABASE_TLS: "true" }))).toContain(
      "DATABASE_SSL=disable is refused",
    );
  });

  it("production refuses no-verify unless ALLOW_UNVERIFIED_DATABASE_TLS=true; development and test allow both", () => {
    expect(errorOf(() => loadConfig({ ...REQUIRED, DATABASE_SSL: "no-verify" }))).toContain(
      "DATABASE_SSL=no-verify is refused when NODE_ENV=production unless ALLOW_UNVERIFIED_DATABASE_TLS=true",
    );
    expect(loadConfig({ ...REQUIRED, DATABASE_SSL: "no-verify", ALLOW_UNVERIFIED_DATABASE_TLS: "true" }).DATABASE_SSL).toBe("no-verify");
    for (const env of ["development", "test"]) {
      expect(loadConfig({ ...REQUIRED, NODE_ENV: env, DATABASE_SSL: "disable" }).DATABASE_SSL).toBe("disable");
      expect(loadConfig({ ...REQUIRED, NODE_ENV: env, DATABASE_SSL: "no-verify" }).DATABASE_SSL).toBe("no-verify");
    }
  });

  it("verify-pinned requires a pin; a pin or a CA with a mode that does not use it is refused (never silently ignored)", () => {
    expect(errorOf(() => loadConfig({ ...REQUIRED, DATABASE_SSL: "verify-pinned" }))).toContain("DATABASE_SSL=verify-pinned requires DATABASE_TLS_PIN_SHA256");
    expect(resolveDatabaseTls(loadConfig({ ...REQUIRED, DATABASE_SSL: "verify-pinned", DATABASE_TLS_PIN_SHA256: `${PIN_A},${PIN_B}` }))).toEqual({
      mode: "verify-pinned",
      pins: [PIN_A, PIN_B],
    });
    expect(errorOf(() => loadConfig({ ...REQUIRED, DATABASE_TLS_PIN_SHA256: PIN_A }))).toContain("DATABASE_TLS_PIN_SHA256 is only used with DATABASE_SSL=verify-pinned");
    const ca = makeCertificate({ cn: "root-ca", ca: true }).certPem;
    expect(errorOf(() => loadConfig({ ...REQUIRED, NODE_ENV: "development", DATABASE_SSL: "no-verify", DATABASE_CA_CERT: ca }))).toContain(
      "DATABASE_CA_CERT is only used with DATABASE_SSL=require or verify-pinned",
    );
    expect(resolveDatabaseTls(loadConfig({ ...REQUIRED, DATABASE_CA_CERT: ca })).caCert).toContain("BEGIN CERTIFICATE");
  });

  it("error messages name variables, never the pin, the CA or the URL", () => {
    const secretPin = "f00d".repeat(15);
    const msg = errorOf(() => loadConfig({ ...REQUIRED, DATABASE_SSL: "verify-pinned", DATABASE_TLS_PIN_SHA256: secretPin }));
    expect(msg).toContain("DATABASE_TLS_PIN_SHA256");
    expect(msg).not.toContain(secretPin);
    expect(msg).not.toContain("db.invalid");
    const caMsg = errorOf(() => loadConfig({ ...REQUIRED, DATABASE_CA_CERT: "not-a-cert-zzz" }));
    expect(caMsg).not.toContain("not-a-cert-zzz");
  });

  it("the CA bundle is not part of the logged configuration view", () => {
    const ca = makeCertificate({ cn: "root-ca", ca: true }).certPem;
    const view = describeConfig(loadConfig({ ...REQUIRED, DATABASE_CA_CERT: ca }));
    expect(JSON.stringify(view)).not.toContain("BEGIN CERTIFICATE");
    expect(view).not.toHaveProperty("DATABASE_CA_CERT");
  });

  it("overrides are reported by name as active or inert", () => {
    expect(configOverrides(loadConfig(REQUIRED))).toEqual([]);
    expect(configOverrides(loadConfig({ ...REQUIRED, DATABASE_SSL: "no-verify", ALLOW_UNVERIFIED_DATABASE_TLS: "true" }))).toEqual([
      { variable: "ALLOW_UNVERIFIED_DATABASE_TLS", state: "active" },
    ]);
    expect(configOverrides(loadConfig({ ...REQUIRED, ALLOW_UNVERIFIED_DATABASE_TLS: "true" }))).toEqual([{ variable: "ALLOW_UNVERIFIED_DATABASE_TLS", state: "inert" }]);
    expect(configOverrides(loadConfig({ ...REQUIRED, PROVIDER_MODE: "mock", ALLOW_MOCK_PROVIDER: "true" }))).toEqual([{ variable: "ALLOW_MOCK_PROVIDER", state: "active" }]);
  });

  it("the CLIs get the same policy (NODE_ENV defaults to production there too) and a warning line per override", () => {
    expect(() => loadDatabaseTls({ DATABASE_SSL: "disable" })).toThrow(/DATABASE_SSL=disable is refused/);
    expect(() => loadDatabaseTls({ DATABASE_SSL: "no-verify" })).toThrow(/ALLOW_UNVERIFIED_DATABASE_TLS/);
    expect(loadDatabaseTls({ DATABASE_SSL: "no-verify", ALLOW_UNVERIFIED_DATABASE_TLS: "true" }).warnings).toEqual([
      "warning: override ALLOW_UNVERIFIED_DATABASE_TLS is active: the database certificate is not verified (development deployment only)",
    ]);
    expect(loadDatabaseTls({ ALLOW_UNVERIFIED_DATABASE_TLS: "true" }).warnings[0]).toContain("set but has no effect");
    expect(loadDatabaseTls({ NODE_ENV: "development", DATABASE_SSL: "disable" }).tls).toEqual({ mode: "disable" });
    const ops = loadOpsConfig({ INSTALLATION_ID: "i", WEBSITE_ID: "w", DATABASE_URL: "postgres://u:p@db.invalid/x", DATABASE_SSL: "verify-pinned", DATABASE_TLS_PIN_SHA256: PIN_A });
    expect(ops.DATABASE_TLS).toEqual({ mode: "verify-pinned", pins: [PIN_A] });
    expect(() => loadOpsConfig({ INSTALLATION_ID: "i", WEBSITE_ID: "w", DATABASE_URL: "postgres://u:p@db.invalid/x", DATABASE_SSL: "disable" })).toThrow(/refused/);
  });
});

describe("node-postgres options per mode", () => {
  it("disable/no-verify/require use node-postgres TLS; verify-pinned turns it off and supplies the pinned socket", () => {
    expect(pgTlsOptions("disable")).toEqual({ ssl: false });
    expect(pgTlsOptions("no-verify")).toEqual({ ssl: { rejectUnauthorized: false } });
    expect(pgTlsOptions("require")).toEqual({ ssl: { rejectUnauthorized: true } });
    expect(pgTlsOptions({ mode: "require", caCert: "PEM" })).toEqual({ ssl: { rejectUnauthorized: true, ca: "PEM" } });
    const pinned = pgTlsOptions({ mode: "verify-pinned", pins: [PIN_A] });
    expect(pinned.ssl).toBe(false);
    expect(pinned.stream?.()).toBeInstanceOf(PinnedTlsSocket);
    expect(() => pgTlsOptions({ mode: "verify-pinned", pins: [] })).toThrow(DbTlsError);
    expect(() => pgTlsOptions({ mode: "verify-pinned", pins: [PIN_A, PIN_B, "c".repeat(64)] })).toThrow(DbTlsError);
  });

  it("strips every TLS parameter from the connection string and keeps the others", () => {
    const url = "postgres://u:p@db.invalid:5432/x?ssl=0&sslmode=disable&SSLROOTCERT=/etc/x&sslcert=a&sslkey=b&sslnegotiation=direct&uselibpqcompat=true&application_name=keep&options=-c%20x%3Dy";
    const out = new URL(stripSslMode(url));
    expect([...out.searchParams.keys()].sort()).toEqual(["application_name", "options"]);
    expect(stripSslMode("not a url")).toBe("not a url");
  });

  it("withCredentials replaces user and password reversibly and keeps host, port and database", () => {
    const pw = "Ab0!#$&'()*+,/:;=?@[]^_`{|}~-.\"<>\\";
    const out = new URL(withCredentials("postgres://owner:ownerpw@db.invalid:6543/app?x=1", { user: "idr_runtime", password: pw }));
    expect(decodeURIComponent(out.username)).toBe("idr_runtime");
    expect(decodeURIComponent(out.password)).toBe(pw);
    expect(out.host).toBe("db.invalid:6543");
    expect(out.pathname).toBe("/app");
    expect(() => withCredentials("nope", { user: "a", password: "b" })).toThrow(/INVALID_URL/);
  });

  it("the fingerprint helper targets only host and port, and fails with a fixed message on a bad URL", () => {
    expect(targetOf("postgres://u:p@db.invalid/x")).toEqual({ host: "db.invalid", port: 5432 });
    expect(targetOf("postgres://u:p@[::1]:6000/x")).toEqual({ host: "::1", port: 6000 });
    expect(() => targetOf("::nope::")).toThrow("DATABASE_URL is not a valid URL");
  });
});
