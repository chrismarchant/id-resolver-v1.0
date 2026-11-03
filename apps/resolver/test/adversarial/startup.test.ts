/**
 * Startup refusals of the real service process (src/main.ts), from the
 * outside: pending migrations (migrations never run on start), the mock
 * provider in production, the required retention window (D3), removed
 * pre-CHR-70 variables, the production database TLS policy and the
 * separate runtime role (Gate 5).
 * Every refusal exits non-zero before listening, names the problem, and
 * never prints a secret or the database URL.
 *
 * The service runs in its production posture: NODE_ENV=production with
 * verified (pinned) TLS through a runtime-generated TLS terminator in front
 * of the test database, logged in as the least-privilege runtime role
 * (production refuses plaintext, unverified TLS and the owner login).
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase, createTestDb, getTestDatabaseUrl } from "../helpers/db.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { startProductionDb } from "../helpers/prod-db.js";
import { makeCertificate } from "../helpers/tls.js";
import { TEST_RUNTIME_PASSWORD, TEST_RUNTIME_ROLE } from "../helpers/runtime-role.js";
import { createPool } from "../../src/db/pool.js";
import type { Db } from "../../src/db/index.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const prodDb = await startProductionDb();
await prodDb.provision();
afterAll(() => prodDb.close());

function baseEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    PORT: String(19000 + Math.floor(Math.random() * 1000)),
    HOST: "127.0.0.1",
    INSTALLATION_ID: "inst-test",
    WEBSITE_ID: "site-test",
    RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN,
    IP_HMAC_SECRET: TEST_HMAC_SECRET,
    ...prodDb.env(),
    PROVIDER_MODE: "disabled",
    OBSERVATION_RETENTION_DAYS: "30",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Starts the service; resolves when it exits, or (stopAfterStart) once it has started and been sent SIGTERM. */
function runService(env: NodeJS.ProcessEnv, opts: { stopAfterStart?: boolean } = {}): Promise<{ code: number | null; output: string; started: boolean }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "src", "main.ts")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let started = false;
    const onData = (d: Buffer) => {
      output += d.toString();
      if (!started && output.includes('"server_started"')) {
        started = true;
        if (opts.stopAfterStart) child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      done({ code, output, started });
    });
  });
}

function expectNoSecrets(output: string, databaseUrl: string) {
  for (const needle of [TEST_AUTH_TOKEN, TEST_HMAC_SECRET, TEST_RUNTIME_PASSWORD, databaseUrl, prodDb.url(), "resolver:resolver", "127.0.0.1:"]) expect(output).not.toContain(needle);
}

describe("service startup refusals", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  let db: Db;
  beforeAll(async () => {
    scratch = await createScratchDatabase();
    db = await createTestDb(); // the shared test database, fully migrated
  });
  afterAll(async () => {
    await db.close();
    await scratch.drop();
  });

  it("refuses to start while the database has pending migrations, naming them, and creates nothing", async () => {
    const r = await runService(baseEnv({ DATABASE_URL: prodDb.url(scratch.url) }));
    expect(r.code, r.output).toBe(1);
    expect(r.started).toBe(false);
    expect(r.output).toContain("pending migration(s): 0001_initial.sql");
    expect(r.output).toContain("node dist/db/migrate.js");
    expectNoSecrets(r.output, scratch.url);
    const { createPool } = await import("../../src/db/pool.js");
    const p = createPool({ databaseUrl: scratch.url, ssl: "disable", max: 1 });
    try {
      expect((await p.query("SELECT to_regclass('public.schema_migrations')::text AS t")).rows[0].t).toBeNull();
    } finally {
      await p.end();
    }
  });

  it("starts on a current database over pinned TLS and stops cleanly", async () => {
    const r = await runService(baseEnv(), { stopAfterStart: true });
    expect(r.started, r.output).toBe(true);
    expect(r.code).toBe(0);
    expect(r.output).toContain('"event":"migration_check"');
    expect(r.output).toContain('"tls_mode":"verify-pinned"');
    expect(r.output).toContain('"db_role":"runtime"');
    expect(r.output).toContain('"event":"database_role_check"');
    expect(r.output).toContain('"outcome":"least_privilege"');
    expect(r.output).not.toContain('"event":"config_override"');
    expectNoSecrets(r.output, getTestDatabaseUrl());
  });

  it("production refuses to run as the owner (no DATABASE_RUNTIME_PASSWORD) unless ALLOW_OWNER_DATABASE_ROLE=true, and then warns by name", async () => {
    const env = { DATABASE_RUNTIME_PASSWORD: undefined, DATABASE_RUNTIME_ROLE: undefined };
    const refused = await runService(baseEnv(env));
    expect(refused.code).toBe(1);
    expect(refused.started).toBe(false);
    expect(refused.output).toContain("NODE_ENV=production requires the separate runtime database role: set DATABASE_RUNTIME_PASSWORD");
    const allowed = await runService(baseEnv({ ...env, ALLOW_OWNER_DATABASE_ROLE: "true" }), { stopAfterStart: true });
    expect(allowed.started, allowed.output).toBe(true);
    expect(allowed.output).toContain('"db_role":"owner"');
    const override = allowed.output.split("\n").find((l) => l.includes('"event":"config_override"'));
    expect(JSON.parse(override!)).toMatchObject({ level: "warn", variable: "ALLOW_OWNER_DATABASE_ROLE", outcome: "active" });
    expectNoSecrets(refused.output + allowed.output, getTestDatabaseUrl());
  });

  it("refuses to start when the runtime login is not least-privilege, naming what is wrong", async () => {
    const role = "idr_test_createdb";
    const owner = createPool({ databaseUrl: getTestDatabaseUrl(), ssl: "disable", max: 1 });
    try {
      await owner.query(`DROP ROLE IF EXISTS ${role}`);
      await owner.query(`CREATE ROLE ${role} LOGIN CREATEDB PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
      const r = await runService(baseEnv({ DATABASE_RUNTIME_ROLE: role }));
      expect(r.code).toBe(1);
      expect(r.started).toBe(false);
      expect(r.output).toContain("the runtime database role is not least-privilege (createdb)");
      expectNoSecrets(r.output, getTestDatabaseUrl());
    } finally {
      await owner.query(`DROP ROLE IF EXISTS ${role}`);
      await owner.end();
    }
  });

  it("a wrong runtime password fails with a hint naming the variables, never the value", async () => {
    const wrong = "f".repeat(40);
    const r = await runService(baseEnv({ DATABASE_RUNTIME_PASSWORD: wrong }));
    expect(r.code).toBe(1);
    expect(r.output).toContain("database authentication failed (28P01)");
    expect(r.output).toContain("DATABASE_RUNTIME_PASSWORD");
    expect(r.output).not.toContain(wrong);
    expect(r.output).not.toContain(TEST_RUNTIME_ROLE + ":");
    expectNoSecrets(r.output, getTestDatabaseUrl());
  });

  it("production refuses DATABASE_SSL=disable, even with the override", async () => {
    for (const over of [{}, { ALLOW_UNVERIFIED_DATABASE_TLS: "true" }]) {
      const r = await runService(baseEnv({ DATABASE_URL: getTestDatabaseUrl(), DATABASE_SSL: "disable", DATABASE_TLS_PIN_SHA256: undefined, ...over }));
      expect(r.code).toBe(1);
      expect(r.started).toBe(false);
      expect(r.output).toContain("DATABASE_SSL=disable is refused when NODE_ENV=production");
      expectNoSecrets(r.output, getTestDatabaseUrl());
    }
  });

  it("production refuses DATABASE_SSL=no-verify unless ALLOW_UNVERIFIED_DATABASE_TLS=true, and then warns by name on every start", async () => {
    const env = { DATABASE_SSL: "no-verify", DATABASE_TLS_PIN_SHA256: undefined };
    const refused = await runService(baseEnv(env));
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("DATABASE_SSL=no-verify is refused when NODE_ENV=production unless ALLOW_UNVERIFIED_DATABASE_TLS=true");
    const allowed = await runService(baseEnv({ ...env, ALLOW_UNVERIFIED_DATABASE_TLS: "true" }), { stopAfterStart: true });
    expect(allowed.started, allowed.output).toBe(true);
    expect(allowed.code).toBe(0);
    const override = allowed.output.split("\n").find((l) => l.includes('"event":"config_override"'));
    expect(override).toBeDefined();
    expect(JSON.parse(override!)).toMatchObject({ level: "warn", variable: "ALLOW_UNVERIFIED_DATABASE_TLS", outcome: "active" });
    expectNoSecrets(refused.output + allowed.output, getTestDatabaseUrl());
  });

  it("refuses to start when the server's certificate is not pinned, naming the variables and never a value", async () => {
    const wrongPin = makeCertificate({ cn: "localhost" }).sha256;
    const r = await runService(baseEnv({ DATABASE_TLS_PIN_SHA256: wrongPin }));
    expect(r.code).toBe(1);
    expect(r.started).toBe(false);
    expect(r.output).toContain("database TLS verification failed (DB_TLS_PIN_MISMATCH): check DATABASE_SSL, DATABASE_TLS_PIN_SHA256 and DATABASE_CA_CERT");
    expect(r.output).not.toContain(wrongPin);
    expect(r.output).not.toContain(prodDb.cert.sha256);
    expectNoSecrets(r.output, getTestDatabaseUrl());
    // During a rotation window both pins are accepted.
    const rotation = await runService(baseEnv({ DATABASE_TLS_PIN_SHA256: `${wrongPin},${prodDb.cert.sha256}` }), { stopAfterStart: true });
    expect(rotation.started, rotation.output).toBe(true);
  });

  it("refuses PROVIDER_MODE=mock in production unless ALLOW_MOCK_PROVIDER=true", async () => {
    const refused = await runService(baseEnv({ PROVIDER_MODE: "mock" }));
    expect(refused.code).toBe(1);
    expect(refused.started).toBe(false);
    expect(refused.output).toContain("PROVIDER_MODE=mock is refused when NODE_ENV=production unless ALLOW_MOCK_PROVIDER=true");
    const allowed = await runService(baseEnv({ PROVIDER_MODE: "mock", ALLOW_MOCK_PROVIDER: "true" }), { stopAfterStart: true });
    expect(allowed.started, allowed.output).toBe(true);
    expect(allowed.code).toBe(0);
  });

  it("refuses to start without OBSERVATION_RETENTION_DAYS (no default, D3)", async () => {
    const r = await runService(baseEnv({ OBSERVATION_RETENTION_DAYS: undefined }));
    expect(r.code).toBe(1);
    expect(r.output).toContain("OBSERVATION_RETENTION_DAYS: required");
    expectNoSecrets(r.output, getTestDatabaseUrl());
  });

  it("refuses a removed pre-CHR-70 variable instead of ignoring it", async () => {
    const r = await runService(baseEnv({ MAX_CONCURRENT_CHILDREN: "2" }));
    expect(r.code).toBe(1);
    expect(r.output).toContain("MAX_CONCURRENT_CHILDREN (use MAX_CONCURRENT_JOBS");
  });
});
