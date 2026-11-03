/**
 * Gate 4 review G4-I7: the smoke summary counts skipped checks apart from
 * passed ones (passed + failed + skipped = checks), each check line says
 * which it was, and a skipped check is still never read as a failure (the
 * exit code is unchanged). src/ops/smoke-report.ts.
 */
import { describe, expect, it } from "vitest";
import { SmokeReport } from "../../src/ops/smoke-report.js";
import { smokeExitCode } from "../../src/ops/smoke-kill-switch.js";

function capture() {
  const lines: string[] = [];
  const report = new SmokeReport((l) => lines.push(l));
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { report, lines, parsed };
}

describe("smoke report", () => {
  it("counts passed, failed and skipped apart, and they add up to checks", () => {
    const { report } = capture();
    report.check("a", true, "status 200");
    report.check("b", false, "status 500");
    report.skip("c", "documentation ranges disabled");
    report.skip("d", "no RAILWAY_PUBLIC_DOMAIN");
    report.check("e", true, "ok");
    const c = report.counts();
    expect(c).toEqual({ checks: 5, passed: 2, failed: 1, skipped: 2 });
    expect(c.passed + c.failed + c.skipped).toBe(c.checks);
  });

  it("writes one JSON line per check with outcome; a skip says why and keeps pass:true (not a failure)", () => {
    const { report, lines, parsed } = capture();
    report.check("real", true, "status 200");
    report.check("broken", false, "status 401");
    report.skip("not run", "documentation ranges disabled");
    expect(lines.every((l) => l.endsWith("\n") && l.indexOf("\n") === l.length - 1)).toBe(true);
    expect(parsed()).toEqual([
      { event: "smoke_check", check: "real", outcome: "pass", pass: true, detail: "status 200" },
      { event: "smoke_check", check: "broken", outcome: "fail", pass: false, detail: "status 401" },
      { event: "smoke_check", check: "not run", outcome: "skipped", pass: true, detail: "skipped: documentation ranges disabled" },
    ]);
  });

  it("an all-skipped run is not a pass of anything, and the exit code is unchanged by skips", () => {
    const { report } = capture();
    report.skip("x", "why");
    report.skip("y", "why");
    expect(report.counts()).toEqual({ checks: 2, passed: 0, failed: 0, skipped: 2 });
    expect(smokeExitCode(report.counts().failed, "not_run")).toBe(0);
    report.check("z", false, "status 500");
    expect(smokeExitCode(report.counts().failed, "not_run")).toBe(1);
  });
});
