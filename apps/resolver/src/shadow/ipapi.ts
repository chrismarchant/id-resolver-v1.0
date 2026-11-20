/**
 * ipapi.is adapter (watch-only source comparison).
 *
 * POST https://api.ipapi.is with {"q": "<ip>", "key": "<key>"}: the key travels
 * in the body, never in a URL. The answer is reduced to an allowlist (company
 * name, domain and type, the ASN type and the mobile, data-centre, VPN, proxy
 * and Tor flags); everything else (location, abuse contacts, the ASN's own
 * name and ranges, the raw body) is discarded here. Without a key ipapi.is
 * returns `company` as a plain string: a company that is not an object is no
 * company. lookup() never throws, never follows a redirect, reads at most
 * 64 KiB and never logs.
 *
 * Errors (verified): an invalid key is HTTP 403 with error_code
 * ERR_FORBIDDEN_INVALID_API_KEY; quota errors are HTTP 429 with
 * ERR_QUOTA_EXCEEDED or ERR_FREE_TIER_EXHAUSTED; ERR_UNEXPECTED_SERVER_ERROR
 * is a server error.
 */
import { z } from "zod";
import { canonicaliseDomain, canonicaliseOrganisationName } from "../resolution/qualify.js";
import { DEFAULT_MAX_BODY_BYTES, readCappedText } from "../provider/http.js";
import type { ApiSignals, ApiSourceAdapter, ApiSourceOutcome } from "./types.js";

export const IPAPI_URL = "https://api.ipapi.is";
/** Error bodies are tiny; only error_code is read from them. */
const ERROR_BODY_BYTES = 4 * 1024;
const QUOTA_CODES = new Set(["ERR_QUOTA_EXCEEDED", "ERR_FREE_TIER_EXHAUSTED"]);
const AUTH_CODES = new Set(["ERR_FORBIDDEN_INVALID_API_KEY"]);

export interface IpapiAdapterOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  /** Test seam; production always uses IPAPI_URL. */
  url?: string;
}

const text = (max: number) => z.string().max(max).nullish().catch(null);
const flag = z.boolean().nullish().catch(null);
const CompanySchema = z.object({ name: text(1024), domain: text(1024), type: text(64) });
const AsnSchema = z.object({ type: text(64) });

// Allowlist: unknown keys are stripped; a field of the wrong type reads as absent.
const BodySchema = z.object({
  error_code: text(128),
  company: z.unknown().optional(),
  asn: z.unknown().optional(),
  is_mobile: flag,
  is_datacenter: flag,
  is_tor: flag,
  is_proxy: flag,
  is_vpn: flag,
});

class MalformedBody extends Error {}

const lowerType = (t: string | null | undefined): string | null => {
  const v = typeof t === "string" ? t.trim().toLowerCase() : "";
  return /^[a-z_-]{1,32}$/.test(v) ? v : null;
};

function errorKind(status: number, code: string | null): ApiSourceOutcome {
  if ((code !== null && QUOTA_CODES.has(code)) || status === 429) return { kind: "quota" };
  if ((code !== null && AUTH_CODES.has(code)) || status === 401 || status === 403) return { kind: "auth" };
  return { kind: "error" };
}

function errorCodeOf(body: string): string | null {
  try {
    const parsed = BodySchema.safeParse(JSON.parse(body));
    return parsed.success ? (parsed.data.error_code ?? null) : null;
  } catch {
    return null;
  }
}

function interpret(raw: string): ApiSourceOutcome {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MalformedBody();
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) throw new MalformedBody();
  const b = parsed.data;
  if (b.error_code) return errorKind(200, b.error_code);
  const company = typeof b.company === "object" && b.company !== null ? CompanySchema.safeParse(b.company) : null;
  const c = company?.success ? company.data : null;
  const asn = typeof b.asn === "object" && b.asn !== null ? AsnSchema.safeParse(b.asn) : null;
  const signals: ApiSignals = {
    companyName: c ? canonicaliseOrganisationName(c.name) : null,
    companyDomain: c ? canonicaliseDomain(c.domain) : null,
    companyType: c ? lowerType(c.type) : null,
    asnType: asn?.success ? lowerType(asn.data.type) : null,
    mobile: b.is_mobile === true,
    hosting: b.is_datacenter === true,
    anonymous: b.is_vpn === true || b.is_proxy === true || b.is_tor === true,
  };
  return { kind: "ok", signals };
}

export function createIpapiAdapter(opts: IpapiAdapterOptions): ApiSourceAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const url = opts.url ?? IPAPI_URL;
  return {
    source: "ipapi",
    async lookup(canonicalIp: string, { signal }: { signal: AbortSignal }): Promise<ApiSourceOutcome> {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ q: canonicalIp, key: opts.apiKey }),
          signal,
          redirect: "error",
        });
      } catch {
        return signal.aborted ? { kind: "timeout" } : { kind: "error" };
      }
      try {
        if (res.status < 200 || res.status > 299) {
          // Only error_code is read from an error body (quota or key); a larger or unreadable one is just the status.
          return errorKind(res.status, errorCodeOf(await readCappedText(res, ERROR_BODY_BYTES).catch(() => "")));
        }
        return interpret(await readCappedText(res, maxBytes));
      } catch {
        // A malformed or oversize body (MalformedBody, BodyTooLargeError) or a broken stream.
        return signal.aborted ? { kind: "timeout" } : { kind: "error" };
      }
    },
  };
}
