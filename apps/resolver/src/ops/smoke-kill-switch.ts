/**
 * Kill-switch phase of the development smoke test (src/ops/smoke.ts, CHR-72):
 * engage the runtime kill switch, prove an uncached entrance answers
 * `disabled`, and put the switch back exactly as it was found.
 *
 * The switch is deployment_controls.enrichment_enabled for this installation
 * (absent row = enabled = released). The service reads it from the database
 * on EVERY cache miss (src/resolution/pipeline.ts step 4, and again inside the
 * usage reservation statement, src/db/usage-repo.ts); there is no in-process
 * copy, so KILL_SWITCH_CACHE_TTL_MS is 0 and a change applies to the next
 * cache miss. A cache hit is answered before the switch is consulted.
 *
 * Ownership (Gate 4 review G4-L2, G4-L3). The smoke engages the switch with a
 * reason of its own that names the run (engageReason), and every write it
 * makes is conditional (src/ops/smoke-controls.ts):
 *   - engage only if the switch still reads released (one statement), so an
 *     engagement made by someone else between the read and the write is never
 *     overwritten;
 *   - restore is a compare-and-set: release only if the switch is still
 *     engaged with THIS run's reason. If someone else engaged or released it
 *     meanwhile, the smoke leaves it exactly as they set it and the run exits
 *     2 with a loud message (`changed_during_run`).
 *
 * Restore rules:
 *   - prior state RELEASED: the smoke engages it and, in a `finally`, releases
 *     its own engagement and reads it back, retrying a bounded number of
 *     times. It never writes released over a switch someone else engaged.
 *   - prior state ENGAGED by someone else: never written (their reason stays);
 *     still probed, and afterwards only verified to read engaged.
 *   - prior state ENGAGED with a smoke reason: an orphan of a run that was
 *     killed while it held the switch (SIGKILL, OOM, a lost container), or a
 *     smoke run in progress right now. Never written and never probed, and it
 *     is NOT "left as found": `orphan_left_engaged`, exit 2, with the release
 *     command. src/ops/smoke.ts also checks this before any other check.
 *   - prior state UNREADABLE: nothing is written and nothing is probed.
 * The restore counts as done only when a read-back shows the prior state;
 * otherwise it is "failed" and the suite exits 2.
 *
 * Signals: while the switch may be held, SIGINT, SIGTERM, SIGHUP (a dropped
 * terminal or SSH session) and SIGQUIT are deferred (deferSignals): noted,
 * the phase finishes (bounded) with its restore, and the run exits 2.
 * SIGKILL cannot be deferred; the orphan check of the next run reports what
 * it leaves behind.
 *
 * Every dependency is injected so the logic is unit tested with fakes
 * (test/unit/smoke-kill-switch.test.ts). Nothing here prints anything.
 */

export type KillSwitchState = "engaged" | "released";

/** The switch as stored: its state and the reason written with it (null for an absent row). */
export interface KillSwitchReading {
  state: KillSwitchState;
  reason: string | null;
}

/** Conditional access to this installation's switch (src/ops/smoke-controls.ts binds it to the database). */
export interface KillSwitchControls {
  read(): Promise<KillSwitchReading>;
  /** Engages with `reason` only if the switch reads released at that moment. true = this call engaged it. */
  engageIfReleased(reason: string): Promise<boolean>;
  /** Compare-and-set: releases with `restoreReason` only if engaged with exactly `engageReason`. true = this call released it. */
  releaseIfHeld(engageReason: string, restoreReason: string): Promise<boolean>;
}

/** In-process cache TTL of the switch in the service: none (see the module comment). */
export const KILL_SWITCH_CACHE_TTL_MS = 0;
/** Upper bound on any propagation wait passed in, so the switch is never held engaged for long. */
export const MAX_PROPAGATION_WAIT_MS = 10_000;
/** Release-and-verify attempts for the restore, RESTORE_RETRY_DELAY_MS apart. */
export const RESTORE_ATTEMPTS = 3;
export const RESTORE_RETRY_DELAY_MS = 500;

/**
 * Stored as deployment_controls.reason, so an operator (and the next run) can
 * tell who last moved the switch. The prefixes are fixed; the run id makes
 * each engagement this run's own. A switch engaged by the Gate 4 smoke (whose
 * reason was exactly the engage prefix) is recognised as a smoke engagement too.
 */
export const SMOKE_ENGAGE_REASON_PREFIX = "smoke test (CHR-72): engaged temporarily to verify the disabled outcome";
export const SMOKE_RESTORE_REASON_PREFIX = "smoke test (CHR-72): released again, as found before the run";
const RUN_ID = /^[0-9a-f]{1,32}$/;

export function engageReason(run: string): string {
  if (!RUN_ID.test(run)) throw new Error("engageReason needs a lowercase hex run id");
  return `${SMOKE_ENGAGE_REASON_PREFIX} [run ${run}]`;
}

export function restoreReason(run: string): string {
  if (!RUN_ID.test(run)) throw new Error("restoreReason needs a lowercase hex run id");
  return `${SMOKE_RESTORE_REASON_PREFIX} [run ${run}]`;
}

/** Engaged by a smoke run (this build's or the Gate 4 build's reason): never an operator's engagement. */
export function isSmokeEngagement(r: KillSwitchReading): boolean {
  return r.state === "engaged" && r.reason !== null && r.reason.startsWith(SMOKE_ENGAGE_REASON_PREFIX);
}

export type EngageOutcome =
  /** The switch was released; the smoke engaged it and read back its own engagement. */
  | "engaged_by_smoke"
  /** The switch was already engaged by someone else before the run; the smoke did not write it. */
  | "already_engaged"
  /** The switch was already engaged with a smoke reason (an orphan or a concurrent run): not written, no probe. */
  | "smoke_orphan"
  /** The smoke's own engagement did not read back (write refused, someone else engaged first, or a read failed): no probe. */
  | "not_verified"
  /** The prior state could not be read: nothing was attempted. */
  | "not_attempted";

export type RestoreOutcome =
  /** Prior released: the smoke released its own engagement (or never held one), and it reads released. */
  | "restored"
  /** Prior engaged by someone else: never written, still reads engaged. */
  | "left_engaged_as_found"
  /** Prior unreadable: nothing was written. */
  | "not_touched"
  /** Someone else engaged or released the switch while the smoke held it (or released one engaged before the run): left as they set it. Exit 2. */
  | "changed_during_run"
  /** Prior engaged with a smoke reason: an interrupted run left it engaged. Not written. Exit 2. */
  | "orphan_left_engaged"
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
  /** This run's id (lowercase hex); it makes the engage and restore reasons this run's own. */
  run: string;
  /** Sends the probe entrance; called only while the switch reads engaged. */
  probe: () => Promise<P>;
  /** Wait between engaging and probing; clamped to [0, MAX_PROPAGATION_WAIT_MS]. Defaults to KILL_SWITCH_CACHE_TTL_MS. */
  propagationWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function boundedPropagationWait(ms: number | undefined): number {
  const v = ms ?? KILL_SWITCH_CACHE_TTL_MS;
  if (Number.isNaN(v) || v <= 0) return 0;
  return Math.min(Math.floor(v), MAX_PROPAGATION_WAIT_MS);
}

export async function runKillSwitchPhase<P>(deps: KillSwitchPhaseDeps<P>): Promise<KillSwitchPhaseResult<P>> {
  const sleep = deps.sleep ?? defaultSleep;
  const mine = { engage: engageReason(deps.run), restore: restoreReason(deps.run) };
  const read = async (): Promise<KillSwitchReading | "unreadable"> => {
    try {
      return await deps.controls.read();
    } catch {
      return "unreadable";
    }
  };
  const probeOnce = async (): Promise<ProbeOutcome<P>> => {
    const wait = boundedPropagationWait(deps.propagationWaitMs);
    if (wait > 0) await sleep(wait);
    try {
      return { kind: "result", value: await deps.probe() };
    } catch {
      return { kind: "error" };
    }
  };

  const prior = await read();
  if (prior === "unreadable") {
    // Without the prior state there is nothing safe to restore to: touch nothing.
    return { prior, engage: "not_attempted", probe: { kind: "not_run" }, restore: "not_touched", final: "not_read" };
  }

  if (prior.state === "engaged") {
    if (isSmokeEngagement(prior)) {
      // Left by an interrupted run (or held by a concurrent one): not ours to release, and not "as found".
      return { prior: "engaged", engage: "smoke_orphan", probe: { kind: "not_run" }, restore: "orphan_left_engaged", final: "engaged" };
    }
    // Engaged by someone else: never written by the smoke; probe, then only verify.
    const probe = await probeOnce();
    const now = await read();
    if (now === "unreadable") return { prior: "engaged", engage: "already_engaged", probe, restore: "failed", final: "unreadable" };
    return { prior: "engaged", engage: "already_engaged", probe, restore: now.state === "engaged" ? "left_engaged_as_found" : "changed_during_run", final: now.state };
  }

  let engage: EngageOutcome = "not_verified";
  let probe: ProbeOutcome<P> = { kind: "not_run" };
  let restored: { restore: RestoreOutcome; final: KillSwitchState | "unreadable" } | undefined;
  try {
    try {
      await deps.controls.engageIfReleased(mine.engage);
    } catch {
      // The write may still have committed (e.g. a timeout after COMMIT):
      // the read-back below decides, and the finally restores either way.
    }
    const now = await read();
    if (now !== "unreadable" && now.state === "engaged" && now.reason === mine.engage) {
      engage = "engaged_by_smoke";
      probe = await probeOnce();
    }
  } catch {
    // Unreachable with the guarded calls above; kept so nothing escapes before the restore.
    probe = probe.kind === "not_run" ? { kind: "error" } : probe;
  } finally {
    restored = await releaseOwnEngagement(deps.controls, mine, engage === "engaged_by_smoke", read, sleep);
  }
  return { prior: "released", engage, probe, restore: restored.restore, final: restored.final };
}

/**
 * Prior state released: undo the smoke's own engagement, and only that.
 * `held` = the smoke read back its own engagement before probing.
 */
async function releaseOwnEngagement(
  controls: KillSwitchControls,
  mine: { engage: string; restore: string },
  held: boolean,
  read: () => Promise<KillSwitchReading | "unreadable">,
  sleep: (ms: number) => Promise<void>,
): Promise<{ restore: RestoreOutcome; final: KillSwitchState | "unreadable" }> {
  let final: KillSwitchState | "unreadable" = "unreadable";
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    let releasedNow = false;
    try {
      releasedNow = await controls.releaseIfHeld(mine.engage, mine.restore);
    } catch {
      // The release may still have committed: the read-back decides.
    }
    const now = await read();
    if (now !== "unreadable") {
      final = now.state;
      if (now.state === "released") {
        // Released by this run (now, or by an attempt whose answer was lost), or never engaged by it.
        if (releasedNow || now.reason === mine.restore || !held) return { restore: "restored", final };
        // The smoke held it, and someone else released it meanwhile: it reads as found, but not by the smoke's hand.
        return { restore: "changed_during_run", final };
      }
      // Engaged with someone else's reason: theirs now. Leave it exactly as it is.
      if (now.reason !== mine.engage) return { restore: "changed_during_run", final };
      // Still the smoke's own engagement: the release did not apply. Retry.
    }
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

/** Restore outcomes that leave the run at exit 2: the switch is not verifiably as it was found by this run's own hand. */
const EXIT_2_RESTORES: ReadonlySet<RestoreOutcome | "not_run"> = new Set(["failed", "changed_during_run", "orphan_left_engaged"]);

/** 0 pass, 1 a check failed, 2 the kill switch is not verifiably as found (or the run was interrupted while it was held). */
export function smokeExitCode(failedChecks: number, restore: RestoreOutcome | "not_run", interrupted = false): 0 | 1 | 2 {
  if (EXIT_2_RESTORES.has(restore) || interrupted) return 2;
  return failedChecks === 0 ? 0 : 1;
}

/** Signals deferred while the switch may be held (SIGKILL and SIGSTOP cannot be caught). */
export const DEFERRED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
export type DeferredSignal = (typeof DEFERRED_SIGNALS)[number];

/**
 * Replaces the default action (terminate) of every DEFERRED_SIGNALS signal
 * with `onSignal` until the returned function is called.
 */
export function deferSignals(onSignal: (signal: DeferredSignal) => void, proc: Pick<NodeJS.Process, "on" | "off"> = process): () => void {
  const handlers = DEFERRED_SIGNALS.map((s) => [s, () => onSignal(s)] as const);
  for (const [s, h] of handlers) proc.on(s, h);
  return () => {
    for (const [s, h] of handlers) proc.off(s, h);
  };
}

/** An operator's release reason never starts with the smoke prefix, so a later run reads it as an ordinary released switch. */
const RELEASE_COMMAND = 'node dist/ops/kill-switch.js off --reason "released by an operator after a smoke run"';

/** The stderr message for a switch left engaged by an earlier smoke run. Fixed text: no reason, URL, token or address. */
export const ORPHAN_MESSAGE = [
  "smoke: KILL SWITCH LEFT ENGAGED BY AN EARLIER SMOKE RUN.",
  "The switch reads engaged with the smoke test's own reason: a run was killed while it held the switch (SIGKILL, OOM, a lost container),",
  "or another smoke run is holding it right now.",
  "Enrichment is DISABLED for this installation: every cache miss answers disabled. The smoke does not release it and does not count it as left as found.",
  `If no other smoke run is in progress, release it from this service: ${RELEASE_COMMAND},`,
  "confirm enrichment_enabled=true with node dist/ops/usage.js, then run the smoke again.",
].join(" ");

/**
 * The stderr message for a restore outcome that exits 2, or undefined.
 * Enum values and command names only: no reason text, URL, token, address or
 * configuration value.
 */
export function killSwitchAlert(prior: KillSwitchState | "unreadable", restore: RestoreOutcome, final: KillSwitchState | "unreadable" | "not_read"): string | undefined {
  if (restore === "orphan_left_engaged") return ORPHAN_MESSAGE;
  if (restore === "changed_during_run") {
    if (prior === "released" && final === "engaged") {
      return [
        "smoke: KILL SWITCH CHANGED BY SOMEONE ELSE DURING THE RUN.",
        "The smoke engaged it for the probe; at restore it was engaged with another reason (an operator engaged it meanwhile).",
        "The smoke did NOT release it: it is left engaged exactly as they set it, and every cache miss answers disabled.",
        "Check it with node dist/ops/usage.js and release it only when that engagement is over.",
      ].join(" ");
    }
    if (prior === "released") {
      return [
        "smoke: KILL SWITCH CHANGED BY SOMEONE ELSE DURING THE RUN.",
        "The smoke engaged it for the probe; at restore someone else had already released it. The smoke wrote nothing more.",
        `It now reads ${final}; check it with node dist/ops/usage.js.`,
      ].join(" ");
    }
    return [
      "smoke: KILL SWITCH STATE NOT AS FOUND.",
      `The switch was engaged before this run and the smoke never wrote it, but it now reads ${final}: someone else changed it during the run.`,
      "Check it with node dist/ops/usage.js; the smoke does not release or re-engage a switch it did not engage.",
    ].join(" ");
  }
  if (restore !== "failed") return undefined;
  if (prior === "released") {
    return [
      "smoke: KILL SWITCH RESTORE FAILED.",
      `The switch was released before this run; after ${RESTORE_ATTEMPTS} release-and-verify attempts it reads ${final}.`,
      "Enrichment may still be DISABLED for this installation: every cache miss answers disabled.",
      `Release it from this service now: ${RELEASE_COMMAND},`,
      "then confirm enrichment_enabled=true with node dist/ops/usage.js.",
    ].join(" ");
  }
  return [
    "smoke: KILL SWITCH STATE NOT AS FOUND.",
    `The switch was engaged before this run and the smoke never wrote it, but it now reads ${final}.`,
    "The database may be unreachable. Check it with node dist/ops/usage.js; the smoke does not release or re-engage a switch it did not engage.",
  ].join(" ");
}
