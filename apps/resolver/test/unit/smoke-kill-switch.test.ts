/**
 * CHR-72 / Gate 5: the smoke test's kill-switch phase
 * (src/ops/smoke-kill-switch.ts) with fake controls. It always puts the
 * switch back as it was found, by its own hand only: it engages only a
 * released switch, releases only its own engagement (compare-and-set, Gate 4
 * review G4-L3), never touches a switch engaged by someone else, refuses an
 * orphan left by an interrupted smoke run (G4-L2), probes only while it
 * holds the switch, and reports anything it could not verify with exit 2.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  boundedPropagationWait,
  DEFERRED_SIGNALS,
  deferSignals,
  engageReason,
  isSmokeEngagement,
  KILL_SWITCH_CACHE_TTL_MS,
  killSwitchAlert,
  MAX_PROPAGATION_WAIT_MS,
  ORPHAN_MESSAGE,
  RESTORE_ATTEMPTS,
  RESTORE_RETRY_DELAY_MS,
  restoreReason,
  runKillSwitchPhase,
  SMOKE_ENGAGE_REASON_PREFIX,
  smokeExitCode,
  type KillSwitchControls,
  type KillSwitchReading,
  type RestoreOutcome,
} from "../../src/ops/smoke-kill-switch.js";

const RUN = "0a1b2c3d4e";
const MINE = { engage: engageReason(RUN), restore: restoreReason(RUN) };
/** The exact reason the Gate 4 smoke wrote (no run id). */
const GATE4_ENGAGE_REASON = "smoke test (CHR-72): engaged temporarily to verify the disabled outcome";

type WritePlan = "ok" | "throw" | "commit_then_throw";

/** An in-memory switch row (absent = released) with scriptable failures and the same conditional semantics as src/ops/smoke-controls.ts. */
class FakeControls implements KillSwitchControls {
  row: { enabled: boolean; reason: string | null } | undefined;
  writes: { op: "engage" | "release"; reason: string; applied: boolean }[] = [];
  reads = 0;
  writePlan: WritePlan[] = [];
  readFailAt = new Set<number>();
  readFailFrom = Infinity;
  constructor(row?: { enabled: boolean; reason: string | null }) {
    this.row = row;
  }
  get state(): KillSwitchReading {
    return { state: this.row && !this.row.enabled ? "engaged" : "released", reason: this.row?.reason ?? null };
  }
  async read(): Promise<KillSwitchReading> {
    this.reads += 1;
    if (this.readFailAt.has(this.reads) || this.reads >= this.readFailFrom) throw new Error("db down");
    return this.state;
  }
  private write(op: "engage" | "release", reason: string, condition: () => boolean, apply: () => void): boolean {
    const plan = this.writePlan.shift() ?? "ok";
    if (plan === "throw") {
      this.writes.push({ op, reason, applied: false });
      throw new Error("write failed");
    }
    const applied = condition();
    if (applied) apply();
    this.writes.push({ op, reason, applied });
    if (plan === "commit_then_throw") throw new Error("timeout after commit");
    return applied;
  }
  async engageIfReleased(reason: string): Promise<boolean> {
    return this.write("engage", reason, () => this.row === undefined || this.row.enabled, () => (this.row = { enabled: false, reason }));
  }
  async releaseIfHeld(engage: string, restore: string): Promise<boolean> {
    return this.write("release", restore, () => this.row !== undefined && !this.row.enabled && this.row.reason === engage, () => (this.row = { enabled: true, reason: restore }));
  }
}

const DISABLED = { status: 200, body: { version: "1", status: "disabled", source: "none", recorded: false } };

function harness(controls: FakeControls, opts: { probe?: () => Promise<typeof DISABLED>; propagationWaitMs?: number } = {}) {
  const sleeps: number[] = [];
  const probeSaw: KillSwitchReading[] = [];
  const events: string[] = [];
  const deps = {
    controls,
    run: RUN,
    probe: async () => {
      probeSaw.push(controls.state);
      events.push("probe");
      return opts.probe ? opts.probe() : DISABLED;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      events.push(`sleep:${ms}`);
    },
    ...(opts.propagationWaitMs !== undefined ? { propagationWaitMs: opts.propagationWaitMs } : {}),
  };
  return { deps, sleeps, probeSaw, events };
}

describe("smoke kill-switch reasons", () => {
  it("engage and restore reasons are fixed prefixes plus this run's id; a smoke engagement is recognised by its prefix, also the Gate 4 one", () => {
    expect(MINE.engage).toBe(`${SMOKE_ENGAGE_REASON_PREFIX} [run ${RUN}]`);
    expect(MINE.restore.startsWith("smoke test (CHR-72): released again")).toBe(true);
    expect(engageReason("ffff")).not.toBe(MINE.engage);
    expect(isSmokeEngagement({ state: "engaged", reason: MINE.engage })).toBe(true);
    expect(isSmokeEngagement({ state: "engaged", reason: GATE4_ENGAGE_REASON })).toBe(true);
    expect(isSmokeEngagement({ state: "engaged", reason: "operator: incident" })).toBe(false);
    expect(isSmokeEngagement({ state: "engaged", reason: null })).toBe(false);
    expect(isSmokeEngagement({ state: "released", reason: MINE.engage })).toBe(false);
    expect(isSmokeEngagement({ state: "engaged", reason: MINE.restore })).toBe(false);
    for (const bad of ["", "ABC", "0a1b-2c", "x".repeat(10)]) expect(() => engageReason(bad), bad).toThrow();
  });
});

describe("smoke kill-switch phase", () => {
  it("prior released (no row): engages with this run's reason, probes while engaged, releases its own engagement and verifies it", async () => {
    const c = new FakeControls();
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toEqual({ prior: "released", engage: "engaged_by_smoke", probe: { kind: "result", value: DISABLED }, restore: "restored", final: "released" });
    expect(h.probeSaw).toEqual([{ state: "engaged", reason: MINE.engage }]);
    expect(c.writes).toEqual([
      { op: "engage", reason: MINE.engage, applied: true },
      { op: "release", reason: MINE.restore, applied: true },
    ]);
    expect(c.row).toEqual({ enabled: true, reason: MINE.restore });
    expect(smokeExitCode(0, r.restore)).toBe(0);
  });

  it("prior engaged by an operator: never writes the switch, still probes, and leaves it engaged (exit 0)", async () => {
    const c = new FakeControls({ enabled: false, reason: "operator: budget spike" });
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toEqual({ prior: "engaged", engage: "already_engaged", probe: { kind: "result", value: DISABLED }, restore: "left_engaged_as_found", final: "engaged" });
    expect(c.writes).toEqual([]);
    expect(c.row).toEqual({ enabled: false, reason: "operator: budget spike" });
    expect(smokeExitCode(0, r.restore)).toBe(0);
  });

  it("G4-L2: prior engaged with a smoke reason (an orphan of a killed run): not written, not probed, NOT left as found -> exit 2", async () => {
    for (const reason of [GATE4_ENGAGE_REASON, engageReason("deadbeef01"), MINE.engage]) {
      const c = new FakeControls({ enabled: false, reason });
      const h = harness(c);
      const r = await runKillSwitchPhase(h.deps);
      expect(r, reason).toEqual({ prior: "engaged", engage: "smoke_orphan", probe: { kind: "not_run" }, restore: "orphan_left_engaged", final: "engaged" });
      expect(c.writes).toEqual([]);
      expect(h.probeSaw).toEqual([]);
      expect(c.row).toEqual({ enabled: false, reason });
      expect(smokeExitCode(0, r.restore)).toBe(2);
      expect(killSwitchAlert(r.prior, r.restore, r.final)).toBe(ORPHAN_MESSAGE);
    }
  });

  it("G4-L3: an operator engages the switch while the smoke holds it: the restore leaves it engaged with the operator's reason -> exit 2", async () => {
    const c = new FakeControls();
    const h = harness(c, {
      probe: async () => {
        // An incident: the operator engages it (an unconditional upsert, like ops:kill-switch on).
        c.row = { enabled: false, reason: "operator: incident" };
        return DISABLED;
      },
    });
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", restore: "changed_during_run", final: "engaged" });
    expect(c.row).toEqual({ enabled: false, reason: "operator: incident" });
    // The one release attempt was a compare-and-set that did not apply.
    expect(c.writes.filter((w) => w.op === "release")).toEqual([{ op: "release", reason: MINE.restore, applied: false }]);
    expect(smokeExitCode(0, r.restore)).toBe(2);
    expect(killSwitchAlert(r.prior, r.restore, r.final)).toContain("CHANGED BY SOMEONE ELSE");
  });

  it("G4-L3: someone else releases the switch while the smoke holds it: the smoke writes nothing more -> exit 2", async () => {
    const c = new FakeControls();
    const h = harness(c, {
      probe: async () => {
        c.row = { enabled: true, reason: "operator: released early" };
        return DISABLED;
      },
    });
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", restore: "changed_during_run", final: "released" });
    expect(c.row).toEqual({ enabled: true, reason: "operator: released early" });
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("someone else engages the switch between the prior read and the engage: the engage does not apply, no probe, left as they set it -> exit 2", async () => {
    const c = new FakeControls({ enabled: true, reason: "test: released" });
    const h = harness(c);
    const engage = c.engageIfReleased.bind(c);
    // The operator acts right after the prior read, before the conditional engage.
    c.engageIfReleased = async (reason: string) => {
      c.row = { enabled: false, reason: "operator: incident" };
      return engage(reason);
    };
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "not_verified", probe: { kind: "not_run" }, restore: "changed_during_run", final: "engaged" });
    expect(c.writes.map((w) => [w.op, w.applied])).toEqual([
      ["engage", false],
      ["release", false],
    ]);
    expect(c.row).toEqual({ enabled: false, reason: "operator: incident" });
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("prior unreadable: touches nothing and probes nothing", async () => {
    const c = new FakeControls();
    c.readFailAt.add(1);
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toEqual({ prior: "unreadable", engage: "not_attempted", probe: { kind: "not_run" }, restore: "not_touched", final: "not_read" });
    expect(c.writes).toEqual([]);
    expect(h.probeSaw).toEqual([]);
    // The prior-state check fails (exit 1), but nothing was left changed (not exit 2).
    expect(smokeExitCode(1, r.restore)).toBe(1);
  });

  it("an engage write that fails without committing: no probe, and the switch is still verified released (exit 0)", async () => {
    const c = new FakeControls();
    c.writePlan = ["throw"];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "not_verified", probe: { kind: "not_run" }, restore: "restored", final: "released" });
    expect(h.probeSaw).toEqual([]);
    expect(c.row).toBeUndefined();
    expect(smokeExitCode(0, r.restore)).toBe(0);
  });

  it("an engage write that commits and then throws: the read-back decides, the probe runs and the switch is restored", async () => {
    const c = new FakeControls();
    c.writePlan = ["commit_then_throw"];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", probe: { kind: "result" }, restore: "restored", final: "released" });
    expect(c.row).toEqual({ enabled: true, reason: MINE.restore });
  });

  it("a failing engage read-back: no probe, and the restore still releases the smoke's own engagement", async () => {
    const c = new FakeControls();
    c.readFailAt.add(2); // 1 = prior, 2 = engage read-back
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "not_verified", probe: { kind: "not_run" }, restore: "restored", final: "released" });
    expect(c.row).toEqual({ enabled: true, reason: MINE.restore });
  });

  it("a probe that throws is reported as an error, and the switch is still restored", async () => {
    const c = new FakeControls();
    const h = harness(c, {
      probe: async () => {
        throw new Error("fetch failed");
      },
    });
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", probe: { kind: "error" }, restore: "restored", final: "released" });
    expect(c.row?.enabled).toBe(true);
  });

  it("a release that fails once is retried after a delay and then verified", async () => {
    const c = new FakeControls();
    c.writePlan = ["ok", "throw", "ok"];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ restore: "restored", final: "released" });
    expect(h.sleeps).toEqual([RESTORE_RETRY_DELAY_MS]);
    expect(c.writes.map((w) => w.op)).toEqual(["engage", "release", "release"]);
  });

  it("a release whose commit answer is lost is recognised by this run's restore reason (no false alarm)", async () => {
    const c = new FakeControls();
    c.writePlan = ["ok", "commit_then_throw"];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ restore: "restored", final: "released" });
    expect(c.writes.map((w) => w.op)).toEqual(["engage", "release"]);
  });

  it("a release that keeps failing: bounded attempts, reported failed with the state read back -> exit 2", async () => {
    const c = new FakeControls();
    c.writePlan = ["ok", ...Array.from({ length: RESTORE_ATTEMPTS }, () => "throw" as const)];
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "released", engage: "engaged_by_smoke", restore: "failed", final: "engaged" });
    expect(c.writes.filter((w) => w.op === "release")).toHaveLength(RESTORE_ATTEMPTS);
    expect(h.sleeps).toEqual(Array.from({ length: RESTORE_ATTEMPTS - 1 }, () => RESTORE_RETRY_DELAY_MS));
    expect(smokeExitCode(0, r.restore)).toBe(2);
    expect(smokeExitCode(5, r.restore)).toBe(2);
  });

  it("a release that lands but cannot be read back counts as failed (unverified) -> exit 2", async () => {
    const c = new FakeControls();
    c.readFailFrom = 3; // 1 = prior, 2 = engage read-back, 3.. = restore read-backs
    const h = harness(c);
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ restore: "failed", final: "unreadable" });
    expect(c.row).toEqual({ enabled: true, reason: MINE.restore });
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("prior engaged by an operator but released by someone during the run: changed_during_run, and the smoke still never writes -> exit 2", async () => {
    const c = new FakeControls({ enabled: false, reason: "operator: budget spike" });
    const h = harness(c, {
      probe: async () => {
        c.row = { enabled: true, reason: "operator: done" };
        return DISABLED;
      },
    });
    const r = await runKillSwitchPhase(h.deps);
    expect(r).toMatchObject({ prior: "engaged", restore: "changed_during_run", final: "released" });
    expect(c.writes).toEqual([]);
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("prior engaged by an operator and unreadable afterwards: failed -> exit 2", async () => {
    const c = new FakeControls({ enabled: false, reason: "operator: budget spike" });
    c.readFailAt.add(2);
    const r = await runKillSwitchPhase(harness(c).deps);
    expect(r).toMatchObject({ prior: "engaged", restore: "failed", final: "unreadable" });
    expect(smokeExitCode(0, r.restore)).toBe(2);
  });

  it("waits out the in-process cache TTL (none in the service) before probing, bounded", async () => {
    expect(KILL_SWITCH_CACHE_TTL_MS).toBe(0);
    let h = harness(new FakeControls());
    await runKillSwitchPhase(h.deps);
    expect(h.sleeps).toEqual([]);

    h = harness(new FakeControls(), { propagationWaitMs: 250 });
    await runKillSwitchPhase(h.deps);
    expect(h.events).toEqual(["sleep:250", "probe"]);

    h = harness(new FakeControls(), { propagationWaitMs: 10 * MAX_PROPAGATION_WAIT_MS });
    await runKillSwitchPhase(h.deps);
    expect(h.events).toEqual([`sleep:${MAX_PROPAGATION_WAIT_MS}`, "probe"]);

    expect(boundedPropagationWait(undefined)).toBe(0);
    expect(boundedPropagationWait(-5)).toBe(0);
    expect(boundedPropagationWait(Number.NaN)).toBe(0);
    expect(boundedPropagationWait(Number.POSITIVE_INFINITY)).toBe(MAX_PROPAGATION_WAIT_MS);
    expect(boundedPropagationWait(12.7)).toBe(12);
  });
});

describe("smoke signal deferral (G4-L2)", () => {
  it("defers SIGINT, SIGTERM, SIGHUP and SIGQUIT while installed, and removes every handler afterwards", () => {
    expect([...DEFERRED_SIGNALS].sort()).toEqual(["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]);
    const proc = new EventEmitter();
    const seen: string[] = [];
    const undefer = deferSignals((s) => seen.push(s), proc as unknown as Pick<NodeJS.Process, "on" | "off">);
    for (const s of DEFERRED_SIGNALS) expect(proc.listenerCount(s), s).toBe(1);
    proc.emit("SIGHUP");
    proc.emit("SIGQUIT");
    proc.emit("SIGTERM");
    expect(seen).toEqual(["SIGHUP", "SIGQUIT", "SIGTERM"]);
    undefer();
    for (const s of DEFERRED_SIGNALS) expect(proc.listenerCount(s), s).toBe(0);
  });
});

describe("smoke exit code and alerts", () => {
  it("0 pass, 1 a failed check, 2 a restore not verifiably by the smoke's own hand, an orphan, or an interruption", () => {
    expect(smokeExitCode(0, "not_run")).toBe(0);
    expect(smokeExitCode(0, "restored")).toBe(0);
    expect(smokeExitCode(0, "left_engaged_as_found")).toBe(0);
    expect(smokeExitCode(0, "not_touched")).toBe(0);
    expect(smokeExitCode(1, "restored")).toBe(1);
    expect(smokeExitCode(1, "not_touched")).toBe(1);
    for (const r of ["failed", "changed_during_run", "orphan_left_engaged"] as RestoreOutcome[]) expect(smokeExitCode(0, r), r).toBe(2);
    expect(smokeExitCode(0, "restored", true)).toBe(2);
  });

  it("every alert is loud, one line, names states and commands only, and carries no reason, address, URL or token", () => {
    expect(killSwitchAlert("released", "restored", "released")).toBeUndefined();
    expect(killSwitchAlert("engaged", "left_engaged_as_found", "engaged")).toBeUndefined();
    expect(killSwitchAlert("unreadable", "not_touched", "not_read")).toBeUndefined();
    const failed = killSwitchAlert("released", "failed", "engaged")!;
    expect(failed).toContain("KILL SWITCH RESTORE FAILED");
    expect(failed).toContain("reads engaged");
    expect(failed).toContain("node dist/ops/kill-switch.js off --reason");
    expect(killSwitchAlert("engaged", "failed", "unreadable")).toContain("KILL SWITCH STATE NOT AS FOUND");
    expect(killSwitchAlert("released", "changed_during_run", "engaged")).toContain("did NOT release it");
    expect(killSwitchAlert("released", "changed_during_run", "released")).toContain("already released it");
    expect(killSwitchAlert("engaged", "changed_during_run", "released")).toContain("never wrote it");
    expect(ORPHAN_MESSAGE).toContain("LEFT ENGAGED BY AN EARLIER SMOKE RUN");
    expect(ORPHAN_MESSAGE).toContain("node dist/ops/kill-switch.js off --reason");
    expect(ORPHAN_MESSAGE).toContain("does not count it as left as found");
    const all = [
      failed,
      ORPHAN_MESSAGE,
      killSwitchAlert("engaged", "failed", "unreadable")!,
      killSwitchAlert("released", "changed_during_run", "engaged")!,
      killSwitchAlert("released", "changed_during_run", "released")!,
      killSwitchAlert("engaged", "changed_during_run", "released")!,
      killSwitchAlert("released", "failed", "unreadable")!,
    ];
    for (const m of all) {
      expect(m).not.toMatch(/\d+\.\d+\.\d+\.\d+|::|https?:\/\/|postgres|Bearer|operator:|\[run /);
      expect(m.split("\n")).toHaveLength(1);
    }
  });
});
