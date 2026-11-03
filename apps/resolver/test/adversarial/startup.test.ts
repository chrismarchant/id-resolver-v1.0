/**
 * Startup refusals of the real service process (src/main.ts), from the
 * outside: pending migrations (migrations never run on start), the mock
 * provider in production, the required retention window (D3) and removed
 * pre-CHR-70 variables. Every refusal exits non-zero before listening, names
 * the problem, and never prints a secret or the database URL.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase, createTestDb, getTestDatabaseUrl } from "../helpers/db.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import type { Db } from "../../src/db/index.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

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
    DATABASE_URL: getTestDatabaseUrl(),
    DATABASE_SSL: "disable",
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
  for (const needle of [TEST_AUTH_TOKEN, TEST_HMAC_SECRET, databaseUrl, "resolver:resolver"]) expect(output).not.toContain(needle);
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
    const r = await runService(baseEnv({ DATABASE_URL: scratch.url }));
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

  it("starts on a current database and stops cleanly", async () => {
    const r = await runService(baseEnv(), { stopAfterStart: true });
    expect(r.started, r.output).toBe(true);
    expect(r.code).toBe(0);
    expect(r.output).toContain('"event":"migration_check"');
    expectNoSecrets(r.output, getTestDatabaseUrl());
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
