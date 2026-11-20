/**
 * IPLocate adapter (watch-only source comparison).
 *
 * GET https://iplocate.io/api/lookup/<ip> with the key in the X-API-Key header
 * (verified: the header is read; an invalid key is 401 {"error":"Invalid API
 * key"}), never in the URL. 429 is a quota error. The answer is reduced to an
 * allowlist (company name, domain and type, the ASN type, the privacy flags
 * and whether a hosting object is present); location, the ASN's name, route
 * and registry, the hosting provider's name and the raw body are discarded
 * here. IPLocate has no mobile flag (mobile networks come back as isp).
 * lookup() never throws, never follows a redirect, reads at most 64 KiB and
 * never logs.
 */
import { z } from "zod";
import { canonicaliseDomain, canonicaliseOrganisationName } from "../resolution/qualify.js";
import { DEFAULT_MAX_BODY_BYTES, discardBody, readCappedText } from "../provider/http.js";
import type { ApiSignals, ApiSourceAdapter, ApiSourceOutcome } from "./types.js";

export const IPLOCATE_BASE_URL = "https://iplocate.io/api/lookup/";

export interface IplocateAdapterOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  /** Test seam; production always uses IPLOCATE_BASE_URL. */
  baseUrl?: string;
}

const text = (max: number) => z.string().max(max).nullish().catch(null);
const flag = z.boolean().nullish().catch(null);
const CompanySchema = z.object({ name: text(1024), domain: text(1024), type: text(64) });
const AsnSchema = z.object({ type: text(64) });
const PrivacySchema = z.object({
  is_anonymous: flag,
  is_hosting: flag,
  is_icloud_relay: flag,
  is_proxy: flag,
  is_tor: flag,
  is_vpn: flag,
});

// Allowlist: unknown keys are stripped; a field of the wrong type reads as absent.
const BodySchema = z.object({
  company: z.unknown().optional(),
  asn: z.unknown().optional(),
  privacy: z.unknown().optional(),
  hosting: z.unknown().optional(),
});

/** Canonical addresses only ever hold these characters, all safe in a path segment. */
const CANONICAL_IP = /^[0-9a-f.:]{2,45}$/;

class MalformedBody extends Error {}

const lowerType = (t: string | null | undefined): string | null => {
  const v = typeof t === "string" ? t.trim().toLowerCase() : "";
  return /^[a-z_-]{1,32}$/.test(v) ? v : null;
};

const objectOrNull = (v: unknown): object | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : null);

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
  const companyObj = objectOrNull(b.company);
  const company = companyObj ? CompanySchema.safeParse(companyObj) : null;
  const c = company?.success ? company.data : null;
  const asnObj = objectOrNull(b.asn);
  const asn = asnObj ? AsnSchema.safeParse(asnObj) : null;
  const privacyObj = objectOrNull(b.privacy);
  const privacy = privacyObj ? PrivacySchema.safeParse(privacyObj) : null;
  const p = privacy?.success ? privacy.data : null;
  const signals: ApiSignals = {
    companyName: c ? canonicaliseOrganisationName(c.name) : null,
    companyDomain: c ? canonicaliseDomain(c.domain) : null,
    companyType: c ? lowerType(c.type) : null,
    asnType: asn?.success ? lowerType(asn.data.type) : null,
    mobile: false,
    hosting: p?.is_hosting === true || objectOrNull(b.hosting) !== null,
    anonymous: p !== null && (p.is_anonymous === true || p.is_vpn === true || p.is_proxy === true || p.is_tor === true || p.is_icloud_relay === true),
  };
  return { kind: "ok", signals };
}

export function createIplocateAdapter(opts: IplocateAdapterOptions): ApiSourceAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const base = opts.baseUrl ?? IPLOCATE_BASE_URL;
  return {
    source: "iplocate",
    async lookup(canonicalIp: string, { signal }: { signal: AbortSignal }): Promise<ApiSourceOutcome> {
      if (!CANONICAL_IP.test(canonicalIp)) return { kind: "error" };
      let res: Response;
      try {
        res = await fetchImpl(`${base}${canonicalIp}`, {
          method: "GET",
          headers: { accept: "application/json", "x-api-key": opts.apiKey },
          signal,
          redirect: "error",
        });
      } catch {
        return signal.aborted ? { kind: "timeout" } : { kind: "error" };
      }
      try {
        if (res.status < 200 || res.status > 299) {
          await discardBody(res);
          if (res.status === 401 || res.status === 403) return { kind: "auth" };
          if (res.status === 429) return { kind: "quota" };
          return { kind: "error" };
        }
        return interpret(await readCappedText(res, maxBytes));
      } catch {
        // A malformed or oversize body (MalformedBody, BodyTooLargeError) or a broken stream.
        return signal.aborted ? { kind: "timeout" } : { kind: "error" };
      }
    },
  };
}
