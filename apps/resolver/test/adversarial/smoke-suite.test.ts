/**
 * CHR-72: the real smoke entry point (src/ops/smoke.ts) against the real
 * service process (src/main.ts) on loopback, with the development-like
 * environment (mock provider, ALLOW_MOCK_PROVIDER, NODE_ENV=production) and
 * the test database, in both documentation-range modes:
 *
 *   - enabled, kill switch released: every check passes, the switch is
 *     engaged only for the probe and is released again (exit 0);
 *   - enabled, kill switch engaged before the run: never written, still
 *     probed, left engaged with the operator's reason (exit 0);
 *   - a restore the database refuses: exit 2, loud secret-free message, the
 *     switch is left engaged (and the test releases it);
 *   - SIGTERM while the switch is held: deferred, the restore runs, exit 2;
 *   - a target that ignores the switch: the disabled check fails (exit 1);
 *   - the smoke's environment says disabled but the target runs enabled: the
 *     ineligible check fails (exit 1), nothing is skipped silently;
 *   - disabled: documentation addresses answer ineligible, exactly the checks
 *     that need an eligible documentation address are skipped, the switch is
 *     not touched (exit 0).
 * Tokens and the HMAC secret are random per run; every smoke output is
 * scanned for them, for the database URL, the target URL and the addresses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { SMOKE_ENGAGE_REASON_PREFIX, SMOKE_RESTORE_REASON_PREFIX } from "../../src/ops/smoke-kill-switch.js";
import { KILL_SWITCH_PROBE_PREFIX } from "../../src/ops/smoke-mode.js";
import { createTestDb, getTestDatabaseUrl, resetTestDb } from "../helpers/db.js";
import { startProductionDb } from "../helpers/prod-db.js";
import { TEST_RUNTIME_PASSWORD } from "../helpers/runtime-role.js";

// Production posture for the service and the smoke runner: verified (pinned) TLS through the test terminator.
const prodDb = await startProductionDb();
await prodDb.provision();
afterAll(() => prodDb.close());

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const INSTALLATION = "inst-test";
const WEBSITE_TOKEN = randomBytes(24).toString("hex");
const REPORTING_TOKEN = randomBytes(24).toString("hex");
const HMAC_SECRET = randomBytes(32).toString("hex");
const SKIPPED_DOCS = "skipped: documentation ranges disabled";

const KS_CHECKS = [
  "kill switch: prior state read",
  "kill switch: engaged for the probe (read back)",
  "kill switch engaged: uncached address -> disabled, nothing recorded",
  "kill switch: restored to its prior state (read back)",
  "after restore: cache-hit entrance qualifies, recorded",
  "after restore: uncached address reaches the provider again (no_match)",
];

interface SmokeRun {
  code: number | null;
  checks: { check: string; pass: boolean; detail: string }[];
  summary: Record<string, unknown> | undefined;
  stdout: string;
  stderr: string;
}

function serviceEnv(port: number, documentationRanges: "true" | "false"): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    PORT: String(port),
    HOST: "127.0.0.1",
    INSTALLATION_ID: INSTALLATION,
    WEBSITE_ID: "site-test",
    RESOLVER_AUTH_TOKEN: WEBSITE_TOKEN,
    REPORTING_AUTH_TOKEN: REPORTING_TOKEN,
    IP_HMAC_SECRET: HMAC_SECRET,
    ...prodDb.env(),
    PROVIDER_MODE: "mock",
    ALLOW_MOCK_PROVIDER: "true",
    ALLOW_DOCUMENTATION_RANGES: documentationRanges,
    OBSERVATION_RETENTION_DAYS: "30",
  };
}

async function startService(env: Record<string, string>): Promise<{ proc: ChildProcess; output: () => string }> {
  let output = "";
  let exited = false;
  const proc = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "src/main.ts")], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d: Buffer) => (output += d.toString()));
  proc.stderr!.on("data", (d: Buffer) => (output += d.toString()));
  proc.on("exit", () => (exited = true));
  const deadline = Date.now() + 20_000;
  while (!output.includes("server_started") && !exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  expect(output, output.slice(-2000)).toContain("server_started");
  return { proc, output: () => output };
}

function runSmoke(env: Record<string, string>, onChild?: (child: ChildProcess) => void): Promise<SmokeRun> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "src/ops/smoke.ts")], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    onChild?.(child);
    child.on("close", (code) => {
      const lines = stdout
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      done({
        code,
        checks: lines.filter((l) => l["event"] === "smoke_check").map((l) => ({ check: String(l["check"]), pass: l["pass"] === true, detail: String(l["detail"]) })),
        summary: lines.find((l) => l["event"] === "smoke_summary"),
        stdout,
        stderr,
      });
    });
  });
}

/** Nothing secret, no configuration value and no address in anything the smoke writes. */
function expectSecretFree(r: SmokeRun, base: string): void {
  const out = `${r.stdout}${r.stderr}`;
  for (const needle of [WEBSITE_TOKEN, REPORTING_TOKEN, HMAC_SECRET, getTestDatabaseUrl(), prodDb.url(), prodDb.cert.sha256, TEST_RUNTIME_PASSWORD, base, "203.0.113.", "2001:db8", "10.0.0.1", "127.0.0.1", "postgres://"]) {
    expect(out.includes(needle), "smoke output leaked a value").toBe(false);
  }
  // JSON lines only on stdout.
  for (const line of r.stdout.split("\n").filter((l) => l.length > 0)) expect(() => JSON.parse(line)).not.toThrow();
}

const check = (r: SmokeRun, name: string) => r.checks.find((c) => c.check === name);

/**
 * A loopback relay in front of the service. For the kill-switch probe entrance
 * (recognised by its documentation prefix) `onProbe` runs first: it may delay,
 * and may return a body to answer with instead of forwarding.
 */
async function startRelay(upstream: string, onProbe: () => Promise<string | undefined>): Promise<{ base: string; close: () => Promise<void> }> {
  const relay: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      void (async () => {
        if (body.includes(KILL_SWITCH_PROBE_PREFIX)) {
          const answer = await onProbe();
          if (answer !== undefined) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(answer);
            return;
          }
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length" && k !== "connection") headers[k] = v;
        const r = await fetch(`${upstream}${req.url ?? "/"}`, { method: req.method ?? "GET", headers, ...(body.length > 0 ? { body } : {}), redirect: "manual" });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(await r.text());
      })().catch(() => {
        res.writeHead(502);
        res.end();
      });
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  const port = (relay.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => relay.close(() => r())) };
}

describe("smoke suite against the real service: documentation ranges enabled", () => {
  const port = 19_000 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const env = serviceEnv(port, "true");
  const smokeEnv = { ...env, SMOKE_BASE_URL: base };
  let service: { proc: ChildProcess; output: () => string };
  let db: Db;
  const controlRows = async () =>
    (await db.pool.query<{ enrichment_enabled: boolean; reason: string; updated_at: Date }>("SELECT enrichment_enabled, reason, updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows;

  beforeAll(async () => {
    db = await createTestDb();
    await resetTestDb(db);
    service = await startService(env);
  });
  afterAll(async () => {
    service?.proc.kill("SIGKILL");
    await db.close();
  });

  it("switch released before the run: every check passes, the switch is engaged only for the probe and released again (exit 0)", async () => {
    expect(await controlRows()).toEqual([]);
    const r = await runSmoke(smokeEnv);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    // 26 at Gate 4, plus (Gate 5) the orphan check, the feed shape check and the two events-disabled checks.
    expect(r.checks).toHaveLength(30);
    expect(r.summary).toMatchObject({ target: "loopback", mode: "documentation_ranges_enabled", kill_switch_phase: "run", kill_switch_prior: "released", kill_switch_restore: "restored", checks: 30, passed: 29, failed: 0, skipped: 1 });
    for (const name of KS_CHECKS) expect(check(r, name)?.pass, name).toBe(true);
    expect(check(r, KS_CHECKS[2]!)?.detail).toBe("status 200 result disabled/none/recorded=false");
    expect(check(r, KS_CHECKS[3]!)?.detail).toBe("restore restored, reads released");
    expect(check(r, KS_CHECKS[4]!)?.detail).toBe("status 200 result qualified/cache/recorded=true");
    expect(check(r, KS_CHECKS[5]!)?.detail).toBe("status 200 result no_match/provider/recorded=false");
    expect(r.checks.filter((c) => c.detail.startsWith("skipped")).map((c) => c.check)).toEqual(["public edge checks"]);
    const rows = await controlRows();
    expect(rows.map(({ enrichment_enabled, reason }) => ({ enrichment_enabled, reason }))).toEqual([{ enrichment_enabled: true, reason: `${SMOKE_RESTORE_REASON_PREFIX} [run ${String(r.summary?.["run"])}]` }]);
    // The service logged the kill-switch outcome for the probe.
    expect(service.output()).toContain('"reason":"kill_switch"');
    expectSecretFree(r, base);
  });

  it("switch engaged before the run: never written, still probed and left engaged; every check passes on a warm cache (exit 0)", async () => {
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: budget spike");
    const before = await controlRows();
    try {
      const r = await runSmoke(smokeEnv);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.checks.filter((c) => !c.pass)).toEqual([]);
      expect(r.summary).toMatchObject({ mode: "documentation_ranges_enabled", kill_switch_phase: "run", kill_switch_prior: "engaged", kill_switch_restore: "left_engaged_as_found", failed: 0 });
      expect(check(r, KS_CHECKS[1]!)?.detail).toBe("already_engaged");
      expect(check(r, KS_CHECKS[2]!)?.detail).toBe("status 200 result disabled/none/recorded=false");
      expect(check(r, KS_CHECKS[3]!)?.detail).toBe("restore left_engaged_as_found, reads engaged");
      expect(check(r, KS_CHECKS[5]!)?.detail).toBe("skipped: kill switch was engaged before the run (left engaged)");
      // Not written at all: same value, same reason, same timestamp.
      expect(await controlRows()).toEqual(before);
      expectSecretFree(r, base);
    } finally {
      await db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released");
    }
  });

  it("a restore the database refuses: exit 2 with a loud secret-free message; the switch is left engaged, not silently", async () => {
    await db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released");
    expect(SMOKE_RESTORE_REASON_PREFIX).not.toMatch(/['%_]/);
    await db.pool.query(`CREATE OR REPLACE FUNCTION g4a_smoke_block_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF starts_with(NEW.reason, '${SMOKE_RESTORE_REASON_PREFIX}') THEN RAISE EXCEPTION 'restore blocked by test'; END IF;
        RETURN NEW;
      END $$`);
    await db.pool.query("CREATE TRIGGER g4a_smoke_block_restore BEFORE INSERT OR UPDATE ON deployment_controls FOR EACH ROW EXECUTE FUNCTION g4a_smoke_block_restore()");
    try {
      const r = await runSmoke(smokeEnv);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.summary).toMatchObject({ kill_switch_prior: "released", kill_switch_restore: "failed" });
      expect(check(r, KS_CHECKS[2]!)?.pass).toBe(true);
      expect(check(r, KS_CHECKS[3]!)).toEqual({ check: KS_CHECKS[3], pass: false, detail: "restore failed, reads engaged" });
      expect(r.stderr).toContain("KILL SWITCH RESTORE FAILED");
      expect(r.stderr).toContain("node dist/ops/kill-switch.js off");
      // Printed right after the phase and again as the very last line.
      expect(r.stderr.trim().split("\n").at(-1)).toContain("KILL SWITCH RESTORE FAILED");
      expect((await controlRows()).map(({ enrichment_enabled, reason }) => ({ enrichment_enabled, reason }))).toEqual([{ enrichment_enabled: false, reason: `${SMOKE_ENGAGE_REASON_PREFIX} [run ${String(r.summary?.["run"])}]` }]);
      expectSecretFree(r, base);
    } finally {
      await db.pool.query("DROP TRIGGER IF EXISTS g4a_smoke_block_restore ON deployment_controls");
      await db.pool.query("DROP FUNCTION IF EXISTS g4a_smoke_block_restore()");
      await db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released after simulated restore failure");
    }
    expect(await db.controls.isEnrichmentEnabled(INSTALLATION)).toBe(true);
  });

  it("SIGTERM while the switch is held is deferred: the restore runs first, then exit 2", async () => {
    // The relay holds the probe entrance for a moment, so the signal lands while the switch is engaged.
    let probeSeen!: () => void;
    const seen = new Promise<void>((r) => (probeSeen = r));
    const relay = await startRelay(base, async () => {
      probeSeen();
      await new Promise((r) => setTimeout(r, 1_500));
      return undefined;
    });
    try {
      let child: ChildProcess | undefined;
      const running = runSmoke({ ...smokeEnv, SMOKE_BASE_URL: relay.base }, (c) => (child = c));
      await seen;
      child!.kill("SIGTERM");
      const r = await running;
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain("interrupted by SIGTERM during the kill-switch phase; the restore ran first (restore restored)");
      expect(r.summary).toMatchObject({ kill_switch_prior: "released", kill_switch_restore: "restored" });
      expect(check(r, KS_CHECKS[2]!)?.pass).toBe(true);
      expect(check(r, KS_CHECKS[3]!)?.pass).toBe(true);
      // Nothing after the phase was started.
      expect(check(r, KS_CHECKS[4]!)).toBeUndefined();
      expect(check(r, "public edge checks")).toBeUndefined();
      expect(await db.controls.isEnrichmentEnabled(INSTALLATION)).toBe(true);
      expectSecretFree(r, relay.base);
    } finally {
      await relay.close();
    }
  });

  it("a target that ignores the kill switch fails the disabled check (exit 1), and the switch is still restored", async () => {
    // What a service that ignored the switch would answer, then answers that differ from
    // disabled/none/recorded=false in exactly one field, so every part of the check is pinned.
    const answers = [
      { version: "1", status: "no_match", source: "provider", recorded: false },
      { version: "1", status: "unavailable", source: "none", recorded: false },
      { version: "1", status: "disabled", source: "cache", recorded: false },
      { version: "1", status: "disabled", source: "none", recorded: true },
    ];
    for (const answer of answers) {
      const relay = await startRelay(base, async () => JSON.stringify(answer));
      try {
        const r = await runSmoke({ ...smokeEnv, SMOKE_BASE_URL: relay.base });
        expect(r.code, r.stdout + r.stderr).toBe(1);
        expect(check(r, KS_CHECKS[2]!)).toEqual({ check: KS_CHECKS[2], pass: false, detail: `status 200 result ${answer.status}/${answer.source}/recorded=${answer.recorded}` });
        expect(r.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual([KS_CHECKS[2]]);
        expect(r.summary).toMatchObject({ kill_switch_prior: "released", kill_switch_restore: "restored", failed: 1 });
        expect(await db.controls.isEnrichmentEnabled(INSTALLATION)).toBe(true);
        expectSecretFree(r, relay.base);
      } finally {
        await relay.close();
      }
    }
  });

  it("the smoke's environment says disabled but the target runs enabled: the ineligible check fails (exit 1) and the switch is not touched", async () => {
    const before = await controlRows();
    const r = await runSmoke({ ...smokeEnv, ALLOW_DOCUMENTATION_RANGES: "false" });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.summary).toMatchObject({ mode: "documentation_ranges_disabled", kill_switch_phase: "skipped_documentation_ranges_disabled" });
    expect(check(r, "documentation-range address (IPv4) -> ineligible, nothing recorded")).toMatchObject({ pass: false, detail: "status 200 result qualified/cache/recorded=true" });
    expect(check(r, "documentation-range address (IPv6) -> ineligible, nothing recorded")?.pass).toBe(false);
    expect(await controlRows()).toEqual(before);
    expectSecretFree(r, base);
  });
});

describe("smoke suite against the real service: documentation ranges disabled", () => {
  const port = 19_500 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const env = serviceEnv(port, "false");
  let service: { proc: ChildProcess; output: () => string };
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
    await resetTestDb(db);
    service = await startService(env);
  });
  afterAll(async () => {
    service?.proc.kill("SIGKILL");
    await db.close();
  });

  it("documentation addresses answer ineligible; only the checks needing an eligible documentation address are skipped; the switch is not touched (exit 0)", async () => {
    await db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released");
    const before = (await db.pool.query("SELECT enrichment_enabled, reason, updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows;
    const r = await runSmoke({ ...env, SMOKE_BASE_URL: base });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    expect(r.summary).toMatchObject({
      target: "loopback",
      mode: "documentation_ranges_disabled",
      kill_switch_phase: "skipped_documentation_ranges_disabled",
      kill_switch_prior: "not_read",
      kill_switch_restore: "not_run",
      // 28 at Gate 4 (13 of them skip-passes, G4-I7), plus the orphan, feed-shape and two events-disabled checks.
      checks: 32,
      passed: 19,
      failed: 0,
      skipped: 13,
      first_source: "none",
    });
    expect(check(r, "documentation-range address (IPv4) -> ineligible, nothing recorded")).toEqual({
      check: "documentation-range address (IPv4) -> ineligible, nothing recorded",
      pass: true,
      detail: "status 200 result ineligible/none/recorded=false",
    });
    expect(check(r, "documentation-range address (IPv6) -> ineligible, nothing recorded")?.detail).toBe("status 200 result ineligible/none/recorded=false");
    expect(check(r, "response carries no company data (D2: exactly version,status,source,recorded)")?.pass).toBe(true);
    const skipped = r.checks.filter((c) => c.detail === SKIPPED_DOCS).map((c) => c.check);
    expect(skipped.sort()).toEqual(
      [
        "qualified entrance -> 200 qualified, recorded",
        "repeat address -> cache hit still records an observation",
        "replayed entrance_id -> 200 (idempotent)",
        "no-domain address -> no_match, nothing recorded",
        "feed holds exactly 2 observations for this run (replay not double-counted)",
        "feed observations carry company, page and acquisition context",
        ...KS_CHECKS,
      ].sort(),
    );
    // Everything else still ran for real.
    for (const name of [
      "private healthz 200",
      "entrances without credential -> 401",
      "private address -> ineligible, nothing recorded",
      "occurred_at outside the 300 s window -> 400",
      "unknown request field -> 400 (strict schema)",
      "feed readable with the reporting credential",
      "feed responses carry no IP or unexpected field",
    ]) {
      expect(check(r, name)?.detail.startsWith("skipped"), name).toBe(false);
    }
    const after = (await db.pool.query("SELECT enrichment_enabled, reason, updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows;
    expect(after).toEqual(before);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM ip_resolution_cache")).rows[0].n).toBe(0);
    expect(service.output()).not.toContain('"reason":"kill_switch"');
    expectSecretFree(r, base);
  });
});
