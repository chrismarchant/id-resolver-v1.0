/**
 * Kill-switch phase of the development smoke test (src/ops/smoke.ts, CHR-72):
 * engage the runtime kill switch, prove an uncached entrance answers
 * `disabled`, and put the switch back exactly as it was found.
 *
 * The switch is deployment_controls.enrichment_enabled for this installation
 * (absent row = enabled = released), written and read only through the
 * existing controls repository (src/db/controls-repo.ts), the same code the
 * ops:kill-switch command uses. The service reads it from the database on
 * EVERY cache miss (src/resolution/pipeline.ts step 4, and again inside the
 * usage reservation statement, src/db/usage-repo.ts); there is no in-process
 * copy, so KILL_SWITCH_CACHE_TTL_MS is 0 and a change applies to the next
 * cache miss. A cache hit is answered before the switch is consulted.
 *
 * Restore rules:
 *   - prior state RELEASED: the smoke engages it, and in a `finally` writes
 *     it back to released (the prior state) and reads it back, retrying a
 *     bounded number of times. It never writes released over a switch that
 *     was engaged before the run.
 *   - prior state ENGAGED: the smoke never writes it (the operator's reason
 *     stays as it was); it still probes, and afterwards only verifies that
 *     the switch still reads engaged.
 *   - prior state UNREADABLE: nothing is written and nothing is probed.
 * The restore counts as done only when a read-back equals the prior state;
 * otherwise it is "failed" and the suite exits 2.
 *
 * Every dependency is injected so the restore logic is unit tested with
 * fakes (test/unit/smoke-kill-switch.test.ts). Nothing here prints anything.
 */

export type KillSwitchState = "engaged" | "released";

/** The controls repository bound to this installation (true = enrichment enabled = switch released). */
export interface KillSwitchControls {
  isEnrichmentEnabled(): Promise<boolean>;
  setEnrichmentEnabled(enabled: boolean, reason: string): Promise<void>;
}

/** In-process cache TTL of the switch in the service: none (see the module comment). */
export const KILL_SWITCH_CACHE_TTL_MS = 0;
/** Upper bound on any propagation wait passed in, so the switch is never held engaged for long. */
export const MAX_PROPAGATION_WAIT_MS = 10_000;
/** Write-and-verify attempts for the restore, RESTORE_RETRY_DELAY_MS apart. */
export const RESTORE_ATTEMPTS = 3;
export const RESTORE_RETRY_DELAY_MS = 500;
/** Stored as deployment_controls.reason, so an operator can tell who last moved the switch. */
export const ENGAGE_REASON = "smoke test (CHR-72): engaged temporarily to verify the disabled outcome";
export const RESTORE_REASON = "smoke test (CHR-72): released again, as found before the run";

export type EngageOutcome =
  /** The switch was released; the smoke engaged it and read it back engaged. */
  | "engaged_by_smoke"
  /** The switch was already engaged before the run; the smoke did not write it. */
  | "already_engaged"
  /** The switch did not read back engaged (write or read failed): no probe was sent. */
  | "not_verified"
  /** The prior state could not be read: nothing was attempted. */
  | "not_attempted";

export type RestoreOutcome =
  /** Prior released: written back and read back released. */
  | "restored"
  /** Prior engaged: never written, still reads engaged. */
  | "left_engaged_as_found"
  /** Prior unreadable: nothing was written. */
  | "not_touched"
  /** The switch could not be verified to be in its prior state. Exit 2. */
  | "failed";

export type ProbeOutcome<P> = { kind: "result"; value: P } | { kind: "error" } | { kind: "not_run" };

export interface KillSwitchPhaseResult<P> {
  prior: KillSwitchState | "unreadable";
  engage: EngageOutcome;
  probe: ProbeOutcome<P>;
  restore: RestoreOutcome;
  /** The last state read back while restoring. */
  final: KillSwitchState | "unreadable" | "not_read";
}

export interface KillSwitchPhaseDeps<P> {
  controls: KillSwitchControls;
  /** Sends the probe entrance; called only while the switch reads engaged. */
  probe: () => Promise<P>;
  /** Wait between engaging and probing; clamped to [0, MAX_PROPAGATION_WAIT_MS]. Defaults to KILL_SWITCH_CACHE_TTL_MS. */
  propagationWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const stateOf = (enrichmentEnabled: boolean): KillSwitchState => (enrichmentEnabled ? "released" : "engaged");
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function boundedPropagationWait(ms: number | undefined): number {
  const v = ms ?? KILL_SWITCH_CACHE_TTL_MS;
  if (Number.isNaN(v) || v <= 0) return 0;
  return Math.min(Math.floor(v), MAX_PROPAGATION_WAIT_MS);
}

export async function runKillSwitchPhase<P>(deps: KillSwitchPhaseDeps<P>): Promise<KillSwitchPhaseResult<P>> {
  const sleep = deps.sleep ?? defaultSleep;
  const read = async (): Promise<KillSwitchState | "unreadable"> => {
    try {
      return stateOf(await deps.controls.isEnrichmentEnabled());
    } catch {
      return "unreadable";
    }
  };

  const prior = await read();
  if (prior === "unreadable") {
    // Without the prior state there is nothing safe to restore to: touch nothing.
    return { prior, engage: "not_attempted", probe: { kind: "not_run" }, restore: "not_touched", final: "not_read" };
  }

  let engage: EngageOutcome = "not_verified";
  let probe: ProbeOutcome<P> = { kind: "not_run" };
  let restored: { restore: RestoreOutcome; final: KillSwitchState | "unreadable" } | undefined;
  try {
    if (prior === "released") {
      try {
        await deps.controls.setEnrichmentEnabled(false, ENGAGE_REASON);
      } catch {
        // The write may still have committed (e.g. a timeout after COMMIT):
        // the read-back below decides, and the finally restores either way.
      }
    }
    if ((await read()) === "engaged") {
      engage = prior === "released" ? "engaged_by_smoke" : "already_engaged";
      const wait = boundedPropagationWait(deps.propagationWaitMs);
      if (wait > 0) await sleep(wait);
      try {
        probe = { kind: "result", value: await deps.probe() };
      } catch {
        probe = { kind: "error" };
      }
    }
  } catch {
    // Unreachable with the guarded calls above; kept so nothing escapes before the restore.
    probe = probe.kind === "not_run" ? { kind: "error" } : probe;
  } finally {
    restored = await restorePrior(prior, deps.controls, read, sleep);
  }
  return { prior, engage, probe, restore: restored.restore, final: restored.final };
}

async function restorePrior(
  prior: KillSwitchState,
  controls: KillSwitchControls,
  read: () => Promise<KillSwitchState | "unreadable">,
  sleep: (ms: number) => Promise<void>,
): Promise<{ restore: RestoreOutcome; final: KillSwitchState | "unreadable" }> {
  if (prior === "engaged") {
    // Never written by the smoke: never force it off; only verify.
    const final = await read();
    return { restore: final === "engaged" ? "left_engaged_as_found" : "failed", final };
  }
  let final: KillSwitchState | "unreadable" = "unreadable";
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    try {
      await controls.setEnrichmentEnabled(true, RESTORE_REASON);
    } catch {
      // verified by the read-back
    }
    final = await read();
    if (final === "released") return { restore: "restored", final };
    if (attempt < RESTORE_ATTEMPTS) {
      try {
        await sleep(RESTORE_RETRY_DELAY_MS);
      } catch {
        // keep retrying
      }
    }
  }
  return { restore: "failed", final };
}

/** 0 pass, 1 a check failed, 2 the kill switch was not verifiably restored (or the run was interrupted while it was held). */
export function smokeExitCode(failedChecks: number, restore: RestoreOutcome | "not_run", interrupted = false): 0 | 1 | 2 {
  if (restore === "failed" || interrupted) return 2;
  return failedChecks === 0 ? 0 : 1;
}

/**
 * The stderr message for a failed restore. Enum values and command names
 * only: no URL, token, address or configuration value.
 */
export function restoreFailureMessage(prior: KillSwitchState, final: KillSwitchState | "unreadable" | "not_read"): string {
  if (prior === "released") {
    return [
      "smoke: KILL SWITCH RESTORE FAILED.",
      `The switch was released before this run; after ${RESTORE_ATTEMPTS} write-and-verify attempts it reads ${final}.`,
      "Enrichment may still be DISABLED for this installation: every cache miss answers disabled.",
      'Release it from this service now: node dist/ops/kill-switch.js off --reason "restore after failed smoke run",',
      "then confirm enrichment_enabled=true with node dist/ops/usage.js.",
    ].join(" ");
  }
  return [
    "smoke: KILL SWITCH STATE NOT AS FOUND.",
    `The switch was engaged before this run and the smoke never wrote it, but it now reads ${final}.`,
    "Someone else changed it during the run, or the database is unreachable.",
    "Check it with node dist/ops/usage.js; the smoke does not release or re-engage a switch it did not engage.",
  ].join(" ");
}
