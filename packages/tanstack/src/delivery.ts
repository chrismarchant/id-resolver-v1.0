import type { DeliveryResult, ResolvedConfig, ResolvedDelivery } from "./config.js";
import type { EntrancePayload, EventPayload } from "./types.js";

type Mode = DeliveryResult["mode"];

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RESOLVER_STATUSES = new Set(["qualified", "no_match", "excluded", "unknown", "pending", "ineligible", "disabled", "uncertain", "unavailable"]);

type AttemptResult =
  | { kind: "http"; status: number; resolverStatus?: string; recorded?: boolean; retryAfterMs?: number }
  | { kind: "timeout" }
  | { kind: "network" };

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(ms), cancel: () => {} };
  }
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, cancel: () => clearTimeout(t) };
}

type DeliveryConfig = Pick<ResolvedDelivery, "token" | "fetch" | "retry" | "retryDelayMs">;

async function attempt(cfg: DeliveryConfig, url: string, payload: EntrancePayload | EventPayload, timeoutMs: number): Promise<AttemptResult> {
  const { signal, cancel } = timeoutSignal(timeoutMs);
  try {
    const doFetch = cfg.fetch ?? globalThis.fetch;
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal,
      // "error" is rejected by workerd; "manual" never follows a redirect on any runtime.
      redirect: "manual",
    } as RequestInit);
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      const ra = Number(res.headers.get("retry-after"));
      return { kind: "http", status: res.status, ...(Number.isFinite(ra) && ra >= 0 ? { retryAfterMs: ra * 1000 } : {}) };
    }
    let resolverStatus: string | undefined;
    let recorded: boolean | undefined;
    try {
      const body = (await res.json()) as { status?: unknown; recorded?: unknown };
      if (typeof body.status === "string" && RESOLVER_STATUSES.has(body.status)) resolverStatus = body.status;
      if (typeof body.recorded === "boolean") recorded = body.recorded;
    } catch {
      // A 200 whose body cannot be read is still a delivered request.
    }
    return { kind: "http", status: 200, ...(resolverStatus ? { resolverStatus } : {}), ...(recorded !== undefined ? { recorded } : {}) };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    return name === "TimeoutError" || name === "AbortError" ? { kind: "timeout" } : { kind: "network" };
  } finally {
    cancel();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DeliverOptions {
  mode: Mode;
  allowRetry: boolean;
  timeoutMs: number;
}

/**
 * Sends one entrance. Never rejects and never throws: every failure becomes a
 * `dropped` result. A retry happens at most once, only when `allowRetry`
 * (a guaranteed background context) is set and the failure is transient
 * (timeout, network error, 429, 502, 503, 504). The entrance_id makes the
 * retry idempotent at the resolver.
 */
export function deliverEntrance(cfg: ResolvedConfig, payload: EntrancePayload, opts: DeliverOptions): Promise<DeliveryResult> {
  return deliverJson(cfg, cfg.endpoint, payload, opts);
}

/**
 * Sends one `event.v1` body to `<resolverBase>/v1/events`, with the same
 * guarantees as `deliverEntrance` (the event_id makes the retry idempotent).
 */
export function deliverEvent(cfg: ResolvedDelivery, payload: EventPayload, opts: DeliverOptions): Promise<DeliveryResult> {
  return deliverJson(cfg, `${cfg.resolverBase}/v1/events`, payload, opts);
}

async function deliverJson(cfg: DeliveryConfig, url: string, payload: EntrancePayload | EventPayload, opts: DeliverOptions): Promise<DeliveryResult> {
  const started = Date.now();
  let attempts = 0;
  let last: AttemptResult = { kind: "network" };
  const maxAttempts = opts.allowRetry && cfg.retry ? 2 : 1;
  try {
    while (attempts < maxAttempts) {
      attempts++;
      last = await attempt(cfg, url, payload, opts.timeoutMs);
      if (last.kind === "http" && last.status === 200) break;
      const transient = last.kind !== "http" || RETRYABLE_STATUS.has(last.status);
      if (!transient || attempts >= maxAttempts) break;
      const wait = last.kind === "http" && last.retryAfterMs !== undefined ? last.retryAfterMs : cfg.retryDelayMs;
      if (wait > 2_000) break; // a long Retry-After is a drop, not a wait
      await sleep(wait);
    }
  } catch {
    last = { kind: "network" };
  }
  const durationMs = Date.now() - started;
  if (last.kind === "http" && last.status === 200) {
    return {
      outcome: "delivered",
      reason: "ok",
      mode: opts.mode,
      attempts,
      httpStatus: 200,
      ...(last.resolverStatus ? { resolverStatus: last.resolverStatus } : {}),
      ...(last.recorded !== undefined ? { recorded: last.recorded } : {}),
      durationMs,
    };
  }
  const reason = last.kind === "timeout" ? "timeout" : last.kind === "network" ? "network" : last.status === 429 ? "http_429" : last.status >= 500 ? "http_5xx" : last.status >= 400 ? "http_4xx" : "http_other";
  return { outcome: "dropped", reason, mode: opts.mode, attempts, ...(last.kind === "http" ? { httpStatus: last.status } : {}), durationMs };
}
