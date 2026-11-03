import { resolveConfig, type IdrOptions } from "./config.js";
import { deliverEntrance } from "./delivery.js";
import { assemblePayload } from "./payload.js";

export interface ConnectivityResult {
  ok: boolean;
  /** `delivered`, or a drop reason (`timeout`, `network`, `http_4xx`, `http_5xx`, `http_429`). */
  reason: string;
  httpStatus?: number;
  resolverStatus?: string;
  latencyMs: number;
}

/**
 * Sends one synthetic entrance for a documentation-range IP (RFC 5737). A
 * production resolver answers 200 `ineligible` without any provider lookup,
 * which proves URL, token, website id and contract acceptance end to end.
 * (A development resolver that allows documentation ranges will treat it as a
 * normal mock lookup.) Never throws; the result carries no IP and no secret.
 */
export async function checkConnectivity(options: IdrOptions): Promise<ConnectivityResult> {
  try {
    const cfg = resolveConfig(options);
    const payload = assemblePayload({ websiteId: cfg.websiteId, ip: "198.51.100.1", pageKey: "/idr-connectivity-check", acquisition: "direct" });
    const r = await deliverEntrance(cfg, payload, { mode: "none", allowRetry: false, timeoutMs: cfg.timeoutMs });
    return {
      ok: r.outcome === "delivered",
      reason: r.outcome === "delivered" ? "delivered" : r.reason,
      ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
      ...(r.resolverStatus ? { resolverStatus: r.resolverStatus } : {}),
      latencyMs: r.durationMs,
    };
  } catch {
    return { ok: false, reason: "config_invalid", latencyMs: 0 };
  }
}
