/**
 * Process-level crash containment of the single-process runtime (CHR-70),
 * exercised in real processes: an unhandled rejection, an uncaught exception
 * and a stuck job each log one fixed event and exit non-zero; a blocked event
 * loop is killed by the watchdog thread; a busy but yielding loop is not.
 * Fault messages carry an IP and a placeholder secret that must never appear.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FATAL_EXIT_CODE } from "../../src/runtime/process-guards.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const FIXTURE = resolve(ROOT, "test", "helpers", "process-fixture.ts");

function runFixture(mode: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; ms: number }> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, mode], { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("exit", (code, signal) => {
      clearTimeout(kill);
      done({ code, signal, output, ms: Date.now() - started });
    });
  });
}

const events = (output: string) =>
  output
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function expectNoLeak(output: string) {
  for (const needle of ["203.0.113.5", "sk_test_placeholder", "fault", "Error", "at "]) expect(output, needle).not.toContain(needle);
}

describe("process guards", () => {
  it.each([
    ["unhandled-rejection", "unhandled_rejection"],
    ["uncaught-exception", "uncaught_exception"],
    ["stuck-job", "job_stuck"],
  ])("%s -> one fixed process_fatal event, non-zero exit, no error text", async (mode, category) => {
    const r = await runFixture(mode);
    expect(r.code, r.output).toBe(FATAL_EXIT_CODE);
    const fatal = events(r.output).filter((e) => e["event"] === "process_fatal");
    expect(fatal).toEqual([expect.objectContaining({ level: "error", category })]);
    expectNoLeak(r.output);
  });

  it("a stuck job is logged as job_stuck before the fatal exit", async () => {
    const r = await runFixture("stuck-job");
    const names = events(r.output).map((e) => e["event"]);
    expect(names).toContain("job_timeout");
    expect(names.indexOf("job_stuck")).toBeLessThan(names.indexOf("process_fatal"));
  });
});

describe("event-loop watchdog", () => {
  it("kills a process whose event loop is blocked beyond the threshold (SIGKILL, fixed event, no core dump signal)", async () => {
    const r = await runFixture("blocked-loop");
    expect(r.signal, r.output).toBe("SIGKILL");
    expect(r.ms).toBeLessThan(5_000);
    const blocked = events(r.output).filter((e) => e["event"] === "event_loop_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!["duration_ms"]).toBeGreaterThan(400);
    expect(Object.keys(blocked[0]!).sort()).toEqual(["component", "duration_ms", "event", "level", "time"]);
  });

  it("does not fire for a busy loop that keeps yielding below the threshold", async () => {
    const r = await runFixture("healthy");
    expect(r.code, r.output).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.output).not.toContain("event_loop_blocked");
  });

  it("refuses a threshold that the heartbeat could not meet", async () => {
    const { startEventLoopWatchdog } = await import("../../src/runtime/watchdog.js");
    expect(() => startEventLoopWatchdog({ thresholdMs: 150 })).toThrow();
  });
});
