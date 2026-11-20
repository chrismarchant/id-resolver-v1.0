/**
 * Runner of the watch-only source comparison (src/shadow/runner.ts) with fake
 * adapters, a fake IPNetDB and the in-memory counter store: per-day
 * deduplication and rollover, the dedup cap, quota denial (no request sent),
 * overload drops, the Enrich result timeout, drain, database slots, and log
 * hygiene (no address, fingerprint, domain or name in any log line).
 */
import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../../src/log/index.js";
import { createShadowRunner, SHADOW_DB_MAX_IN_FLIGHT, utcDay, type ShadowRunner, type ShadowRunnerOptions } from "../../src/shadow/runner.js";
import type { ApiSource, ApiSourceAdapter, ApiSourceOutcome, EnrichSummary, IpnetdbResult, ShadowMetric, ShadowScope } from "../../src/shadow/types.js";
import { FakeShadowRepository } from "../helpers/fakes.js";

const IP_A = "203.0.113.10";
const IP_B = "198.51.100.20";
const IP_C = "2001:db8::30";
const FP = (label: string) => Buffer.alloc(32, label.charCodeAt(0));
const DAY1 = new Date("2026-11-19T23:59:59Z");
const DAY2 = new Date("2026-11-20T00:00:01Z");

const BUSINESS: ApiSourceOutcome = {
  kind: "ok",
  signals: { companyName: "Example Corp Ltd", companyDomain: "example.com", companyType: "business", asnType: "isp", mobile: false, hosting: false, anonymous: false },
};
const QUALIFIED: EnrichSummary = { kind: "resolved", domain: "example.com", usageType: "COM", status: "qualified", organisationName: "Example Corp Ltd" };
const FOUND: IpnetdbResult = { verdict: "found", prefixEntity: "Example Corp Ltd", asEntity: "Example Transit Inc", asn: 64496 };

interface FakeAdapter extends ApiSourceAdapter {
  calls: string[];
  outcome: ApiSourceOutcome | "hang" | "throw";
  signals: AbortSignal[];
}

function adapter(source: ApiSource, outcome: FakeAdapter["outcome"] = BUSINESS): FakeAdapter {
  const a: FakeAdapter = {
    source,
    calls: [],
    signals: [],
    outcome,
    async lookup(ip, { signal }) {
      a.calls.push(ip);
      a.signals.push(signal);
      if (a.outcome === "throw") throw new Error(`boom ${ip}`);
      if (a.outcome === "hang") {
        return new Promise<ApiSourceOutcome>((resolve) => signal.addEventListener("abort", () => resolve({ kind: "timeout" })));
      }
      return a.outcome;
    },
  };
  return a;
}

function setup(overrides: Partial<ShadowRunnerOptions> = {}) {
  const repo = new FakeShadowRepository();
  const logger = createMemoryLogger("debug");
  const ipapi = adapter("ipapi");
  const iplocate = adapter("iplocate");
  const ipnetdbCalls: string[] = [];
  let clock = DAY1;
  const runner = createShadowRunner({
    scope: { installationId: "inst-test", websiteId: "site-test" },
    repo,
    logger,
    ipapi,
    iplocate,
    ipnetdb: {
      lookup(ip) {
        ipnetdbCalls.push(ip);
        return FOUND;
      },
    },
    limits: { ipapi: 100, iplocate: 100 },
    timeoutMs: 1_000,
    concurrency: 4,
    queueMax: 10,
    now: () => clock,
    dropFlushMs: 10,
    ...overrides,
  });
  return {
    repo,
    logger,
    ipapi,
    iplocate,
    ipnetdbCalls,
    runner,
    setClock: (d: Date) => {
      clock = d;
    },
  };
}

/** Waits until nothing is queued, running or unwritten (and drop counters had time to flush). */
async function settle(runner: ShadowRunner, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = runner.stats();
    if (s.queued === 0 && s.running === 0 && s.pending === 0) {
      await new Promise((r) => setTimeout(r, 20));
      const again = runner.stats();
      if (again.pending === 0 && again.queued === 0) return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("runner did not settle");
}

const day1 = utcDay(DAY1);
const day2 = utcDay(DAY2);

describe("shadow runner: one address", () => {
  it("asks every source once, waits for Enrich, writes the comparison for the UTC day in one call", async () => {
    const t = setup();
    const h = t.runner.observe(IP_A, FP("a"));
    expect(h).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    // Nothing is written until Enrich's result arrives.
    expect(t.repo.calls.increment).toBe(0);
    h!.complete(QUALIFIED);
    h!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.ipapi.calls).toEqual([IP_A]);
    expect(t.iplocate.calls).toEqual([IP_A]);
    expect(t.ipnetdbCalls).toEqual([IP_A]);
    expect(t.repo.calls.increment).toBe(1);
    expect(t.repo.day(day1)).toEqual({
      ipapi_requests: 1,
      iplocate_requests: 1,
      observed: 1,
      ipapi_business: 1,
      iplocate_business: 1,
      ipnetdb_found: 1,
      ipnetdb_corroborates: 1,
      enrich_resolved_business: 1,
      waterfall_high: 1,
      enrich_call_avoidable: 1,
      enrich_agrees: 1,
    });
    expect(t.logger.entries.find((e) => e["event"] === "shadow_observed")).toMatchObject({
      level: "debug",
      ipapi: "business",
      iplocate: "business",
      ipnetdb: "found",
      enrich: "resolved_business",
      waterfall: "high",
    });
  });

  it("unconfigured sources are disabled: no reservation, no request", async () => {
    const t = setup({ ipapi: undefined, iplocate: undefined, ipnetdb: undefined } as Partial<ShadowRunnerOptions>);
    const runner = createShadowRunner({
      scope: { installationId: "inst-test", websiteId: "site-test" },
      repo: t.repo,
      logger: t.logger,
      limits: { ipapi: 100, iplocate: 100 },
      timeoutMs: 1_000,
      concurrency: 1,
      queueMax: 1,
      now: () => DAY1,
    });
    runner.observe(IP_A, FP("a"))!.complete({ kind: "not_called", reason: "provider_disabled" });
    await settle(runner);
    expect(t.repo.calls.reserveSourceRequest).toBe(0);
    expect(t.repo.day(day1)).toEqual({
      observed: 1,
      ipapi_disabled: 1,
      iplocate_disabled: 1,
      ipnetdb_disabled: 1,
      enrich_not_called: 1,
      waterfall_no_data: 1,
      enrich_call_needed: 1,
    });
  });

  it("the hosting-range match from the pipeline is counted", async () => {
    const t = setup();
    t.runner.observe(IP_A, FP("a"), { hostingRangeMatched: true })!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.repo.get(day1, "hosting_range_matched")).toBe(1);
    expect(t.repo.get(day1, "waterfall_conflict")).toBe(1);
  });

  it("an adapter that throws or times out becomes error / timeout", async () => {
    const t = setup({ timeoutMs: 30 });
    t.ipapi.outcome = "throw";
    t.iplocate.outcome = "hang";
    t.runner.observe(IP_A, FP("a"))!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.repo.get(day1, "ipapi_error")).toBe(1);
    expect(t.repo.get(day1, "iplocate_timeout")).toBe(1);
    expect(t.iplocate.signals[0]!.aborted).toBe(true);
  });
});

describe("shadow runner: deduplication", () => {
  it("measures an address once per UTC day and counts repeats; a new day measures it again", async () => {
    const t = setup();
    t.runner.observe(IP_A, FP("a"))!.complete({ kind: "no_domain" });
    expect(t.runner.observe(IP_A, FP("a"))).toBeNull();
    expect(t.runner.observe(IP_A, FP("a").toString("hex"))).toBeNull();
    await settle(t.runner);
    expect(t.ipapi.calls).toHaveLength(1);
    expect(t.repo.get(day1, "observed")).toBe(1);
    expect(t.repo.get(day1, "dropped_duplicate")).toBe(2);

    t.setClock(DAY2);
    const h = t.runner.observe(IP_A, FP("a"));
    expect(h).not.toBeNull();
    h!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.ipapi.calls).toHaveLength(2);
    expect(t.repo.get(day2, "observed")).toBe(1);
    expect(t.repo.get(day1, "observed")).toBe(1);
  });

  it("copies the key: zeroing the fingerprint Buffer afterwards does not break deduplication", async () => {
    const t = setup();
    const fp = FP("z");
    t.runner.observe(IP_A, fp)!.complete({ kind: "no_domain" });
    fp.fill(0);
    expect(t.runner.observe(IP_A, FP("z"))).toBeNull();
    await settle(t.runner);
  });

  it("stops adding at the cap instead of growing; entries already held still deduplicate", async () => {
    const t = setup({ dedupMax: 2 });
    for (const k of ["a", "b", "c"]) t.runner.observe(IP_A, FP(k))!.complete({ kind: "no_domain" });
    expect(t.runner.stats().dedup).toBe(2);
    expect(t.runner.observe(IP_A, FP("a"))).toBeNull();
    const again = t.runner.observe(IP_A, FP("c"));
    expect(again).not.toBeNull();
    again!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.repo.get(day1, "observed")).toBe(4);
    expect(t.repo.get(day1, "dropped_duplicate")).toBe(1);
  });
});

describe("shadow runner: limits", () => {
  it("a source over its daily limit is not asked (verdict quota); a limit of 0 never asks", async () => {
    const t = setup({ limits: { ipapi: 1, iplocate: 0 } });
    for (const [ip, k] of [[IP_A, "a"], [IP_B, "b"], [IP_C, "c"]] as const) t.runner.observe(ip, FP(k))!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.ipapi.calls).toHaveLength(1);
    expect(t.iplocate.calls).toHaveLength(0);
    expect(t.repo.day(day1)).toMatchObject({ ipapi_requests: 1, ipapi_business: 1, ipapi_quota: 2, iplocate_quota: 3, observed: 3 });
    expect(t.repo.get(day1, "iplocate_requests")).toBe(0);
  });

  it("a failed quota reservation sends nothing and counts an error", async () => {
    const t = setup();
    t.repo.failures.reserveSourceRequest = true;
    t.runner.observe(IP_A, FP("a"))!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.ipapi.calls).toHaveLength(0);
    expect(t.repo.day(day1)).toMatchObject({ ipapi_error: 1, iplocate_error: 1 });
    expect(t.logger.entries.filter((e) => e["event"] === "shadow_write_failed")).toEqual([
      expect.objectContaining({ category: "quota_reservation" }),
      expect.objectContaining({ category: "quota_reservation" }),
    ]);
  });

  it("drops (and counts) addresses beyond the queue while the workers are busy", async () => {
    const t = setup({ concurrency: 1, queueMax: 1, timeoutMs: 60 });
    t.ipapi.outcome = "hang";
    const first = t.runner.observe(IP_A, FP("a"));
    const second = t.runner.observe(IP_B, FP("b"));
    const third = t.runner.observe(IP_C, FP("c"));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(t.runner.stats()).toMatchObject({ queued: 1, running: 1 });
    first!.complete({ kind: "no_domain" });
    second!.complete({ kind: "no_domain" });
    await settle(t.runner);
    expect(t.repo.day(day1)).toMatchObject({ observed: 2, dropped_overload: 1, ipapi_timeout: 2 });
    // A dropped address was not marked as seen: it is measured on its next visit.
    const later = t.runner.observe(IP_C, FP("c"));
    expect(later).not.toBeNull();
    later!.complete({ kind: "no_domain" });
    await settle(t.runner);
  });

  it(`never holds more than ${SHADOW_DB_MAX_IN_FLIGHT} database operations at once`, async () => {
    const t = setup({ concurrency: 8, queueMax: 50 });
    let active = 0;
    let max = 0;
    const repo = t.repo;
    const wrapped = {
      reserveSourceRequest: async (scope: ShadowScope, source: ApiSource, limit: number) => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return repo.reserveSourceRequest(scope, source, limit);
      },
      increment: async (scope: ShadowScope, metrics: readonly ShadowMetric[]) => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return repo.increment(scope, metrics);
      },
      report: repo.report.bind(repo),
    };
    const runner = createShadowRunner({
      scope: { installationId: "inst-test", websiteId: "site-test" },
      repo: wrapped,
      logger: t.logger,
      ipapi: t.ipapi,
      iplocate: t.iplocate,
      limits: { ipapi: 100, iplocate: 100 },
      timeoutMs: 1_000,
      concurrency: 8,
      queueMax: 50,
      now: () => DAY1,
    });
    for (let i = 0; i < 12; i += 1) runner.observe(`192.0.2.${i + 1}`, `key-${i}`)!.complete({ kind: "no_domain" });
    await settle(runner);
    expect(repo.get(day1, "observed")).toBe(12);
    expect(max).toBeLessThanOrEqual(SHADOW_DB_MAX_IN_FLIGHT);
    expect(max).toBe(SHADOW_DB_MAX_IN_FLIGHT);
  });
});

describe("shadow runner: Enrich result", () => {
  it("falls back to not_called/unknown when the pipeline never reports", async () => {
    const t = setup({ completeTimeoutMs: 40 });
    expect(t.runner.observe(IP_A, FP("a"))).not.toBeNull();
    await settle(t.runner);
    expect(t.repo.day(day1)).toMatchObject({ observed: 1, enrich_not_called: 1 });
    expect(t.logger.entries.find((e) => e["event"] === "shadow_observed")).toMatchObject({ enrich: "not_called" });
  });

  it("an Enrich result that arrives before the lookups finish is used", async () => {
    const t = setup({ concurrency: 1 });
    t.runner.observe(IP_A, FP("a"))!.complete({ kind: "error", category: "server" });
    t.runner.observe(IP_B, FP("b"))!.complete({ kind: "timeout" });
    await settle(t.runner);
    expect(t.repo.day(day1)).toMatchObject({ enrich_error: 1, enrich_timeout: 1, observed: 2 });
  });
});

describe("shadow runner: drain and hygiene", () => {
  it("drain completes queued work, answers comparisons still waiting with unknown, then refuses new addresses", async () => {
    const t = setup();
    t.runner.observe(IP_A, FP("a"));
    t.runner.observe(IP_B, FP("b"))!.complete({ kind: "no_domain" });
    const r = await t.runner.drain(2_000);
    expect(r).toEqual({ drained: true, pending: 0 });
    expect(t.repo.day(day1)).toMatchObject({ observed: 2, enrich_not_called: 1, enrich_no_domain: 1 });
    expect(t.runner.observe(IP_C, FP("c"))).toBeNull();
  });

  it("drain flushes drop counters at once", async () => {
    const t = setup({ dropFlushMs: 60_000 });
    t.runner.observe(IP_A, FP("a"))!.complete({ kind: "no_domain" });
    t.runner.observe(IP_A, FP("a"));
    await t.runner.drain(1_000);
    expect(t.repo.get(day1, "dropped_duplicate")).toBe(1);
  });

  it("a drain that runs out of time aborts the lookups in flight and starts nothing more", async () => {
    const t = setup({ concurrency: 1, queueMax: 5, timeoutMs: 5_000 });
    t.ipapi.outcome = "hang";
    t.runner.observe(IP_A, FP("a"))!.complete({ kind: "no_domain" });
    t.runner.observe(IP_B, FP("b"))!.complete({ kind: "no_domain" });
    await new Promise((r) => setTimeout(r, 10));
    const r = await t.runner.drain(20);
    expect(r.drained).toBe(false);
    expect(t.ipapi.signals[0]!.aborted).toBe(true);
    await new Promise((r2) => setTimeout(r2, 30));
    expect(t.ipapi.calls).toEqual([IP_A]);
    expect(t.runner.stats().queued).toBe(0);
  });

  it("observe never throws, even when the clock does", () => {
    const t = setup({
      now: () => {
        throw new Error("clock");
      },
    });
    expect(t.runner.observe(IP_A, FP("a"))).toBeNull();
  });

  it("never logs an address, a fingerprint, a domain or a name", async () => {
    const t = setup({ completeTimeoutMs: 30, timeoutMs: 30 });
    t.iplocate.outcome = "hang";
    t.runner.observe(IP_A, FP("a"))!.complete(QUALIFIED);
    t.runner.observe(IP_C, FP("c"))!.complete({ kind: "resolved", domain: "example.org", usageType: "COM", status: "qualified", organisationName: "Example Org" });
    t.runner.observe(IP_C, FP("c"));
    await settle(t.runner);
    t.repo.failures.increment = true;
    t.runner.observe(IP_B, FP("b"))!.complete(QUALIFIED);
    t.repo.failures.reserveSourceRequest = true;
    await settle(t.runner);
    const text = JSON.stringify(t.logger.entries);
    expect(t.logger.entries.some((e) => e["event"] === "shadow_observed")).toBe(true);
    expect(t.logger.entries.some((e) => e["event"] === "shadow_write_failed" && e["category"] === "counters")).toBe(true);
    for (const needle of [IP_A, IP_B, IP_C, "2001:db8", FP("a").toString("hex"), FP("c").toString("hex"), "example.com", "example.org", "Example Corp", "Example Org", "Example Transit"]) {
      expect(text, needle).not.toContain(needle);
    }
  });
});
