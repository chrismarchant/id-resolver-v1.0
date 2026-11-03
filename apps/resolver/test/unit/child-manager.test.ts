import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../../src/config/index.js";
import { ChildManagerOverloadedError, ChildManagerStoppedError } from "../../src/contracts/child-manager.js";
import { createMemoryLogger } from "../../src/log/index.js";
import { buildChildRuntimeConfig, createChildManager, sanitiseOutcome } from "../../src/supervisor/child-manager.js";

const STUB = fileURLToPath(new URL("../helpers/stub-child.ts", import.meta.url));
const GRACE = 300;

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
    CHILD_HARD_KILL_GRACE_MS: String(GRACE),
    MAX_CONCURRENT_CHILDREN: "3",
    ...over,
  });
}

function setup(over: Record<string, string> = {}) {
  const logger = createMemoryLogger();
  const config = makeConfig(over);
  const manager = createChildManager({ config, logger, childModulePath: STUB });
  return { logger, manager, config };
}

function pidsOf(entries: Array<Record<string, unknown>>): number[] {
  return entries.filter((e) => e["event"] === "child_spawned").map((e) => e["pid"] as number);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    expect((err as NodeJS.ErrnoException).code).toBe("ESRCH");
    return false;
  }
}

const REF = "obsref-0123456789abcdef";
const deadline = (ms: number) => Date.now() + ms;

// Secrets present in the parent environment must not leak into children.
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("child manager", () => {
  it("propagates a valid result; child has clean argv/env/execArgv and is reaped", async () => {
    const { manager, logger } = setup();
    const o = await manager.run({ ip: "203.0.113.1", requestId: "req-1", deadlineAtMs: deadline(5_000), observationRef: REF });
    expect(o).toEqual({
      status: "qualified",
      company: {
        domain: "example.com",
        organisation_name: "Example Ltd",
        qualification: { category: "COM", source: "provider_usage_type" },
        resolved_at: "2026-10-26T12:00:00.000Z",
      },
      source: "provider",
      reason: "provider_resolved",
    });
    expect(manager.activeCount()).toBe(0);
    const [pid] = pidsOf(logger.entries);
    expect(isAlive(pid!)).toBe(false);
    const exit = logger.entries.find((e) => e["event"] === "child_exit");
    expect(exit?.["exit_code"]).toBe(0);
    const all = JSON.stringify(logger.entries);
    expect(all).not.toContain("203.0.113.1");
    for (const s of Object.values(SECRETS)) expect(all).not.toContain(s);
  });

  it("crash before result -> unavailable/internal_error", async () => {
    const { manager } = setup();
    const o = await manager.run({ ip: "203.0.113.2", deadlineAtMs: deadline(5_000), observationRef: REF });
    expect(o).toEqual({ status: "unavailable", company: null, source: "none", reason: "internal_error" });
    expect(manager.activeCount()).toBe(0);
  });

  it("hang -> deadline_exceeded within deadline + grace; child killed and reaped", async () => {
    const { manager, logger } = setup();
    const started = Date.now();
    const o = await manager.run({ ip: "203.0.113.3", deadlineAtMs: deadline(1_000), observationRef: REF });
    const elapsed = Date.now() - started;
    expect(o).toEqual({ status: "unavailable", company: null, source: "none", reason: "deadline_exceeded" });
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1_000 + GRACE + 200);
    expect(manager.activeCount()).toBe(0);
    const [pid] = pidsOf(logger.entries);
    expect(isAlive(pid!)).toBe(false);
    expect(logger.entries.some((e) => e["event"] === "child_timeout")).toBe(true);
  });

  it("a child ignoring SIGTERM is SIGKILLed after the grace period", async () => {
    const { manager, logger } = setup();
    const started = Date.now();
    const o = await manager.run({ ip: "203.0.113.9", deadlineAtMs: deadline(1_000), observationRef: REF });
    expect(o.reason).toBe("deadline_exceeded");
    expect(Date.now() - started).toBeLessThan(1_000 + GRACE + 400);
    expect(logger.entries.some((e) => e["event"] === "child_killed" && e["signal"] === "SIGKILL")).toBe(true);
    expect(isAlive(pidsOf(logger.entries)[0]!)).toBe(false);
    expect(manager.activeCount()).toBe(0);
  });

  it("result then hang -> result kept, child still killed and reaped", async () => {
    const { manager, logger } = setup();
    const o = await manager.run({ ip: "203.0.113.5", deadlineAtMs: deadline(5_000), observationRef: REF });
    expect(o).toEqual({ status: "no_match", company: null, source: "provider", reason: "provider_no_domain" });
    expect(manager.activeCount()).toBe(0);
    expect(isAlive(pidsOf(logger.entries)[0]!)).toBe(false);
  });

  it.each([
    ["non-protocol message", "203.0.113.4"],
    ["invalid status", "203.0.113.6"],
    ["wrong job id", "203.0.113.7"],
    ["company on a non-qualified status", "203.0.113.8"],
    ["free-text reason", "203.0.113.10"],
  ])("%s -> unavailable/internal_error", async (_label, ip) => {
    const { manager } = setup();
    const o = await manager.run({ ip, deadlineAtMs: deadline(5_000), observationRef: REF });
    expect(o).toEqual({ status: "unavailable", company: null, source: "none", reason: "internal_error" });
    expect(manager.activeCount()).toBe(0);
  });

  it("enforces capacity synchronously before forking", async () => {
    const { manager, logger } = setup();
    expect(manager.capacity()).toBe(3);
    const runs = [1, 2, 3].map(() => manager.run({ ip: "203.0.113.3", deadlineAtMs: deadline(1_000), observationRef: REF }));
    expect(manager.activeCount()).toBe(3);
    expect(() => manager.run({ ip: "203.0.113.1", deadlineAtMs: deadline(1_000), observationRef: REF })).toThrow(ChildManagerOverloadedError);
    expect(pidsOf(logger.entries)).toHaveLength(3);
    const outcomes = await Promise.all(runs);
    expect(outcomes.every((o) => o.reason === "deadline_exceeded")).toBe(true);
    expect(manager.activeCount()).toBe(0);
    // Capacity is available again.
    expect((await manager.run({ ip: "203.0.113.1", deadlineAtMs: deadline(5_000), observationRef: REF })).status).toBe("qualified");
  });

  it("shutdown kills stragglers, reaps them, and refuses new work", async () => {
    const { manager, logger } = setup();
    const runs = [manager.run({ ip: "203.0.113.3", deadlineAtMs: deadline(30_000), observationRef: REF }), manager.run({ ip: "203.0.113.9", deadlineAtMs: deadline(30_000), observationRef: REF })];
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await manager.shutdown(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(manager.activeCount()).toBe(0);
    for (const pid of pidsOf(logger.entries)) expect(isAlive(pid)).toBe(false);
    const outcomes = await Promise.all(runs);
    expect(outcomes.every((o) => o.status === "unavailable")).toBe(true);
    expect(() => manager.run({ ip: "203.0.113.1", deadlineAtMs: deadline(1_000), observationRef: REF })).toThrow(ChildManagerStoppedError);
  });

  it("missing child module (exit before result) resolves unavailable and frees capacity", async () => {
    const logger = createMemoryLogger();
    const manager = createChildManager({ config: makeConfig(), logger, childModulePath: "/nonexistent/child.js" });
    const o = await manager.run({ ip: "203.0.113.1", deadlineAtMs: deadline(5_000), observationRef: REF });
    expect(o).toEqual({ status: "unavailable", company: null, source: "none", reason: "internal_error" });
    expect(manager.activeCount()).toBe(0);
  });
});

describe("buildChildRuntimeConfig", () => {
  it("copies secrets and converts policy units", () => {
    const rc = buildChildRuntimeConfig(makeConfig({ TTL_QUALIFIED_S: "120", DENIED_DOMAINS: "Denied.Example", QUALIFIED_USAGE_TYPES: "com,org" }));
    expect(rc.ip_hmac_secret).toBe(SECRETS.IP_HMAC_SECRET);
    expect(rc.database_url).toBe(SECRETS.DATABASE_URL);
    expect(rc.database_ssl).toBe("require");
    expect(rc.provider).toMatchObject({ mode: "mock", api_key: SECRETS.ENRICH_API_KEY, auth_header: "x-api-key" });
    expect(rc.policy.ttl_qualified_ms).toBe(120_000);
    expect(rc.policy.denied_domains).toEqual(["denied.example"]);
    expect(rc.policy.qualified_usage_types).toEqual(["COM", "ORG"]);
  });

  it("disables the provider when the static kill switch is off", () => {
    expect(buildChildRuntimeConfig(makeConfig({ ENRICHMENT_ENABLED: "false" })).provider.mode).toBe("disabled");
  });
});

describe("sanitiseOutcome", () => {
  it("rebuilds an allowlisted copy and drops unknown keys", () => {
    const o = sanitiseOutcome({ status: "no_match", company: null, source: "cache", reason: "cache_fresh", extra: "203.0.113.1" });
    expect(o).toEqual({ status: "no_match", company: null, source: "cache", reason: "cache_fresh" });
  });
  it("rejects malformed shapes", () => {
    expect(sanitiseOutcome(null)).toBeNull();
    expect(sanitiseOutcome({ status: "qualified", company: null, source: "cache" })).toBeNull();
    expect(sanitiseOutcome({ status: "no_match", company: null, source: "elsewhere" })).toBeNull();
    expect(sanitiseOutcome({ status: "no_match", source: "cache" })).toBeNull();
  });
  const qualified = {
    status: "qualified",
    company: { domain: "example.com", organisation_name: "Example Ltd", qualification: { category: "COM", source: "provider_usage_type" }, resolved_at: "2026-10-26T00:00:00.000Z" },
    source: "provider",
  };
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
    expect(sanitiseOutcome({ status: "no_match", company: null, source: "cache", activity: { company_id: 42, previously_seen: true, recorded: true, observation_ref: REF } })).toBeNull();
  });
});
