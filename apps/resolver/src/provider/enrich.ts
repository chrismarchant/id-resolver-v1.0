/**
 * Live Enrich v3 adapter: POST {base}/ip-to-company with {"ip": "<canonical>"}.
 *
 * This is the only code that sees a raw provider response. It keeps ipDomain,
 * ipOrganization, ipUsageType and a numeric credit count; everything else
 * (ISP, IP range, geolocation, the raw body) is discarded and never logged,
 * returned or embedded in an error. lookup() never throws.
 */
import { z } from "zod";
import type { ProviderAdapter, ProviderErrorCategory, ProviderOutcome } from "../contracts/provider.js";
import { canonicaliseDomain, canonicaliseOrganisationName, canonicaliseUsageType } from "../resolution/qualify.js";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export interface EnrichAdapterOptions {
  baseUrl: string;
  apiKey: string;
  /** "x-api-key" (default) or "authorization-bearer". */
  authHeader: string;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// Allowlist schema: unknown keys are stripped, kept keys are type-checked.
const BodySchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      ipDomain: z.string().max(1024).nullish(),
      ipOrganization: z.string().max(4096).nullish(),
      ipUsageType: z.string().max(256).nullish(),
    })
    .optional(),
  meta: z.record(z.string(), z.unknown()).nullish(),
});

class MalformedBody extends Error {}

function readCredits(meta: Record<string, unknown> | null | undefined): number | null {
  if (!meta) return null;
  for (const k of ["credits_used", "creditsUsed"]) {
    const v = meta[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (v.length === 0) return null;
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    // HTTP-dates always carry a month name; this rejects inputs like "-5" that Date.parse reads as a year.
    if (!/[a-z]{3}/i.test(v)) return null;
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    ms = Math.max(0, at - nowMs);
  }
  return Number.isFinite(ms) ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

function statusCategory(status: number): ProviderErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credits";
  if (status === 429) return "rate_limited";
  return "server";
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new MalformedBody();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MalformedBody();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function interpret(text: string): ProviderOutcome {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MalformedBody();
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success || parsed.data.data === undefined) throw new MalformedBody();
  const { success, data, meta } = parsed.data;
  const creditsReported = readCredits(meta);
  const hasDomain = typeof data.ipDomain === "string" && data.ipDomain.trim().length > 0;
  if (!hasDomain) return { kind: "no_domain", creditsReported };
  if (!success) throw new MalformedBody();
  const domain = canonicaliseDomain(data.ipDomain);
  if (domain === null) return { kind: "no_domain", creditsReported };
  return {
    kind: "resolved",
    domain,
    organisationName: canonicaliseOrganisationName(data.ipOrganization),
    usageType: canonicaliseUsageType(data.ipUsageType),
    creditsReported,
  };
}

export function createEnrichAdapter(opts: EnrichAdapterOptions): ProviderAdapter {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/ip-to-company`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const now = opts.now ?? Date.now;
  const bearer = /^(authorization|authorization-bearer|bearer)$/i.test(opts.authHeader);
  const authHeaders: Record<string, string> = bearer
    ? { authorization: `Bearer ${opts.apiKey}` }
    : { "x-api-key": opts.apiKey };

  return {
    name: "enrich-v3",
    async lookup(ip: string, { signal }: { signal: AbortSignal }): Promise<ProviderOutcome> {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ ip }),
          signal,
          redirect: "error",
        });
      } catch {
        return signal.aborted ? { kind: "timeout" } : { kind: "error", category: "network", retryAfterMs: null };
      }
      try {
        if (res.status < 200 || res.status > 299) {
          const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after"), now()) : null;
          await res.body?.cancel().catch(() => undefined);
          return { kind: "error", category: statusCategory(res.status), retryAfterMs };
        }
        return interpret(await readCappedText(res, maxBytes));
      } catch (err) {
        if (signal.aborted) return { kind: "timeout" };
        if (err instanceof MalformedBody) return { kind: "error", category: "malformed", retryAfterMs: null };
        return { kind: "error", category: "network", retryAfterMs: null };
      }
    },
  };
}
