/**
 * Gate 5: the real smoke entry point (src/ops/smoke.ts) against the real
 * service process (src/main.ts) on loopback, development-like environment
 * (mock provider, ALLOW_MOCK_PROVIDER, NODE_ENV=production), test database.
 *
 * Kill-switch ownership (Gate 4 review findings):
 *   - G4-L2: a switch left engaged by a smoke run that was killed (SIGKILL)
 *     stops the next run at once with exit 2 and the release command, never
 *     "left engaged as found"; the same for the Gate 4 smoke's reason. SIGHUP
 *     and SIGQUIT while the switch is held are deferred like SIGTERM: the
 *     restore runs, exit 2.
 *   - G4-L3: an operator who engages (or releases) the switch while the smoke
 *     holds it keeps their setting; the smoke exits 2 and says so.
 *   - G4-I7: skipped checks are counted apart (passed + failed + skipped = checks).
 * Events phase (event.v1):
 *   - enabled: every events check passes, exactly the expected browser_events
 *     rows exist, nothing else is written; a response that gains a field or
 *     an address, a D4 violation written by the event insert, a consent
 *     policy that differs, or a target with events off all FAIL (exit 1);
 *   - EVENT_CONSENT_MODE=not_required on both sides: the not_required event
 *     is stored as asserted (three rows);
 *   - disabled: POST /v1/events is byte-identical to an unknown route;
 *   - `--mode rollback-check` passes against a target without the route,
 *     writes nothing, and fails against a target that has it.
 *
 * This file deliberately imports nothing that Gate 5 added (literal names and
 * reasons only), so it also runs against the Gate 4 smoke, where the
 * ownership and summary tests fail: the before-the-fix evidence.
 * Tokens and the HMAC secret are random per run; every smoke output is
 * scanned for them, the database URL, the target URL, the addresses, the
 * event page_key and every stored event_id.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { KILL_SWITCH_PROBE_PREFIX } from "../../src/ops/smoke-mode.js";
import { createTestDb, getTestDatabaseUrl, resetTestDb } from "../helpers/db.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const INSTALLATION = "inst-test";
const WEBSITE_TOKEN = randomBytes(24).toString("hex");
const REPORTING_TOKEN = randomBytes(24).toString("hex");
const HMAC_SECRET = randomBytes(32).toString("hex");
/** The reason the Gate 4 smoke engaged the switch with; this build's reasons start with it. */
const SMOKE_ENGAGE_PREFIX = "smoke test (CHR-72): engaged temporarily to verify the disabled outcome";
const SMOKE_RESTORE_PREFIX = "smoke test (CHR-72): released again, as found before the run";

const ORPHAN_CHECK = "kill switch: not left engaged by an earlier smoke run";
const KS_DISABLED = "kill switch engaged: uncached address -> disabled, nothing recorded";
const KS_RESTORED = "kill switch: restored to its prior state (read back)";
const KS_CONTROL = "after restore: uncached address reaches the provider again (no_match)";
const EVENT_CHECKS = [
  "events: valid event -> 200 recorded:true",
  "events: response is exactly {version, recorded}",
  "events: same event_id again -> 200 recorded:false (idempotent)",
  "events: second distinct event -> 200 recorded:true",
  "events: without credential -> 401",
  "events: reporting credential rejected -> 401",
  "events: unknown field (ip) -> 400 (strict schema)",
  "events: out-of-vocabulary name -> 400",
  "events: consent not_required under EVENT_CONSENT_MODE=required -> 403 consent_required",
  "events: occurred_at outside the 300 s window -> 400",
  "events: no response carries an address",
  "events db: browser_events holds exactly this run's accepted events",
  "events db: stored rows carry exactly the 0008 columns, vocabulary-only values, no address",
  "events db: the event inserts wrote browser_events only (same-transaction check)",
  "events db: no company observation from the event requests (run page_key scoped)",
  "events db: no cache, company or observation row created during the event requests (high-water marks)",
  "events feed: no item derived from the events; run observations unchanged",
  "events feed: reporting-feed.v1 shape unchanged",
];
const EVENTS_DISABLED_CHECKS = [
  "events disabled: POST /v1/events with the website credential -> 404, byte-identical to an unknown route",
  "events disabled: POST /v1/events without credential -> 401, byte-identical to an unknown route",
];

interface Check {
  check: string;
  outcome: string;
  pass: boolean;
  detail: string;
}
interface SmokeRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  checks: Check[];
  summary: Record<string, unknown> | undefined;
  stdout: string;
  stderr: string;
}

function serviceEnv(port: number, opts: { docs: "true" | "false"; events: "true" | "false"; consent?: "required" | "not_required" }): Record<string, string> {
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
    DATABASE_URL: getTestDatabaseUrl(),
    DATABASE_SSL: "disable",
    PROVIDER_MODE: "mock",
    ALLOW_MOCK_PROVIDER: "true",
    ALLOW_DOCUMENTATION_RANGES: opts.docs,
    EVENTS_ENABLED: opts.events,
    ...(opts.consent ? { EVENT_CONSENT_MODE: opts.consent } : {}),
    OBSERVATION_RETENTION_DAYS: "30",
    // Each smoke run sends 7 requests without a valid credential; this file runs more than 8 a minute from one peer.
    AUTH_FAILURE_LIMIT_PER_MINUTE: "100000",
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

function runSmoke(env: Record<string, string>, args: string[] = [], onChild?: (child: ChildProcess) => void): Promise<SmokeRun> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "src/ops/smoke.ts"), ...args], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    onChild?.(child);
    child.on("close", (code, signal) => {
      const lines = stdout
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      done({
        code,
        signal,
        checks: lines
          .filter((l) => l["event"] === "smoke_check")
          .map((l) => ({ check: String(l["check"]), outcome: String(l["outcome"]), pass: l["pass"] === true, detail: String(l["detail"]) })),
        summary: lines.find((l) => l["event"] === "smoke_summary"),
        stdout,
        stderr,
      });
    });
  });
}

const check = (r: SmokeRun, name: string) => r.checks.find((c) => c.check === name);
const failedChecks = (r: SmokeRun) => r.checks.filter((c) => c.outcome === "fail").map((c) => c.check);

/**
 * A loopback relay in front of the service. `intercept` sees every request
 * first: it may wait or act (as an operator would), and may answer instead of
 * forwarding. `transform` may rewrite a forwarded answer's body.
 */
async function startRelay(
  upstream: string,
  opts: {
    intercept?: (path: string, body: string) => Promise<{ status: number; text: string } | undefined>;
    transform?: (path: string, status: number, text: string) => string;
  },
): Promise<{ base: string; close: () => Promise<void> }> {
  const relay: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      void (async () => {
        const path = req.url ?? "/";
        const answer = await opts.intercept?.(path, body);
        if (answer !== undefined) {
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(answer.text);
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length" && k !== "connection") headers[k] = v;
        const r = await fetch(`${upstream}${path}`, { method: req.method ?? "GET", headers, ...(body.length > 0 ? { body } : {}), redirect: "manual" });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(opts.transform ? opts.transform(path, r.status, text) : text);
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

/** Holds the kill-switch probe entrance for a moment, and calls `onProbe` first: the switch is engaged by the smoke then. */
const holdProbe = (onProbe: () => Promise<void> | void, holdMs = 1_500) => async (path: string, body: string) => {
  if (path === "/v1/entrances" && body.includes(KILL_SWITCH_PROBE_PREFIX)) {
    await onProbe();
    await new Promise((r) => setTimeout(r, holdMs));
  }
  return undefined;
};

describe("smoke ownership and events phase against the real service: documentation ranges and events enabled", () => {
  const port = 20_000 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const env = serviceEnv(port, { docs: "true", events: "true" });
  const smokeEnv = { ...env, SMOKE_BASE_URL: base };
  let service: { proc: ChildProcess; output: () => string };
  let db: Db;
  const controlRows = async () =>
    (await db.pool.query<{ enrichment_enabled: boolean; reason: string; updated_at: Date }>("SELECT enrichment_enabled, reason, updated_at FROM deployment_controls WHERE installation_id = $1", [INSTALLATION])).rows;
  const control = async () => (await controlRows()).map(({ enrichment_enabled, reason }) => ({ enrichment_enabled, reason }));
  const release = () => db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released");
  const runEvents = async (r: SmokeRun) =>
    (
      await db.pool.query<{ event_id: string; type: string; name: string; consent: string; origin: string }>(
        "SELECT event_id, type, name, consent, origin FROM browser_events WHERE page_key = $1 ORDER BY id",
        [`/smoke/${String(r.summary?.["run"])}/ev`],
      )
    ).rows;

  /** Nothing secret, no configuration value, no address, page_key or event_id in anything the smoke writes. */
  async function expectSecretFree(r: SmokeRun, target: string): Promise<void> {
    const out = `${r.stdout}${r.stderr}`;
    for (const needle of [WEBSITE_TOKEN, REPORTING_TOKEN, HMAC_SECRET, getTestDatabaseUrl(), target, "203.0.113.", "2001:db8", "10.0.0.1", "127.0.0.1", "postgres://", "/smoke/"]) {
      expect(out.includes(needle), `smoke output leaked a value (${needle.length} chars)`).toBe(false);
    }
    for (const e of await runEvents(r)) expect(out.includes(e.event_id), "smoke output leaked an event_id").toBe(false);
    for (const line of r.stdout.split("\n").filter((l) => l.length > 0)) expect(() => JSON.parse(line)).not.toThrow();
  }

  beforeAll(async () => {
    db = await createTestDb();
    await resetTestDb(db);
    service = await startService(env);
  });
  afterAll(async () => {
    service?.proc.kill("SIGKILL");
    await db.pool.query("DROP TRIGGER IF EXISTS g5c_smoke_leak ON browser_events").catch(() => undefined);
    await db.pool.query("DROP FUNCTION IF EXISTS g5c_smoke_leak()").catch(() => undefined);
    await db.close();
  });

  it("events enabled: every check passes, exactly the two accepted events are stored and nothing else; skipped counted apart (exit 0)", async () => {
    const r = await runSmoke(smokeEnv);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(failedChecks(r)).toEqual([]);
    expect(r.summary).toMatchObject({
      suite: "full",
      target: "loopback",
      mode: "documentation_ranges_enabled",
      events_mode: "events_enabled",
      event_consent_mode: "required",
      events_phase: "run",
      kill_switch_restore: "restored",
      checks: 46,
      passed: 45,
      failed: 0,
      skipped: 1,
    });
    for (const name of EVENT_CHECKS) expect(check(r, name)?.outcome, name).toBe("pass");
    expect(check(r, "events db: browser_events holds exactly this run's accepted events")?.detail).toBe("rows 2, expected 2");
    expect(check(r, "events db: no cache, company or observation row created during the event requests (high-water marks)")?.detail).toBe("no row created");
    // The database agrees: two rows, granted, origin browser, vocabulary pairs; never an observation.
    const rows = await runEvents(r);
    expect(rows.map(({ type, name, consent, origin }) => ({ type, name, consent, origin }))).toEqual([
      { type: "page_view", name: "page_view", consent: "granted", origin: "browser" },
      { type: "engagement", name: "scroll_50", consent: "granted", origin: "browser" },
    ]);
    const obs = await db.pool.query("SELECT count(*)::int AS n FROM company_observations WHERE page_key = $1", [`/smoke/${String(r.summary?.["run"])}/ev`]);
    expect(obs.rows[0].n).toBe(0);
    // The switch is back, released by this run's own hand.
    expect(await control()).toEqual([{ enrichment_enabled: true, reason: `${SMOKE_RESTORE_PREFIX} [run ${String(r.summary?.["run"])}]` }]);
    // The events phase changed no configuration: the service still has the route, consent still required.
    expect(service.output()).toContain('"events_enabled":true');
    await expectSecretFree(r, base);
  });

  it("G4-L2: a switch left engaged with the Gate 4 smoke's reason stops the run at once: exit 2, release command, nothing sent, switch untouched", async () => {
    await db.controls.setEnrichmentEnabled(INSTALLATION, false, SMOKE_ENGAGE_PREFIX);
    const before = await controlRows();
    try {
      const r = await runSmoke(smokeEnv);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.checks.map((c) => [c.check, c.outcome])).toEqual([[ORPHAN_CHECK, "fail"]]);
      expect(r.summary).toMatchObject({ kill_switch_prior: "engaged", kill_switch_restore: "orphan_left_engaged", checks: 1, failed: 1 });
      expect(r.stderr).toContain("KILL SWITCH LEFT ENGAGED BY AN EARLIER SMOKE RUN");
      expect(r.stderr).toContain("node dist/ops/kill-switch.js off --reason");
      expect(r.stderr).not.toContain("left_engaged_as_found");
      expect(await controlRows()).toEqual(before);
      await expectSecretFree(r, base);
    } finally {
      await release();
    }
  });

  it("G4-L2: SIGKILL while the switch is held leaves it engaged; the next run reports that orphan (exit 2) instead of passing", async () => {
    let child: ChildProcess | undefined;
    let killed = false;
    const relay = await startRelay(base, {
      intercept: holdProbe(() => {
        if (!killed) {
          killed = true;
          child!.kill("SIGKILL");
        }
      }),
    });
    try {
      const first = await runSmoke({ ...smokeEnv, SMOKE_BASE_URL: relay.base }, [], (c) => (child = c));
      expect(first.signal).toBe("SIGKILL");
      const left = await control();
      expect(left).toHaveLength(1);
      expect(left[0]!.enrichment_enabled).toBe(false);
      expect(left[0]!.reason.startsWith(SMOKE_ENGAGE_PREFIX)).toBe(true);

      const next = await runSmoke(smokeEnv);
      expect(next.code, next.stdout + next.stderr).toBe(2);
      expect(next.checks.map((c) => [c.check, c.outcome])).toEqual([[ORPHAN_CHECK, "fail"]]);
      expect(next.stderr).toContain("KILL SWITCH LEFT ENGAGED BY AN EARLIER SMOKE RUN");
      expect(await control()).toEqual(left);
      await expectSecretFree(next, base);
    } finally {
      await relay.close();
      await release();
    }
  });

  for (const signal of ["SIGHUP", "SIGQUIT"] as const) {
    it(`G4-L2: ${signal} while the switch is held is deferred: the restore runs first, then exit 2`, async () => {
      let child: ChildProcess | undefined;
      const relay = await startRelay(base, { intercept: holdProbe(() => void child!.kill(signal)) });
      try {
        const r = await runSmoke({ ...smokeEnv, SMOKE_BASE_URL: relay.base }, [], (c) => (child = c));
        expect(r.signal, r.stdout + r.stderr).toBeNull();
        expect(r.code, r.stdout + r.stderr).toBe(2);
        expect(r.stderr).toContain(`interrupted by ${signal} during the kill-switch phase; the restore ran first (restore restored)`);
        expect(r.summary).toMatchObject({ kill_switch_prior: "released", kill_switch_restore: "restored" });
        expect(check(r, KS_DISABLED)?.outcome).toBe("pass");
        expect(check(r, KS_RESTORED)?.outcome).toBe("pass");
        // Released again by this run's own hand.
        expect(await control()).toEqual([{ enrichment_enabled: true, reason: `${SMOKE_RESTORE_PREFIX} [run ${String(r.summary?.["run"])}]` }]);
        await expectSecretFree(r, relay.base);
      } finally {
        await relay.close();
        await release();
      }
    });
  }

  it("G4-L3: an operator engages the switch while the smoke holds it: the smoke leaves it engaged with the operator's reason and exits 2", async () => {
    const relay = await startRelay(base, { intercept: holdProbe(() => db.controls.setEnrichmentEnabled(INSTALLATION, false, "operator: incident, keep engaged"), 200) });
    try {
      const r = await runSmoke({ ...smokeEnv, SMOKE_BASE_URL: relay.base });
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.summary).toMatchObject({ kill_switch_prior: "released", kill_switch_restore: "changed_during_run" });
      expect(check(r, KS_RESTORED)).toMatchObject({ outcome: "fail", detail: "restore changed_during_run, reads engaged" });
      expect(check(r, KS_CONTROL)?.outcome).toBe("skipped");
      expect(r.stderr).toContain("KILL SWITCH CHANGED BY SOMEONE ELSE DURING THE RUN");
      expect(r.stderr).toContain("did NOT release it");
      expect(r.stderr).not.toContain("operator: incident");
      expect(await control()).toEqual([{ enrichment_enabled: false, reason: "operator: incident, keep engaged" }]);
      await expectSecretFree(r, relay.base);
    } finally {
      await relay.close();
      await release();
    }
  });

  it("G4-L3: an operator releases the switch while the smoke holds it: the smoke writes nothing more and exits 2", async () => {
    const relay = await startRelay(base, { intercept: holdProbe(() => db.controls.setEnrichmentEnabled(INSTALLATION, true, "operator: released early"), 200) });
    try {
      const r = await runSmoke({ ...smokeEnv, SMOKE_BASE_URL: relay.base });
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(r.summary).toMatchObject({ kill_switch_restore: "changed_during_run" });
      expect(await control()).toEqual([{ enrichment_enabled: true, reason: "operator: released early" }]);
    } finally {
      await relay.close();
      await release();
    }
  });

  it("an event response that gains a field or an address fails the privacy checks (exit 1)", async () => {
    const relay = await startRelay(base, {
      transform: (path, status, text) => (path === "/v1/events" && status === 200 ? JSON.stringify({ ...JSON.parse(text), ip: "203.0.113.77" }) : text),
    });
    try {
      const r = await runSmoke({ ...smokeEnv, SMOKE_BASE_URL: relay.base });
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(failedChecks(r).sort()).toEqual(["events: no response carries an address", "events: response is exactly {version, recorded}"]);
      expect(check(r, "events: response is exactly {version, recorded}")?.detail).toBe("keys ip,recorded,version");
      expect(r.summary).toMatchObject({ kill_switch_restore: "restored" });
    } finally {
      await relay.close();
    }
  });

  it("a D4 violation (the event insert also writes a company and an observation) fails the database and feed checks (exit 1)", async () => {
    await db.pool.query(`CREATE OR REPLACE FUNCTION g5c_smoke_leak() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE cid bigint;
      BEGIN
        INSERT INTO companies (domain, organisation_name, first_seen_at, last_seen_at)
          VALUES ('leak-' || lower(NEW.event_id) || '.example', NULL, now(), now()) RETURNING id INTO cid;
        INSERT INTO company_observations (installation_id, website_id, company_id, observed_at, observation_ref, source, page_key)
          VALUES (NEW.installation_id, NEW.website_id, cid, now(), NEW.event_id, 'provider', NEW.page_key);
        RETURN NEW;
      END $$`);
    await db.pool.query("CREATE TRIGGER g5c_smoke_leak AFTER INSERT ON browser_events FOR EACH ROW EXECUTE FUNCTION g5c_smoke_leak()");
    try {
      const r = await runSmoke(smokeEnv);
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(failedChecks(r).sort()).toEqual(
        [
          "events db: the event inserts wrote browser_events only (same-transaction check)",
          "events db: no company observation from the event requests (run page_key scoped)",
          "events db: no cache, company or observation row created during the event requests (high-water marks)",
          "events feed: no item derived from the events; run observations unchanged",
        ].sort(),
      );
      expect(check(r, "events db: the event inserts wrote browser_events only (same-transaction check)")?.detail).toBe("written: companies,company_observations");
      expect(check(r, "events db: no company observation from the event requests (run page_key scoped)")?.detail).toBe("event page_key 2, run rows since mark 2");
      expect(check(r, "events feed: no item derived from the events; run observations unchanged")?.detail).toBe("event page_key or event_id present; run observations 4 (before 2)");
      // The rows themselves are still exactly the two accepted events.
      expect(check(r, "events db: browser_events holds exactly this run's accepted events")?.outcome).toBe("pass");
      await expectSecretFree(r, base);
    } finally {
      await db.pool.query("DROP TRIGGER IF EXISTS g5c_smoke_leak ON browser_events");
      await db.pool.query("DROP FUNCTION IF EXISTS g5c_smoke_leak()");
    }
  });

  it("the smoke's consent policy differs from the target's: the consent and row-count checks fail (exit 1)", async () => {
    const r = await runSmoke({ ...smokeEnv, EVENT_CONSENT_MODE: "not_required" });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(failedChecks(r).sort()).toEqual(["events db: browser_events holds exactly this run's accepted events", "events: consent not_required under EVENT_CONSENT_MODE=not_required -> 200 recorded:true"].sort());
    expect(check(r, "events: consent not_required under EVENT_CONSENT_MODE=not_required -> 200 recorded:true")?.detail).toBe("status 403 recorded=undefined");
  });

  it("rollback-check against a target that HAS the events route fails (exit 1): the absent check is not vacuous", async () => {
    const r = await runSmoke(smokeEnv, ["--mode", "rollback-check"]);
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(failedChecks(r)).toEqual(["rollback: POST /v1/events with the website credential answers exactly like an unknown route (absent)"]);
    expect(check(r, "rollback: POST /v1/events with the website credential answers exactly like an unknown route (absent)")?.detail).toMatch(/^status 200 vs 404, differs: /);
  });
});

describe("smoke against the real service: documentation ranges and events disabled", () => {
  const port = 20_500 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const env = serviceEnv(port, { docs: "false", events: "false" });
  const smokeEnv = { ...env, SMOKE_BASE_URL: base };
  let service: { proc: ChildProcess; output: () => string };
  let db: Db;
  const counts = async () =>
    (
      await db.pool.query<{ events: number; observations: number; cache: number; controls: string }>(
        `SELECT (SELECT count(*)::int FROM browser_events) AS events, (SELECT count(*)::int FROM company_observations) AS observations,
                (SELECT count(*)::int FROM ip_resolution_cache) AS cache,
                (SELECT coalesce(string_agg(enrichment_enabled::text || reason || updated_at::text, ','), '') FROM deployment_controls) AS controls`,
      )
    ).rows[0]!;

  beforeAll(async () => {
    db = await createTestDb();
    await resetTestDb(db);
    await db.controls.setEnrichmentEnabled(INSTALLATION, true, "test: released");
    service = await startService(env);
  });
  afterAll(async () => {
    service?.proc.kill("SIGKILL");
    await db.close();
  });

  it("G4-I7: skipped checks are counted apart (passed + failed + skipped = checks); POST /v1/events is byte-identical to an unknown route (exit 0)", async () => {
    const before = await counts();
    const r = await runSmoke(smokeEnv);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.summary).toMatchObject({ mode: "documentation_ranges_disabled", events_mode: "events_disabled", events_phase: "check_disabled", checks: 32, passed: 19, failed: 0, skipped: 13 });
    const s = r.summary!;
    expect(Number(s["passed"]) + Number(s["failed"]) + Number(s["skipped"])).toBe(Number(s["checks"]));
    // Every line says which it was, and the counts match the lines.
    expect(r.checks.filter((c) => c.outcome === "skipped")).toHaveLength(13);
    expect(r.checks.filter((c) => c.outcome === "skipped").every((c) => c.detail.startsWith("skipped: ") && c.pass)).toBe(true);
    expect(r.checks.filter((c) => c.outcome === "pass")).toHaveLength(19);
    for (const name of EVENTS_DISABLED_CHECKS) expect(check(r, name)?.outcome, name).toBe("pass");
    expect(check(r, EVENTS_DISABLED_CHECKS[0]!)?.detail).toBe("status 404, identical to an unknown route");
    expect(check(r, EVENTS_DISABLED_CHECKS[1]!)?.detail).toBe("status 401, identical to an unknown route");
    // Nothing stored, switch untouched.
    expect(await counts()).toEqual(before);
  });

  it("the smoke's environment says events enabled but the target has them disabled: the events checks fail (exit 1)", async () => {
    const r = await runSmoke({ ...smokeEnv, EVENTS_ENABLED: "true" });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(check(r, "events: valid event -> 200 recorded:true")).toMatchObject({ outcome: "fail", detail: "status 404 recorded=undefined" });
    expect(check(r, "events db: browser_events holds exactly this run's accepted events")).toMatchObject({ outcome: "fail", detail: "rows 0, expected 2" });
  });

  it("--mode rollback-check passes against a target without the events route, and writes nothing (exit 0)", async () => {
    const before = await counts();
    const r = await runSmoke(smokeEnv, ["--mode", "rollback-check"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.summary).toMatchObject({ suite: "rollback_check", events_phase: "check_absent", kill_switch_phase: "not_run", checks: 13, passed: 12, failed: 0, skipped: 1 });
    expect(r.checks.map((c) => c.check)).toEqual([
      "private healthz 200",
      "private readyz 200 (database reachable)",
      "entrances without credential -> 401",
      "entrances with wrong credential -> 401",
      "reporting credential rejected on entrances -> 401",
      "website credential rejected on feed -> 401",
      "feed without credential -> 401",
      "feed readable with the reporting credential",
      "feed responses carry no IP or unexpected field",
      "feed pages keep the reporting-feed.v1 shape",
      "rollback: POST /v1/events with the website credential answers exactly like an unknown route (absent)",
      "rollback: POST /v1/events without credential -> 401, exactly like an unknown route",
      "public edge checks",
    ]);
    expect(await counts()).toEqual(before);
  });
});

describe("smoke against the real service: events enabled under EVENT_CONSENT_MODE=not_required, documentation ranges disabled", () => {
  const port = 21_000 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const env = serviceEnv(port, { docs: "false", events: "true", consent: "not_required" });
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

  it("the not_required event is accepted and stored as asserted: three rows, every events check passes (exit 0)", async () => {
    const r = await runSmoke({ ...env, SMOKE_BASE_URL: base });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.summary).toMatchObject({ mode: "documentation_ranges_disabled", events_mode: "events_enabled", event_consent_mode: "not_required", events_phase: "run", checks: 48, passed: 35, failed: 0, skipped: 13 });
    expect(check(r, "events: consent not_required under EVENT_CONSENT_MODE=not_required -> 200 recorded:true")).toMatchObject({ outcome: "pass", detail: "status 200 recorded=true" });
    expect(check(r, "events db: browser_events holds exactly this run's accepted events")).toMatchObject({ outcome: "pass", detail: "rows 3, expected 3" });
    const rows = (await db.pool.query<{ consent: string }>("SELECT consent FROM browser_events WHERE page_key = $1 ORDER BY id", [`/smoke/${String(r.summary?.["run"])}/ev`])).rows;
    expect(rows.map((x) => x.consent)).toEqual(["granted", "granted", "not_required"]);
  });
});
