import { buildFromConfig } from "./build.js";
import { resolveConfig, type DeliveryResult, type IdrOptions, type ResolvedConfig } from "./config.js";
import { deliverEntrance } from "./delivery.js";
import { findBackground } from "./runtime.js";

export interface IdrMiddlewareArgs<R> {
  request: Request;
  next: (...args: never[]) => R | Promise<R>;
}

function responseOf(result: unknown): Response | undefined {
  if (result instanceof Response) return result;
  const r = (result as { response?: unknown } | null | undefined)?.response;
  return r instanceof Response ? r : undefined;
}

/** Only successful HTML documents are entrances (not redirects, errors or non-HTML). Unknown shapes are reported. */
function isReportableResponse(result: unknown): boolean {
  const res = responseOf(result);
  if (!res) return true;
  if (res.status < 200 || res.status > 299) return false;
  const ct = res.headers.get("content-type");
  return ct === null || ct.toLowerCase().includes("text/html");
}

type Hook = (result: DeliveryResult) => void | Promise<void>;

/** Calls the hook without ever throwing; the returned promise (if any) is not awaited by the caller. */
function fire(hook: Hook | undefined, result: DeliveryResult): Promise<void> {
  if (!hook) return Promise.resolve();
  try {
    return Promise.resolve(hook(result)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

const skipped = (reason: string, started: number): DeliveryResult => ({ outcome: "skipped", reason, mode: "none", attempts: 0, durationMs: Date.now() - started });

/**
 * Server request middleware for TanStack Start.
 *
 *   createMiddleware().server(createIdrServerMiddleware(options))
 *
 * `options` may be a function; it is then evaluated on the first request
 * (useful where environment bindings are only readable at request time). A
 * configuration error found lazily disables reporting and is reported once
 * through `onDeliveryResult` as `skipped/config_invalid`; it never reaches the
 * page. An invalid eager configuration throws at creation.
 *
 * Behaviour (verified against TanStack Start 1.168 / Nitro 3 on workerd):
 *  - `next()` runs first; its result is returned as the very same object.
 *  - Reporting is scheduled after `next()` returns: via `waitUntil` where one
 *    exists (zero added TTFB, one retry allowed), detached on long-lived Node
 *    processes (zero added TTFB, no retry), and dropped on edge isolates
 *    without `waitUntil` unless `onUnsupportedBackground: "await"` is set
 *    (then bounded by `blockingBudgetMs`).
 */
export function createIdrServerMiddleware(options: IdrOptions | (() => IdrOptions)) {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error("idr-tanstack: createIdrServerMiddleware must only run on the server");
  }
  let cfg: ResolvedConfig | null = typeof options === "function" ? null : resolveConfig(options);
  let lazyState: "pending" | "failed" = "pending";
  let failureHook: Hook | undefined;
  let inFlight = 0;

  /** Resolves a lazy configuration once; a failure disables reporting for good. */
  function config(): ResolvedConfig | null {
    if (cfg) return cfg;
    if (lazyState === "failed" || typeof options !== "function") return null;
    let raw: IdrOptions | undefined;
    try {
      raw = options();
      cfg = resolveConfig(raw);
      return cfg;
    } catch {
      lazyState = "failed";
      failureHook = typeof raw?.onDeliveryResult === "function" ? raw.onDeliveryResult : undefined;
      void fire(failureHook, skipped("config_invalid", Date.now()));
      return null;
    }
  }

  async function report(request: Request): Promise<void> {
    const started = Date.now();
    const c = config();
    if (!c) return;
    const built = buildFromConfig(request, c);
    if (!built.ok) {
      // Ineligible requests are the common case; only an explicit hook hears about them.
      void fire(c.onDeliveryResult, skipped(`${built.stage}:${built.reason}`, started));
      return;
    }
    if (inFlight >= c.maxInFlight) {
      void fire(c.onDeliveryResult, { outcome: "dropped", reason: "overload", mode: "none", attempts: 0, durationMs: Date.now() - started });
      return;
    }
    const bg = await findBackground(request);
    const run = async (mode: DeliveryResult["mode"], allowRetry: boolean, timeoutMs: number): Promise<void> => {
      inFlight++;
      try {
        const res = await deliverEntrance(c, built.payload, { mode, allowRetry, timeoutMs });
        await fire(c.onDeliveryResult, res);
      } catch {
        // deliverEntrance never rejects; this is belt and braces.
      } finally {
        inFlight--;
      }
    };
    if (bg.kind === "wait_until") {
      bg.waitUntil(run("wait_until", true, c.timeoutMs));
    } else if (bg.kind === "detached") {
      void run("detached", false, c.timeoutMs);
    } else if (c.onUnsupportedBackground === "await") {
      await run("blocking", false, Math.min(c.timeoutMs, c.blockingBudgetMs));
    } else {
      void fire(c.onDeliveryResult, skipped("no_background_context", started));
    }
  }

  return async function idrServerMiddleware<R>(args: IdrMiddlewareArgs<R>): Promise<R> {
    const result = await (args.next as () => R | Promise<R>)();
    try {
      if (isReportableResponse(result)) await report(args.request);
    } catch {
      // Never throws into the page.
    }
    return result;
  };
}
