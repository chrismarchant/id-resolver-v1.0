/**
 * In-process runner (CHR-70). Ports every still-relevant assertion of the
 * removed V0.1 child-manager suite: result propagation, crash containment,
 * deadline, capacity, shutdown, outcome allowlisting, pipeline config, and
 * "no IP or secret in logs". Behaviour is injected through the runner's
 * `execute` seam (the V0.1 suite used a stub child selected by the IP).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../../src/config/index.js";
import { RunnerOverloadedError, RunnerStoppedError, type ResolutionJob, type ResolutionOutcome } from "../../src/contracts/runtime.js";
import { createMemoryLogger } from "../../src/log/index.js";
import type { PipelineDeps } from "../../src/resolution/pipeline.js";
import { buildPipelineConfig, createRunner, poolSizeFor, sanitiseOutcome, type JobExecutor } from "../../src/runtime/runner.js";
import { EVENT_WRITES_MAX_IN_FLIGHT } from "../../src/api/events.js";
import { createFakeRepositories } from "../helpers/fakes.js";
import { createMockProvider } from "../../src/provider/mock.js";

const SECRETS = {
  RESOLVER_AUTH_TOKEN: "t".repeat(40),
  IP_HMAC_SECRET: "0123456789abcdef".repeat(4),
  ENRICH_API_KEY: "sk_test_secret_key",
  DATABASE_URL: "postgres://user:pw@db.invalid:5432/resolver",
};

function makeConfig(over: Record<string, string> = {}): Config {
  return ConfigSchema.parse({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    INSTALLATION_ID: "inst-test",
    WEBSITE_ID: "site-test",
    ...SECRETS,
    PROVIDER_MODE: "mock",
    MAX_CONCURRENT_JOBS: "3",
    OBSERVATION_RETENTION_DAYS: "30",
    ...over,
  });
}

const REF = "obsref-0123456789abcdef";
const IP = "203.0.113.1";
const deadline = (ms: number) => Date.now() + ms;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CONTEXT = { pageKey: "/pricing", acquisition: "search", entranceContract: "entrance.v1", eligibility: "tsa-1" } as const;
const QUALIFIED: ResolutionOutcome = {
  status: "qualified",
  source: "provider",
  reason: "provider_resolved",
  activity: { company_id: 7, previously_seen: false, recorded: true, observation_ref: REF },
};

/** A job that resolves when told to, and records what it was given. */
function controllable() {
  const jobs: ResolutionJob[] = [];
  const releases: Array<(o: ResolutionOutcome) => void> = [];
  const execute: JobExecutor = (_deps, _cfg, job) =>
    new Promise<ResolutionOutcome>((resolve) => {
      jobs.push(job);
      releases.push(resolve);
    });
  return { jobs, execute, releaseAll: (o: ResolutionOutcome) => releases.splice(0).forEach((r) => r(o)) };
}

function setup(execute: JobExecutor, over: { capacity?: number; stuckAfterMs?: number; onStuck?: () => void } = {}) {
  const logger = createMemoryLogger();
  const repos = createFakeRepositories();
  const runner = createRunner({
    config: buildPipelineConfig(makeConfig()),
    deps: { ...repos, provider: createMockProvider() },
    logger,
    capacity: over.capacity ?? 3,
    ...(over.stuckAfterMs !== undefined ? { stuckAfterMs: over.stuckAfterMs } : {}),
    ...(over.onStuck ? { onStuck: over.onStuck } : {}),
    execute,
  });
  return { runner, logger, repos };
}

describe("runner: results and crash containment", () => {
  it("propagates a valid outcome, frees the slot, and logs neither the IP nor any secret", async () => {
    const seen: PipelineDeps[] = [];
    const { runner, logger } = setup(async (deps) => {
      seen.push(deps);
      return QUALIFIED;
    });
    const o = await runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT });
    expect(o).toEqual(QUALIFIED);
    expect(runner.activeCount()).toBe(0);
    // The job receives the shared repositories, the logger and the deferred-write tracker.
    expect(typeof seen[0]!.onDeferred).toBe("function");
    const all = JSON.stringify(logger.entries);
    expect(all).not.toContain(IP);
    for (const s of Object.values(SECRETS)) expect(all).not.toContain(s);
  });

  it("hands the job the IP, deadline and reference, a random job id and a live abort signal", async () => {
    const c = controllable();
    const { runner } = setup(c.execute);
    const at = deadline(5_000);
    const p = runner.run({ ip: IP, deadlineAtMs: at, observationRef: REF, context: CONTEXT });
    expect(c.jobs[0]).toMatchObject({ ip: IP, deadline_at_ms: at, observation_ref: REF, context: CONTEXT });
    expect(c.jobs[0]!.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.jobs[0]!.job_id).not.toContain(IP);
    expect(c.jobs[0]!.signal?.aborted).toBe(false);
    c.releaseAll(QUALIFIED);
    await p;
  });

  it.each([
    ["a synchronous throw", (() => {
      throw new Error("boom 203.0.113.1");
    }) as JobExecutor],
    ["a rejection", (async () => {
      throw new Error("boom 203.0.113.1");
    }) as JobExecutor],
  ])("%s -> unavailable/internal_error, slot freed, error text never logged", async (_label, execute) => {
    const { runner, logger } = setup(execute);
    const o = await runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT });
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "internal_error" });
    expect(runner.activeCount()).toBe(0);
    expect(logger.entries.some((e) => e["event"] === "job_error" && e["category"] === "job")).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain("boom");
    expect(JSON.stringify(logger.entries)).not.toContain(IP);
  });

  it.each([
    ["invalid status", { status: "owned", source: "provider" }],
    ["free-text reason", { status: "no_match", source: "provider", reason: "203.0.113.10 leaked" }],
    ["activity on a non-qualified outcome", { status: "no_match", source: "cache", activity: QUALIFIED.activity }],
    ["not an object", "qualified"],
    ["a throwing getter", Object.defineProperty({ source: "cache" }, "status", { get: () => { throw new Error("203.0.113.1"); }, enumerable: true })],
  ])("%s -> unavailable/internal_error", async (_label, value) => {
    const { runner, logger } = setup(async () => value as unknown as ResolutionOutcome);
    const o = await runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT });
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "internal_error" });
    expect(runner.activeCount()).toBe(0);
    expect(logger.entries.some((e) => e["event"] === "job_error" && e["category"] === "invalid_outcome")).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain("leaked");
  });
});

describe("runner: deadline", () => {
  it("a hanging job -> deadline_exceeded on time; the job's signal is aborted; the slot stays taken until the job settles", async () => {
    const c = controllable();
    const { runner, logger } = setup(c.execute);
    const started = Date.now();
    const o = await runner.run({ ip: IP, deadlineAtMs: deadline(400), observationRef: REF, context: CONTEXT });
    const elapsed = Date.now() - started;
    expect(o).toEqual({ status: "unavailable", source: "none", reason: "deadline_exceeded" });
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(400 + 150);
    expect(c.jobs[0]!.signal?.aborted).toBe(true);
    expect(logger.entries.some((e) => e["event"] === "job_timeout")).toBe(true);
    // Overrunning work still counts against capacity (the V0.1 child was alive until reaped).
    expect(runner.activeCount()).toBe(1);
    c.releaseAll(QUALIFIED);
    await sleep(10);
    expect(runner.activeCount()).toBe(0);
    expect(logger.entries.some((e) => e["event"] === "job_settled")).toBe(true);
  });

  it("a late result never replaces the deadline answer", async () => {
    const { runner } = setup(async () => {
      await sleep(300);
      return QUALIFIED;
    });
    const o = await runner.run({ ip: IP, deadlineAtMs: deadline(100), observationRef: REF, context: CONTEXT });
    expect(o.reason).toBe("deadline_exceeded");
  });

  it("a job that ignores the abort is reported as stuck once, after the stuck threshold", async () => {
    const stuck: number[] = [];
    const { runner, logger } = setup(() => new Promise<ResolutionOutcome>(() => undefined), { stuckAfterMs: 150, onStuck: () => stuck.push(Date.now()) });
    const started = Date.now();
    const o = await runner.run({ ip: IP, deadlineAtMs: deadline(100), observationRef: REF, context: CONTEXT });
    expect(o.reason).toBe("deadline_exceeded");
    await sleep(400);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]! - started).toBeGreaterThanOrEqual(240);
    expect(logger.entries.filter((e) => e["event"] === "job_stuck")).toHaveLength(1);
    expect(runner.activeCount()).toBe(1);
  });

  it("a job that settles before the stuck threshold is never reported", async () => {
    const stuck: number[] = [];
    const { runner } = setup(async () => {
      await sleep(150);
      return QUALIFIED;
    }, { stuckAfterMs: 200, onStuck: () => stuck.push(1) });
    await runner.run({ ip: IP, deadlineAtMs: deadline(50), observationRef: REF, context: CONTEXT });
    await sleep(400);
    expect(stuck).toEqual([]);
    expect(runner.activeCount()).toBe(0);
  });
});

describe("runner: capacity and shutdown", () => {
  it("enforces capacity synchronously at admission; capacity returns once jobs settle", async () => {
    const c = controllable();
    const { runner } = setup(c.execute);
    expect(runner.capacity()).toBe(3);
    const runs = [1, 2, 3].map(() => runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT }));
    expect(runner.activeCount()).toBe(3);
    expect(() => runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT })).toThrow(RunnerOverloadedError);
    expect(c.jobs).toHaveLength(3);
    c.releaseAll(QUALIFIED);
    expect((await Promise.all(runs)).every((o) => o.status === "qualified")).toBe(true);
    expect(runner.activeCount()).toBe(0);
    const again = runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT });
    c.releaseAll(QUALIFIED);
    expect((await again).status).toBe("qualified");
  });

  it("shutdown refuses new work and drains executing jobs within the grace period", async () => {
    const c = controllable();
    const { runner } = setup(c.execute);
    const runs = [runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT }), runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT })];
    setTimeout(() => c.releaseAll(QUALIFIED), 100);
    const started = Date.now();
    const drain = await runner.shutdown(2_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(drain).toEqual({ drained: true, activeJobs: 0, pendingWrites: 0 });
    expect((await Promise.all(runs)).every((o) => o.status === "qualified")).toBe(true);
    expect(() => runner.run({ ip: IP, deadlineAtMs: deadline(1_000), observationRef: REF, context: CONTEXT })).toThrow(RunnerStoppedError);
  });

  it("shutdown gives up after the grace period and reports what is left", async () => {
    const { runner } = setup(() => new Promise<ResolutionOutcome>(() => undefined));
    const run = runner.run({ ip: IP, deadlineAtMs: deadline(100), observationRef: REF, context: CONTEXT });
    const started = Date.now();
    const drain = await runner.shutdown(200);
    expect(Date.now() - started).toBeLessThan(600);
    expect(drain).toEqual({ drained: false, activeJobs: 1, pendingWrites: 0 });
    expect((await run).reason).toBe("deadline_exceeded");
  });

  it("shutdown also drains background writes handed over by jobs", async () => {
    let finished = false;
    const { runner } = setup(async (deps) => {
      deps.onDeferred?.(sleep(200).then(() => void (finished = true)));
      return QUALIFIED;
    });
    await runner.run({ ip: IP, deadlineAtMs: deadline(5_000), observationRef: REF, context: CONTEXT });
    expect(runner.activeCount()).toBe(0);
    const drain = await runner.shutdown(2_000);
    expect(finished).toBe(true);
    expect(drain).toEqual({ drained: true, activeJobs: 0, pendingWrites: 0 });
  });
});

describe("buildPipelineConfig", () => {
  it("copies secrets and converts policy units", () => {
    const rc = buildPipelineConfig(makeConfig({ TTL_QUALIFIED_S: "120", DENIED_DOMAINS: "Denied.Example", QUALIFIED_USAGE_TYPES: "com,org" }));
    expect(rc.ip_hmac_secret).toBe(SECRETS.IP_HMAC_SECRET);
    expect(rc.provider).toMatchObject({ mode: "mock", api_key: SECRETS.ENRICH_API_KEY, auth_header: "x-api-key" });
    expect(rc.policy.ttl_qualified_ms).toBe(120_000);
    expect(rc.policy.denied_domains).toEqual(["denied.example"]);
    expect(rc.policy.qualified_usage_types).toEqual(["COM", "ORG"]);
    // Database credentials stay with the pool; the pipeline never sees them.
    expect(JSON.stringify(rc)).not.toContain(SECRETS.DATABASE_URL);
    expect(JSON.stringify(rc)).not.toContain(SECRETS.RESOLVER_AUTH_TOKEN);
  });

  it("uses PERIOD_RESOLVED_CAP when set and PERIOD_CALL_CAP otherwise", () => {
    expect(buildPipelineConfig(makeConfig({ PERIOD_CALL_CAP: "2000", PERIOD_RESOLVED_CAP: "50" })).policy).toMatchObject({
      period_call_cap: 2000,
      period_resolved_cap: 50,
    });
    expect(buildPipelineConfig(makeConfig({ PERIOD_CALL_CAP: "200" })).policy).toMatchObject({
      period_call_cap: 200,
      period_resolved_cap: 200,
    });
  });

  it("disables the provider when the static kill switch is off", () => {
    expect(buildPipelineConfig(makeConfig({ ENRICHMENT_ENABLED: "false" })).provider.mode).toBe("disabled");
  });

  it("sizes the shared pool like the V0.1 worst case (two per job slot plus four)", () => {
    expect(poolSizeFor(8)).toBe(20);
    expect(poolSizeFor(1)).toBe(6);
  });

  it("adds one connection per in-flight browser-event write only when events are enabled (event.v1)", () => {
    expect(poolSizeFor(8, EVENT_WRITES_MAX_IN_FLIGHT)).toBe(20 + EVENT_WRITES_MAX_IN_FLIGHT);
    expect(poolSizeFor(8, 0)).toBe(20);
  });
});

describe("sanitiseOutcome", () => {
  it("rebuilds an allowlisted copy and drops unknown keys", () => {
    const o = sanitiseOutcome({ status: "no_match", source: "cache", reason: "cache_fresh", extra: "203.0.113.1" });
    expect(o).toEqual({ status: "no_match", source: "cache", reason: "cache_fresh" });
  });
  it("drops any company identity (D2: identification only)", () => {
    const o = sanitiseOutcome({ ...QUALIFIED, company: { domain: "example.com", organisation_name: "Example Ltd" }, domain: "example.com" });
    expect(o).toEqual(QUALIFIED);
    expect(JSON.stringify(o)).not.toContain("example.com");
  });
  it("rejects malformed shapes", () => {
    expect(sanitiseOutcome(null)).toBeNull();
    expect(sanitiseOutcome({ status: "qualified", source: "elsewhere" })).toBeNull();
    expect(sanitiseOutcome({ status: "no_match", source: "elsewhere" })).toBeNull();
    expect(sanitiseOutcome({ status: "no_match" })).toBeNull();
    expect(sanitiseOutcome({ source: "cache" })).toBeNull();
  });
  const qualified = { status: "qualified", source: "provider" };
  it("keeps a well-formed activity block on qualified outcomes and drops unknown keys inside it", () => {
    const o = sanitiseOutcome({ ...qualified, activity: { company_id: 42, previously_seen: true, recorded: true, observation_ref: REF, ip: "203.0.113.1" } });
    expect(o?.activity).toEqual({ company_id: 42, previously_seen: true, recorded: true, observation_ref: REF });
    expect(sanitiseOutcome({ ...qualified, activity: { company_id: 1, previously_seen: null, recorded: false, observation_ref: REF } })?.activity).toEqual({ company_id: 1, previously_seen: null, recorded: false, observation_ref: REF });
    expect(sanitiseOutcome(qualified)?.activity).toBeUndefined();
  });
  it("rejects malformed activity blocks and activity on non-qualified outcomes", () => {
    for (const activity of [
      { company_id: 0, previously_seen: true, recorded: true, observation_ref: REF },
      { company_id: "42", previously_seen: true, recorded: true, observation_ref: REF },
      { company_id: 42, previously_seen: "yes", recorded: true, observation_ref: REF },
      { company_id: 42, previously_seen: true, recorded: "true", observation_ref: REF },
      { company_id: 42, previously_seen: true, recorded: true, observation_ref: "short" },
      { company_id: 42, previously_seen: true, recorded: true },
      "activity",
    ]) {
      expect(sanitiseOutcome({ ...qualified, activity }), JSON.stringify(activity)).toBeNull();
    }
    expect(sanitiseOutcome({ status: "no_match", source: "cache", activity: { company_id: 42, previously_seen: true, recorded: true, observation_ref: REF } })).toBeNull();
  });
});

describe("single-process hygiene", () => {
  const SRC = resolve(import.meta.dirname, "..", "..", "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("no service module forks or spawns a process (no IP or secret can travel through argv or a child environment)", () => {
    const offenders = files(SRC).filter((f) => /node:child_process|from "child_process"|\bfork\(|\bspawn\(|\bexecFile\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the only worker thread is the watchdog, started from a constant source with an empty environment and no inherited flags", () => {
    const users = files(SRC).filter((f) => readFileSync(f, "utf8").includes("new Worker("));
    expect(users.map((f) => f.slice(SRC.length + 1))).toEqual(["runtime/watchdog.ts"]);
    const src = readFileSync(join(SRC, "runtime", "watchdog.ts"), "utf8");
    expect(src).toContain("execArgv: []");
    expect(src).toContain("env: {}");
    expect(src).toContain('process.kill(process.pid, "SIGKILL")');
    expect(src).not.toMatch(/process\.(abort|kill\([^)]*SIGABRT)/);
  });
});
