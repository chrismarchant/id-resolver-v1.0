import type { ResolvedConfig } from "./config.js";
import { isEligible, type EligibilityResult } from "./eligibility.js";
import { assemblePayload, classifyAcquisition, normalisePageKey } from "./payload.js";
import { selectClientIp } from "./trust.js";
import type { EntrancePayload, IpRejectReason } from "./types.js";
import type { IdrOptions } from "./config.js";
import { resolveConfig } from "./config.js";

export type BuildResult =
  | { ok: true; payload: EntrancePayload }
  | { ok: false; stage: "eligibility"; reason: Exclude<EligibilityResult, { eligible: true }>["reason"] }
  | { ok: false; stage: "ip"; reason: IpRejectReason };

export function buildFromConfig(request: Request, cfg: ResolvedConfig): BuildResult {
  const elig = isEligible(request, cfg.eligibility);
  if (!elig.eligible) return { ok: false, stage: "eligibility", reason: elig.reason };
  const sel = selectClientIp(request, cfg.trustPolicy, { allowDocumentationRanges: cfg.allowDocumentationRanges });
  if (!sel.ok) return { ok: false, stage: "ip", reason: sel.reason };
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { ok: false, stage: "eligibility", reason: "bad_url" };
  }
  const acquisition = classifyAcquisition({
    referrer: request.headers.get("referer"),
    siteHosts: cfg.siteHosts ?? [url.hostname],
    utmMedium: url.searchParams.get("utm_medium"),
  });
  return {
    ok: true,
    payload: assemblePayload({
      websiteId: cfg.websiteId,
      ip: sel.ip,
      pageKey: normalisePageKey(url.pathname, cfg.pageKeyMapper),
      acquisition,
    }),
  };
}

/**
 * Lower-level primitive: validates `options`, then applies eligibility, the
 * trust policy and payload derivation to one request. Nothing is sent.
 */
export function buildEntrance(request: Request, options: IdrOptions): BuildResult {
  return buildFromConfig(request, resolveConfig(options));
}
