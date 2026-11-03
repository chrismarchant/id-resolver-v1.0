import type { DeliveryResult, ResolvedDelivery } from "./config.js";
import { findBackground } from "./runtime.js";

export type DeliveryHook = (result: DeliveryResult) => void | Promise<void>;

/** Calls the hook without ever throwing; the returned promise (if any) is not awaited by the caller. */
export function fire(hook: DeliveryHook | undefined, result: DeliveryResult): Promise<void> {
  if (!hook) return Promise.resolve();
  try {
    return Promise.resolve(hook(result)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export const skipped = (reason: string, started: number): DeliveryResult => ({ outcome: "skipped", reason, mode: "none", attempts: 0, durationMs: Date.now() - started });

/** Per-instance count of deliveries in flight. */
export interface InFlight {
  n: number;
}

type Send = (mode: DeliveryResult["mode"], allowRetry: boolean, timeoutMs: number) => Promise<DeliveryResult>;

/**
 * The one non-blocking delivery path, shared by the entrance middleware and the collector route (verified
 * lifecycle, see verification/RESULTS.md):
 *  - `waitUntil` where one exists (zero added latency, one retry allowed);
 *  - detached on long-lived runtimes (zero added latency, no retry);
 *  - on an edge isolate without `waitUntil`: dropped (`skipped/no_background_context`), or, only with
 *    `onUnsupportedBackground: "await"`, awaited for at most `blockingBudgetMs`.
 * More than `maxInFlight` deliveries in flight are dropped as `overload`. The outcome always goes to
 * `onDeliveryResult`. Never throws.
 */
export async function scheduleDelivery(request: Request, cfg: ResolvedDelivery, inFlight: InFlight, started: number, send: Send): Promise<void> {
  if (inFlight.n >= cfg.maxInFlight) {
    void fire(cfg.onDeliveryResult, { outcome: "dropped", reason: "overload", mode: "none", attempts: 0, durationMs: Date.now() - started });
    return;
  }
  const bg = await findBackground(request);
  const run = async (mode: DeliveryResult["mode"], allowRetry: boolean, timeoutMs: number): Promise<void> => {
    inFlight.n++;
    try {
      await fire(cfg.onDeliveryResult, await send(mode, allowRetry, timeoutMs));
    } catch {
      // The deliver functions never reject; this is belt and braces.
    } finally {
      inFlight.n--;
    }
  };
  if (bg.kind === "wait_until") {
    bg.waitUntil(run("wait_until", true, cfg.timeoutMs));
  } else if (bg.kind === "detached") {
    void run("detached", false, cfg.timeoutMs);
  } else if (cfg.onUnsupportedBackground === "await") {
    await run("blocking", false, Math.min(cfg.timeoutMs, cfg.blockingBudgetMs));
  } else {
    void fire(cfg.onDeliveryResult, skipped("no_background_context", started));
  }
}
