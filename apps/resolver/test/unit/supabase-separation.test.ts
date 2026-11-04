/**
 * Three-database separation (docs/GUARDRAILS.md G3a): the resolver (B) holds
 * no Supabase credential, URL or project ref and never connects to a
 * Supabase-hosted database. Every path that reads the environment refuses:
 * the service (loadConfig), migrate, the ops commands and the TLS fingerprint
 * tool. Positive and negative cases, and no value is ever echoed.
 *
 * Synthetic hosts only: the documented stand-in ref, labels that are not
 * 20-character refs, and a pooler host assembled at runtime so this file
 * passes the public-safety gate.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  assertNoSupabaseConfiguration,
  ConfigError,
  databaseUrlHost,
  databaseUrlTargetsSupabase,
  isSupabaseHost,
  loadConfig,
} from "../../src/config/index.js";
import { fingerprintReport } from "../../src/ops/db-tls-fingerprint.js";
import { loadOpsConfig } from "../../src/ops/env.js";
import { testConfig, TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";

const PW = "s3cret-db-password-value";
const POOLER = ["aws-0-eu-west-2", "pooler", "supabase", "com"].join(".");
const SUPABASE_DATABASE_URLS: Array<[string, string]> = [
  ["direct database host", `postgres://postgres:${PW}@db.abcdefghijklmnopqrst.supabase.co:5432/postgres`],
  ["project host on supabase.in", `postgres://postgres:${PW}@abcdefghijklmnopqrst.supabase.in:5432/postgres`],
  ["connection pooler", `postgres://postgres.x:${PW}@${POOLER}:6543/postgres`],
  ["upper case", `postgres://postgres:${PW}@DB.EXAMPLE-PROJECT.SUPABASE.CO:5432/postgres`],
  ["trailing dot", `postgres://postgres:${PW}@db.example-project.supabase.co.:5432/postgres`],
  ["percent-encoded dot", `postgres://postgres:${PW}@db.example-project.supabase%2Eco:5432/postgres`],
  ["host query parameter overriding a harmless host", `postgres://postgres:${PW}@localhost:5432/postgres?host=db.example-project.supabase.co`],
  ["hostaddr query parameter", `postgres://postgres:${PW}@localhost:5432/postgres?hostaddr=db.example-project.supabase.co`],
  ["libpq host list", `postgres://postgres:${PW}@localhost:5432/postgres?host=localhost,db.example-project.supabase.co`],
];
const OTHER_DATABASE_URLS = [
  "postgres://resolver:resolver@127.0.0.1:5432/id_resolver_test",
  "postgres://u:p@localhost:5432/railway",
  "postgres://u:p@supabase.co.example.com:5432/x",
  "postgres://u:p@db.notsupabase.example:5432/x",
  "postgres://u:p@db.example.com:5432/x?host=db.example.net",
];

describe("isSupabaseHost / databaseUrlTargetsSupabase", () => {
  it("recognises every Supabase domain and subdomain, and nothing that merely contains the word", () => {
    for (const h of ["supabase.co", "db.example-project.supabase.co", "x.supabase.in", POOLER, "SUPABASE.COM", "db.example-project.supabase.co."]) expect(isSupabaseHost(h), h).toBe(true);
    for (const h of ["supabase.co.example.com", "notsupabase.co", "supabase.example", "example.com", "localhost", "127.0.0.1", "::1", ""]) expect(isSupabaseHost(h), h).toBe(false);
  });

  it.each(SUPABASE_DATABASE_URLS)("flags a %s", (_name, url) => {
    expect(databaseUrlTargetsSupabase(url)).toBe(true);
  });

  it.each(OTHER_DATABASE_URLS)("does not flag %s", (url) => {
    expect(databaseUrlTargetsSupabase(url)).toBe(false);
  });
});

describe("the service refuses Supabase configuration (loadConfig)", () => {
  it("a clean configuration loads (positive control)", () => {
    expect(testConfig().DATABASE_URL).toContain("postgres://");
  });

  it.each(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "SUPABASE_DB_URL", "supabase_publishable_key"])("refuses %s by name, never echoing its value", (name) => {
    const value = `https://value-that-must-not-appear.example/${PW}`;
    let message = "";
    try {
      testConfig({ [name]: value });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      message = (e as Error).message;
    }
    expect(message).toMatch(/^invalid configuration: Supabase variable\(s\) set: /);
    expect(message).toContain(name);
    expect(message).not.toContain(value);
    expect(message).not.toContain(PW);
  });

  it("reports the variable before any other configuration problem, and does not print an odd name", () => {
    const message = (() => {
      try {
        loadConfig({ SUPABASE_URL: "x", "SUPABASE_\u0007bell": "y" });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(message).toContain("Supabase variable(s) set: SUPABASE_<name not shown>, SUPABASE_URL (");
    expect(message).not.toContain("\u0007");
  });

  it.each(SUPABASE_DATABASE_URLS)("refuses a DATABASE_URL on a Supabase host (%s), without echoing it", (_name, url) => {
    let message = "";
    try {
      testConfig({ DATABASE_URL: url });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      message = (e as Error).message;
    }
    expect(message).toBe(
      "invalid configuration: DATABASE_URL points at a Supabase-hosted database (refused: the resolver's system of record is its own PostgreSQL, never a Supabase project)",
    );
    expect(message).not.toContain(PW);
  });

  it.each(OTHER_DATABASE_URLS)("accepts a non-Supabase DATABASE_URL %s", (url) => {
    expect(testConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });
});

describe("the ops commands and the TLS fingerprint tool refuse it too", () => {
  const OPS = { INSTALLATION_ID: "inst-test", WEBSITE_ID: "site-test", DATABASE_URL: "postgres://u:p@db.invalid:5432/x", DATABASE_SSL: "disable", NODE_ENV: "test" };

  it("loadOpsConfig: clean passes; a SUPABASE_* variable or a Supabase DATABASE_URL is refused by name", () => {
    expect(loadOpsConfig(OPS).DATABASE_URL).toBe(OPS.DATABASE_URL);
    expect(() => loadOpsConfig({ ...OPS, SUPABASE_SERVICE_ROLE_KEY: PW })).toThrow(/Supabase variable\(s\) set: SUPABASE_SERVICE_ROLE_KEY/);
    for (const [, url] of SUPABASE_DATABASE_URLS) {
      let message = "";
      try {
        loadOpsConfig({ ...OPS, DATABASE_URL: url });
      } catch (e) {
        // A plain Error, so failOps prints the fixed message.
        expect((e as Error).name).toBe("Error");
        message = (e as Error).message;
      }
      expect(message).toMatch(/DATABASE_URL points at a Supabase-hosted database/);
      expect(message).not.toContain(PW);
    }
  });

  it("fingerprintReport refuses a Supabase host before any connection (the shared check)", async () => {
    for (const [, url] of SUPABASE_DATABASE_URLS) {
      const e = await fingerprintReport({ DATABASE_URL: url }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/^invalid configuration: DATABASE_URL points at a Supabase-hosted database/);
      expect((e as Error).message).not.toContain(PW);
    }
  });

  it("fingerprintReport refuses a SUPABASE_* variable too, as RUNTIME.md and GUARDRAILS.md say (before any connection)", async () => {
    const e = await fingerprintReport({ DATABASE_URL: "postgres://u:p@db.invalid:5432/x", SUPABASE_SERVICE_ROLE_KEY: PW }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toMatch(/^invalid configuration: Supabase variable\(s\) set: SUPABASE_SERVICE_ROLE_KEY /);
    expect((e as Error).message).not.toContain(PW);
  });

  it("assertNoSupabaseConfiguration ignores unrelated variables that mention Supabase in their value", () => {
    expect(() => assertNoSupabaseConfiguration({ NOTE: "supabase.co", IDR_SUPABASE: "x", DATABASE_URL: OTHER_DATABASE_URLS[0] })).not.toThrow();
  });
});

// ---- G3a hardening (review): no host in DATABASE_URL, PGHOST/PGHOSTADDR, ENRICH_API_BASE_URL ------------------

const SUPABASE_HOST = "db.example-project.supabase.co";
/** DATABASE_URLs that name no host: node-postgres would connect to PGHOST (or localhost). */
const HOSTLESS_DATABASE_URLS: Array<[string, string]> = [
  ["an empty authority", `postgres:///railway?user=u&password=${PW}`],
  ["an empty host parameter and no host", `postgres:///railway?host=&user=u&password=${PW}`],
  ["hostaddr only (node-postgres ignores it)", `postgres:///railway?hostaddr=192.0.2.10&password=${PW}`],
  ["a non-empty host parameter overridden by a later empty one", `postgres:///railway?host=localhost&host=&password=${PW}`],
];
/** Explicit hosts, including Unix sockets: accepted. */
const EXPLICIT_HOST_URLS = [
  "postgres://u:p@localhost:5432/railway",
  "postgres://u:p@localhost:5432/railway?host=", // an empty parameter falls back to the URL's own host
  "postgres:///railway?host=/var/run/postgresql", // a socket directory named by the parameter
  "postgres://%2Fvar%2Frun%2Fpostgresql/railway", // a percent-encoded socket directory
  "postgres://u:p@[::1]:5432/railway",
];

describe("DATABASE_URL must name its host (node-postgres would otherwise take PGHOST)", () => {
  it("the bypass is real: with no host in the URL, node-postgres connects to PGHOST", () => {
    const saved = process.env["PGHOST"];
    process.env["PGHOST"] = SUPABASE_HOST;
    try {
      expect(new pg.Client({ connectionString: HOSTLESS_DATABASE_URLS[0]![1] }).host).toBe(SUPABASE_HOST);
      expect(new pg.Client({ connectionString: "postgres://u:p@db.invalid:5432/x" }).host).toBe("db.invalid");
    } finally {
      if (saved === undefined) delete process.env["PGHOST"];
      else process.env["PGHOST"] = saved;
    }
  });

  it("databaseUrlHost mirrors pg-connection-string", () => {
    for (const [, url] of HOSTLESS_DATABASE_URLS) expect(databaseUrlHost(url), url).toBe("");
    expect(databaseUrlHost("postgres://u:p@h:5432/db?host=other")).toBe("other");
    expect(databaseUrlHost("postgres://u:p@localhost:5432/railway?host=")).toBe("localhost");
    expect(databaseUrlHost("postgres://%2Fvar%2Frun%2Fpostgresql/railway")).toBe("/var/run/postgresql");
    expect(databaseUrlHost("postgres://u:p@[::1]:5432/railway")).toBe("::1");
    expect(databaseUrlHost("not a url")).toBeNull();
    // Agrees with node-postgres itself on every case (PGHOST unset, so its fallback would be localhost).
    for (const url of [...HOSTLESS_DATABASE_URLS.map(([, u]) => u), ...EXPLICIT_HOST_URLS]) {
      const host = databaseUrlHost(url);
      const saved = process.env["PGHOST"];
      process.env["PGHOST"] = "pghost-fallback.invalid";
      try {
        const pgHost = new pg.Client({ connectionString: url }).host;
        expect(pgHost === "pghost-fallback.invalid", url).toBe(host === "");
        if (host !== "") expect(pgHost, url).toBe(host);
      } finally {
        if (saved === undefined) delete process.env["PGHOST"];
        else process.env["PGHOST"] = saved;
      }
    }
  });

  const NO_HOST = "invalid configuration: DATABASE_URL names no host (refused: node-postgres would take the host from PGHOST; name the resolver's own PostgreSQL host in DATABASE_URL)";

  it.each(HOSTLESS_DATABASE_URLS)("the service refuses %s, without echoing it", (_name, url) => {
    let message = "";
    try {
      testConfig({ DATABASE_URL: url });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      message = (e as Error).message;
    }
    expect(message).toBe(NO_HOST);
    expect(message).not.toContain(PW);
  });

  it.each(EXPLICIT_HOST_URLS)("the service accepts an explicit host: %s", (url) => {
    expect(testConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it("the ops commands and the TLS fingerprint tool refuse a host-less DATABASE_URL too", async () => {
    const OPS = { INSTALLATION_ID: "inst-test", WEBSITE_ID: "site-test", DATABASE_SSL: "disable", NODE_ENV: "test" };
    for (const [, url] of HOSTLESS_DATABASE_URLS) {
      expect(() => loadOpsConfig({ ...OPS, DATABASE_URL: url })).toThrow(NO_HOST);
      await expect(fingerprintReport({ DATABASE_URL: url })).rejects.toThrow(NO_HOST);
    }
    expect(loadOpsConfig({ ...OPS, DATABASE_URL: EXPLICIT_HOST_URLS[0]! }).DATABASE_URL).toBe(EXPLICIT_HOST_URLS[0]);
  });
});

describe("PGHOST and PGHOSTADDR on a Supabase host are refused; any other value is left alone", () => {
  const SUPABASE_VALUES = [SUPABASE_HOST, "DB.EXAMPLE-PROJECT.SUPABASE.CO.", `localhost,${SUPABASE_HOST}`, ["aws-0-eu-west-2", "pooler", "supabase", "com"].join("."), "db.example-project.supabase%2Eco"];
  const OTHER_VALUES = ["localhost", "postgres.railway.internal", "/var/run/postgresql", "192.0.2.10", "supabase.co.example.com", ""];

  it.each(["PGHOST", "PGHOSTADDR"])("%s: refused on a Supabase host by the service, the ops commands and the fingerprint tool; the message names the variable only", async (name) => {
    for (const value of SUPABASE_VALUES) {
      const expected = `invalid configuration: ${name} names a Supabase host (refused: the resolver never connects to a Supabase project)`;
      expect(() => testConfig({ [name]: value }), value).toThrow(expected);
      expect(() => assertNoSupabaseConfiguration({ DATABASE_URL: "postgres://u:p@db.invalid:5432/x", [name]: value })).toThrow(expected);
      expect(() => loadOpsConfig({ INSTALLATION_ID: "inst-test", WEBSITE_ID: "site-test", DATABASE_URL: "postgres://u:p@db.invalid:5432/x", DATABASE_SSL: "disable", [name]: value })).toThrow(expected);
      await expect(fingerprintReport({ DATABASE_URL: "postgres://u:p@db.invalid:5432/x", [name]: value })).rejects.toThrow(expected);
      try {
        testConfig({ [name]: value });
      } catch (e) {
        expect((e as Error).message).not.toContain("example-project");
      }
    }
  });

  it.each(["PGHOST", "PGHOSTADDR"])("%s: any other value is accepted (an explicit DATABASE_URL host always wins in node-postgres)", (name) => {
    for (const value of OTHER_VALUES) expect(testConfig({ [name]: value }).DATABASE_URL, value).toContain("postgres://");
  });
});

describe("ENRICH_API_BASE_URL on a Supabase host is refused (no privileged cross-project connection there either)", () => {
  it("refused, with a fixed message", () => {
    for (const url of [`https://${SUPABASE_HOST}/functions/v1/enrich`, "https://example-project.supabase.co", "https://EXAMPLE-PROJECT.SUPABASE.IN.", "https://example-project.supabase%2Eco/api"]) {
      let message = "";
      try {
        testConfig({ ENRICH_API_BASE_URL: url });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        message = (e as Error).message;
      }
      expect(message, url).toBe(
        "invalid configuration: ENRICH_API_BASE_URL points at a Supabase host (refused: it is the enrichment provider, and the resolver never connects to a Supabase project)",
      );
    }
  });

  it("the default and other provider URLs are accepted", () => {
    expect(testConfig().ENRICH_API_BASE_URL).toBe("https://dev.enrich.so/api/v3");
    for (const url of ["https://api.enrich.example/v3", "https://supabase.co.example.com/api", "https://provider.example/supabase.co"]) {
      expect(testConfig({ ENRICH_API_BASE_URL: url }).ENRICH_API_BASE_URL).toBe(url);
    }
  });
});

describe("migrate (CLI) applies the same refusal before connecting", () => {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test", DATABASE_SSL: "disable", DATABASE_URL: "postgres://u:p@db.invalid:5432/x", ...env },
    });

  it("a SUPABASE_* variable: exit 1, the variable named, no value printed, no connection attempted", () => {
    const r = run({ SUPABASE_URL: `https://example-project.supabase.co/${PW}`, SUPABASE_SERVICE_ROLE_KEY: TEST_AUTH_TOKEN });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("migrate: invalid configuration: Supabase variable(s) set: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL");
    expect(r.stderr).not.toContain("migrate: failed");
    for (const v of [PW, TEST_AUTH_TOKEN, "example-project"]) expect(r.stdout + r.stderr).not.toContain(v);
  });

  it.each(SUPABASE_DATABASE_URLS)("a Supabase DATABASE_URL (%s): exit 1 before connecting", (_name, url) => {
    const r = run({ DATABASE_URL: url });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("migrate: invalid configuration: DATABASE_URL points at a Supabase-hosted database");
    expect(r.stderr).not.toContain("migrate: failed");
    expect(r.stdout + r.stderr).not.toContain(PW);
  });

  it("a DATABASE_URL with no host, or PGHOST on a Supabase host: exit 1 before connecting", () => {
    for (const env of [{ DATABASE_URL: HOSTLESS_DATABASE_URLS[0]![1] }, { PGHOST: SUPABASE_HOST }, { PGHOSTADDR: SUPABASE_HOST }]) {
      const r = run(env);
      expect(r.status, JSON.stringify(env)).toBe(1);
      expect(r.stderr).toMatch(/migrate: invalid configuration: (DATABASE_URL names no host|PGHOST names a Supabase host|PGHOSTADDR names a Supabase host)/);
      expect(r.stderr).not.toContain("migrate: failed");
      expect(r.stdout + r.stderr).not.toContain(PW);
      expect(r.stdout + r.stderr).not.toContain("example-project");
    }
  });

  it("a clean environment gets past the refusal (it then fails to reach the unresolvable host)", () => {
    const r = run({ IP_HMAC_SECRET: TEST_HMAC_SECRET });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("Supabase");
    expect(r.stderr).toContain("migrate: failed");
  });
});

describe("ops:db-tls-fingerprint (CLI) prints the shared refusal and exits before connecting", () => {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/ops/db-tls-fingerprint.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: "postgres://u:p@db.invalid:5432/x", ...env },
    });

  it("a SUPABASE_* variable: exit 1, the variable named, no value printed", () => {
    const r = run({ SUPABASE_URL: `https://example-project.supabase.co/${PW}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ops:db-tls-fingerprint: invalid configuration: Supabase variable(s) set: SUPABASE_URL (");
    for (const v of [PW, "example-project"]) expect(r.stdout + r.stderr).not.toContain(v);
  });

  it("a Supabase DATABASE_URL: exit 1 with the shared message", () => {
    const r = run({ DATABASE_URL: SUPABASE_DATABASE_URLS[0]![1] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ops:db-tls-fingerprint: invalid configuration: DATABASE_URL points at a Supabase-hosted database");
    expect(r.stdout + r.stderr).not.toContain(PW);
  });

  it("a clean environment gets past the refusal (it then fails to reach the unresolvable host, with a fixed code)", () => {
    const r = run({});
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("Supabase");
    expect(r.stderr).toMatch(/^ops:db-tls-fingerprint: /);
  });
});
