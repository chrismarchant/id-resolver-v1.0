/**
 * Check reporting for the development smoke test (src/ops/smoke.ts).
 *
 * Every check is one JSON line on stdout:
 *   {"event":"smoke_check","check":"...","outcome":"pass|fail|skipped","pass":bool,"detail":"..."}
 * `outcome` tells a real assertion that held (`pass`) from one that did not
 * run (`skipped`, detail "skipped: <why>"). `pass` keeps its earlier meaning,
 * "did not fail", so a skipped check is never read as a failure and the exit
 * code is unchanged (Gate 4 review G4-I7).
 *
 * The summary counts the three apart, so `passed + failed + skipped = checks`
 * and `passed` counts only assertions that actually ran.
 *
 * Details are statuses, enums and counts only: never a token, address, body,
 * event_id, page_key or configuration value.
 */

export type CheckOutcome = "pass" | "fail" | "skipped";

export interface CheckResult {
  check: string;
  outcome: CheckOutcome;
  detail: string;
}

export interface CheckCounts {
  checks: number;
  passed: number;
  failed: number;
  skipped: number;
}

export const SKIPPED_PREFIX = "skipped: ";

export class SmokeReport {
  readonly results: CheckResult[] = [];

  constructor(private readonly write: (line: string) => void) {}

  /** A real assertion: `ok` decides pass or fail. */
  check(check: string, ok: boolean, detail: string): void {
    this.emit({ check, outcome: ok ? "pass" : "fail", detail });
  }

  /** A check that did not run, with the reason (an enum-like phrase, never a value). */
  skip(check: string, why: string): void {
    this.emit({ check, outcome: "skipped", detail: `${SKIPPED_PREFIX}${why}` });
  }

  counts(): CheckCounts {
    const n = (o: CheckOutcome) => this.results.filter((r) => r.outcome === o).length;
    return { checks: this.results.length, passed: n("pass"), failed: n("fail"), skipped: n("skipped") };
  }

  private emit(r: CheckResult): void {
    this.results.push(r);
    this.write(`${JSON.stringify({ event: "smoke_check", check: r.check, outcome: r.outcome, pass: r.outcome !== "fail", detail: r.detail })}\n`);
  }
}
