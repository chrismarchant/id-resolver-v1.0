/**
 * CHR-72: the smoke test's kill-switch phase (src/ops/smoke-kill-switch.ts)
 * with fake controls: it always puts the switch back as it was found, never
 * writes a switch that was already engaged, probes only while the switch
 * reads engaged, and reports a restore it could not verify as "failed"
 * (exit 2).
 */
import { describe, expect, it } from "vitest";
import {
  boundedPropagationWait,
  ENGAGE_REASON,
  KILL_SWITCH_CACHE_TTL_MS,
  MAX_PROPAGATION_WAIT_MS,
  restoreFailureMessage,
  RESTORE_ATTEMPTS,
  RESTORE_REASON,
  RESTORE_RETRY_DELAY_MS,
  runKillSwitchPhase,
  smokeExitCode,
  type KillSwitchControls,
} from "../../src/ops/smoke-kill-switch.js";

/** An in-memory switch (true = enrichment enabled = released) with scriptable failures. */
class FakeControls implements KillSwitchControls {
  enabled: boolean;
  writes: { enabled: boolean; reason: string }[] = [];
  reads = 0;
  /** Per-call write behaviour: "ok", "throw" (nothing committed) or "commit_then_throw". */
  writePlan: ("ok" | "throw" | "commit_then_throw")[] = [];
  /** Throw on the n-th read (1-based), or on every read from `readFailFrom` on. */
  readFailAt = new Set<number>();
  readFailFrom = Infinity;
  constructor(enabled: boolean) {
    this.enabled = enabled;
  }
  async isEnrichmentEnabled(): Promise<boolean> {
    this.reads += 1;
    if (this.readFailAt.has(this.reads) || this.reads >= this.readFailFrom) throw new Error("db down");
    return this.enabled;
  }
  async setEnrichmentEnabled(enabled: boolean, reason: string): Promise<void> {
    const plan = this.writePlan.shift() ?? "ok";
    this.writes.push({ enabled, reason });
    if (plan === "throw") throw new Error("write failed");
    this.enabled = enabled;
    if (plan === "commit_then_throw") throw new Error("timeout after commit");
  }
}

const DISABLED = { status: 200, body: { version: "1", status: "disabled", source: "none", recorded: false } };

function harness(controls: FakeControls, opts: { probeThrows?: boolean; propagationWaitMs?: number } = {}) {
  const sleeps: number[] = [];
  const probeSaw: boolean[] = [];
  const events: string[] = [];
  const deps = {
    controls,
    probe: async () => {
      probeSaw.push(controls.enabled);
      events.push("probe");
      if (opts.probeThrows) throw new Error("fetch failed");
      return DISABLED;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      events.push(`sleep:${ms}`);
    },
    ...(opts.propagationWaitMs !== undefined ? { propagationWaitMs: opts.propagationWaitMs } : {}),
  };
  return { deps, sleeps, probeSaw, events };
}

describe("smoke kill-switch phase", () => {
  it("prior released: engages, probes while engaged, writes released back and verifies it", async () => {
    const c = new FakeControls(true);
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toEqual({ prior: "released", engage: "engaged_by_smoke", probe: { kind: "result", value: DISABLED }, restore: "restored", final: "released" });
    expect(h.probeSaw).toEqual([false]);
    expect(c.writes).toEqual([
      { enabled: false, reason: ENGAGE_REASON },
      { enabled: true, reason: RESTORE_REASON },
    ]);
    expect(c.enabled).toBe(true);
    expect(smokeExitCode(0, r.restore)).toBe(0);
  });

  it("prior engaged: never writes the switch, still probes, and leaves it engaged", async () => {
    const c = new FakeControls(false);
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toEqual({ prior: "engaged", engage: "already_engaged", probe: { kind: "result", value: DISABLED }, restore: "left_engaged_as_found", final: "engaged" });
    expect(c.writes).toEqual([]);
    expect(h.probeSaw).toEqual([false]);
    expect(c.enabled).toBe(false);
    expect(smokeExitCode(0, r.restore)).toBe(0);
  });

  it("prior unreadable: touches nothing and probes nothing", async () => {
    const c = new FakeControls(true);
    c.readFailAt.add(1);
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toEqual({ prior: "unreadable", engage: "not_attempted", probe: { kind: "not_run" }, restore: "not_touched", final: "not_read" });
    expect(c.writes).toEqual([]);
    expect(h.probeSaw).toEqual([]);
    // The prior-state check fails (exit 1), but nothing was left changed (not exit 2).
    expect(smokeExitCode(1, r.restore)).toBe(1);
  });

  it("an engage write that fails without committing: no probe, and the switch is still verified released", async () => {
    const c = new FakeControls(true);
    c.writePlan = ["throw"];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "not_verified", probe: { kind: "not_run" }, restore: "restored", final: "released" });
    expect(h.probeSaw).toEqual([]);
    expect(c.enabled).toBe(true);
  });

  it("an engage write that commits and then throws: the read-back decides, the probe runs and the switch is restored", async () => {
    const c = new FakeControls(true);
    c.writePlan = ["commit_then_throw"];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", probe: { kind: "result" }, restore: "restored", final: "released" });
    expect(h.probeSaw).toEqual([false]);
    expect(c.enabled).toBe(true);
  });

  it("a failing engage read-back: no probe, restore still runs", async () => {
    const c = new FakeControls(true);
    c.readFailAt.add(2); // 1 = prior, 2 = engage read-back
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "not_verified", probe: { kind: "not_run" }, restore: "restored", final: "released" });
    expect(c.enabled).toBe(true);
  });

  it("a probe that throws is reported as an error, and the switch is still restored", async () => {
    const c = new FakeControls(true);
    const h = harness(c, { probeThrows: true });
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", probe: { kind: "error" }, restore: "restored", final: "released" });
    expect(c.enabled).toBe(true);
  });

  it("a restore write that fails once is retried after a delay and then verified", async () => {
    const c = new FakeControls(true);
    c.writePlan = ["ok", "throw", "ok"];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ restore: "restored", final: "released" });
    expect(h.sleeps).toEqual([RESTORE_RETRY_DELAY_MS]);
    expect(c.writes.map((w) => w.enabled)).toEqual([false, true, true]);
  });

  it("a restore that keeps failing: bounded attempts, reported failed with the state read back -> exit 2", async () => {
    const c = new FakeControls(true);
    c.writePlan = ["ok", ...Array.from({ length: RESTORE_ATTEMPTS }, () => "throw" as const)];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", restore: "failed", final: "engaged" });
    expect(c.writes.filter((w) => w.reason === RESTORE_REASON)).toHaveLength(RESTORE_ATTEMPTS);
    expect(h.sleeps).toEqual(Array.from({ length: RESTORE_ATTEMPTS - 1 }, () => RESTORE_RETRY_DELAY_MS));
    expect(smokeExitCode(0, r.restore)).toBe(2);
    expect(smokeExitCode(5, r.restore)).toBe(2);
  });

  it("a restore whose write lands but cannot be read back counts as failed (unverified) -> exit 2", async () => {
    const c = new FakeControls(true);
    c.readFailFrom = 3; // 1 = prior, 2 = engage read-back, 3.. = restore read-backs
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ restore: "failed", final: "unreadable" });
    expect(c.enabled).toBe(true);
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("prior engaged but released by someone else during the run: reported failed, and the smoke still never writes", async () => {
    const c = new FakeControls(false);
    const h = harness(c);
    h.deps.probe = async () => {
      c.enabled = true; // an operator releases the switch mid-run
      return DISABLED;
    };
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "engaged", restore: "failed", final: "released" });
    expect(c.writes).toEqual([]);
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("waits out the in-process cache TTL (none in the service) before probing, bounded", async () => {
    expect(KILL_SWITCH_CACHE_TTL_MS).toBe(0);
    let h = harness(new FakeControls(true));
    await runKillSwitchPhase(h.deps);
    expect(h.sleeps).toEqual([]);

    h = harness(new FakeControls(true), { propagationWaitMs: 250 });
    await runKillSwitchPhase(h.deps);
    expect(h.events).toEqual(["sleep:250", "probe"]);

    h = harness(new FakeControls(true), { propagationWaitMs: 10 * MAX_PROPAGATION_WAIT_MS });
    await runKillSwitchPhase(h.deps);
    expect(h.events).toEqual([`sleep:${MAX_PROPAGATION_WAIT_MS}`, "probe"]);

    expect(boundedPropagationWait(undefined)).toBe(0);
    expect(boundedPropagationWait(-5)).toBe(0);
    expect(boundedPropagationWait(Number.NaN)).toBe(0);
    expect(boundedPropagationWait(Number.POSITIVE_INFINITY)).toBe(MAX_PROPAGATION_WAIT_MS);
    expect(boundedPropagationWait(12.7)).toBe(12);
  });
});

describe("smoke exit code and restore message", () => {
  it("0 pass, 1 a failed check, 2 a failed restore or an interruption", () => {
    expect(smokeExitCode(0, "not_run")).toBe(0);
    expect(smokeExitCode(0, "restored")).toBe(0);
    expect(smokeExitCode(0, "left_engaged_as_found")).toBe(0);
    expect(smokeExitCode(1, "restored")).toBe(1);
    expect(smokeExitCode(1, "not_touched")).toBe(1);
    expect(smokeExitCode(0, "failed")).toBe(2);
    expect(smokeExitCode(0, "restored", true)).toBe(2);
  });

  it("the failure message is loud, names states and commands only, and carries no address, URL or token", () => {
    const released = restoreFailureMessage("released", "engaged");
    expect(released).toContain("KILL SWITCH RESTORE FAILED");
    expect(released).toContain("reads engaged");
    expect(released).toContain("node dist/ops/kill-switch.js off");
    const engaged = restoreFailureMessage("engaged", "released");
    expect(engaged).toContain("KILL SWITCH STATE NOT AS FOUND");
    expect(engaged).toContain("never wrote it");
    for (const m of [released, engaged, restoreFailureMessage("released", "unreadable")]) {
      expect(m).not.toMatch(/\d+\.\d+\.\d+\.\d+|::|https?:\/\/|postgres|Bearer/);
      expect(m.split("\n")).toHaveLength(1);
    }
  });
});
