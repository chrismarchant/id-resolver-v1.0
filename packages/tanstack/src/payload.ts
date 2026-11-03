import { ACQUISITION_VALUES, ELIGIBILITY_RULE_SET_ID, ENTRANCE_CONTRACT, type Acquisition, type EntrancePayload } from "./types.js";

const PAGE_KEY_MAX = 256;
const PAGE_KEY_VALID = /^\/[^?#\s\u0000-\u001f\u007f]*$/;

/** Maps a normalised path to a route template (e.g. `/blog/my-post` to `/blog/:slug`). Return null to keep the path. */
export type PageKeyMapper = (path: string) => string | null | undefined;

/**
 * Builds a mapper from route templates such as `/blog/:slug` or `/p/:id/edit`.
 * A `:name` segment matches exactly one path segment; templates are tried in
 * order and the first match wins.
 */
export function compileRouteTemplates(templates: readonly string[]): PageKeyMapper {
  const compiled = templates.map((t) => {
    const segs = t.split("/").filter((s) => s !== "");
    return { template: t, segs };
  });
  return (path) => {
    const parts = path.split("/").filter((s) => s !== "");
    for (const c of compiled) {
      if (c.segs.length !== parts.length) continue;
      if (c.segs.every((s, i) => s.startsWith(":") || s === parts[i])) return c.template;
    }
    return null;
  };
}

const EMAIL_SEGMENT = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;
/** A part of a hyphenated slug: a lower-case word, a short number (year, day) or a short mixed token such as `v2` or `2fa`. */
const SLUG_PART = /^(?:[a-z]+|[0-9]{1,4}|[a-z0-9]{1,4})$/;
const YEAR = /^(?:19|20)[0-9]{2}$/;

function decodeForClassification(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isTokenLike(segment: string): boolean {
  // Long random-looking value: hex, base64url or similar, but not a readable slug.
  if (segment.length >= 16 && TOKEN_CHARSET.test(segment)) {
    const parts = segment.split(/[-_]/).filter((p) => p !== "");
    if (!parts.every((p) => SLUG_PART.test(p))) return true;
  }
  // A single run of 12+ characters that mixes letters and digits (order ids, reset codes).
  return segment.split(/[-_]/).some((p) => p.length >= 12 && /[A-Za-z]/.test(p) && /[0-9]/.test(p));
}

function mapSegment(segment: string): string {
  const decoded = decodeForClassification(segment);
  if (EMAIL_SEGMENT.test(decoded)) return ":email";
  if (UUID_SEGMENT.test(decoded)) return ":uuid";
  if (isTokenLike(decoded)) return ":token";
  // Digit runs of 4+ are identifiers (order or account numbers); a plain year is kept.
  return segment.replace(/[0-9]{4,}/g, (run) => (YEAR.test(run) ? run : ":n"));
}

/**
 * Conservative default `page_key` mapper, used unless the site supplies its own
 * `pageKeyMapper`. It replaces identifier-like path segments so that reset
 * tokens, e-mail addresses and order ids never reach the resolver or the
 * reporting feed: e-mail addresses become `:email`, UUIDs `:uuid`, digit runs
 * of four or more `:n` (a plain year such as 2026 is kept), long hex/base64url
 * tokens and 12+ character letter-and-digit runs `:token`. Readable slugs
 * (`pricing`, `case-studies`) are kept. It is a heuristic: a site that knows its
 * routes should use `compileRouteTemplates` instead.
 */
export const defaultPageKeyMapper: PageKeyMapper = (path) => {
  const out = "/" + path.split("/").filter((s) => s !== "").map(mapSegment).join("/");
  return out === path ? null : out;
};

function cap(path: string): string {
  if (path.length <= PAGE_KEY_MAX) return path;
  const cut = path.slice(0, PAGE_KEY_MAX);
  const i = cut.lastIndexOf("/");
  return i <= 0 ? "/" : cut.slice(0, i);
}

/**
 * Normalises a request URL or path to the contract's `page_key`: path only
 * (never a query string or fragment), duplicate slashes collapsed, trailing
 * slash removed, at most 256 characters. An optional route-template mapper
 * lets sites avoid sending identifiers that appear in dynamic segments.
 */
export function normalisePageKey(input: string, mapper?: PageKeyMapper): string {
  let path: string;
  try {
    // A leading "//" must not be read as a protocol-relative host, so a path is
    // appended to a placeholder origin instead of being resolved against it.
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
    path = new URL(absolute ? input : "https://placeholder.invalid/" + input.replace(/^\/+/, ""), "https://placeholder.invalid").pathname;
  } catch {
    return "/";
  }
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path.startsWith("/")) path = "/" + path;
  if (mapper) {
    try {
      const mapped = mapper(path);
      if (typeof mapped === "string" && mapped.length <= PAGE_KEY_MAX && PAGE_KEY_VALID.test(mapped)) return mapped;
    } catch {
      // A throwing mapper must never affect the page: fall back to the path.
    }
  }
  path = cap(path);
  return PAGE_KEY_VALID.test(path) ? path : "/";
}

const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsearch", "paid-search", "paid_search", "paidsocial", "paid-social", "paid_social", "cpm", "cpv", "cpa", "display", "banner", "retargeting", "remarketing", "sponsored", "ads", "ad"]);
const EMAIL_MEDIUMS = new Set(["email", "e-mail", "newsletter", "mail"]);
const SOCIAL_MEDIUMS = new Set(["social", "social-media", "social_media", "socialmedia", "sm", "social-network"]);
const SEARCH_MEDIUMS = new Set(["organic", "search", "seo"]);
const REFERRAL_MEDIUMS = new Set(["referral", "affiliate", "partner"]);

const SEARCH_HOSTS = [/^(?:[a-z0-9-]+\.)*google\.[a-z]{2,3}(?:\.[a-z]{2})?$/, /^(?:[a-z0-9-]+\.)*bing\.com$/, /^(?:[a-z0-9-]+\.)*duckduckgo\.com$/, /^(?:[a-z0-9-]+\.)*(?:search\.)?yahoo\.[a-z.]{2,6}$/, /^(?:[a-z0-9-]+\.)*baidu\.com$/, /^(?:[a-z0-9-]+\.)*yandex\.[a-z.]{2,6}$/, /^(?:[a-z0-9-]+\.)*ecosia\.org$/, /^search\.brave\.com$/, /^(?:[a-z0-9-]+\.)*startpage\.com$/, /^(?:[a-z0-9-]+\.)*kagi\.com$/, /^(?:[a-z0-9-]+\.)*qwant\.com$/, /^(?:[a-z0-9-]+\.)*naver\.com$/, /^(?:[a-z0-9-]+\.)*seznam\.cz$/, /^(?:[a-z0-9-]+\.)*ask\.com$/];
const SOCIAL_HOSTS = [/^(?:[a-z0-9-]+\.)*facebook\.com$/, /^(?:[a-z0-9-]+\.)*fb\.com$/, /^l\.facebook\.com$/, /^(?:[a-z0-9-]+\.)*instagram\.com$/, /^(?:[a-z0-9-]+\.)*linkedin\.com$/, /^lnkd\.in$/, /^t\.co$/, /^(?:[a-z0-9-]+\.)*twitter\.com$/, /^(?:[a-z0-9-]+\.)*x\.com$/, /^(?:[a-z0-9-]+\.)*reddit\.com$/, /^(?:[a-z0-9-]+\.)*pinterest\.[a-z.]{2,6}$/, /^(?:[a-z0-9-]+\.)*tiktok\.com$/, /^(?:[a-z0-9-]+\.)*threads\.(?:net|com)$/, /^(?:[a-z0-9-]+\.)*youtube\.com$/, /^youtu\.be$/, /^(?:[a-z0-9-]+\.)*bsky\.app$/, /^(?:[a-z0-9-]+\.)*whatsapp\.com$/, /^t\.me$/, /^news\.ycombinator\.com$/];
const EMAIL_HOSTS = [/^mail\.google\.com$/, /^outlook\.(?:live|office|office365)\.com$/, /^mail\.yahoo\.com$/, /^(?:[a-z0-9-]+\.)*mail\.(?:proton\.me|protonmail\.com)$/];

function hostOf(value: string | null | undefined): string | null | "invalid" {
  if (value === null || value === undefined || value.trim() === "") return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid";
    return u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "invalid";
  }
}

export interface AcquisitionInput {
  /** Raw `Referer` header value. Only its host is examined; it is never returned. */
  referrer?: string | null;
  /** Host name(s) of this site, for the internal-navigation check. */
  siteHosts: readonly string[];
  /** Raw `utm_medium` query value. Only compared against fixed sets; it is never returned. */
  utmMedium?: string | null;
}

/**
 * Derives the closed `acquisition` enum from the referrer host versus the site
 * host(s) and `utm_medium`. Raw values never leave this function.
 * Order: internal navigation, then utm_medium, then referrer host class, then
 * direct (no referrer) or unknown (unparseable referrer).
 */
export function classifyAcquisition(input: AcquisitionInput): Acquisition {
  const ref = hostOf(input.referrer);
  const site = new Set(input.siteHosts.map((h) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")));
  if (ref !== null && ref !== "invalid" && site.has(ref)) return "internal";

  const medium = (input.utmMedium ?? "").trim().toLowerCase();
  if (medium !== "") {
    if (PAID_MEDIUMS.has(medium)) return "paid";
    if (EMAIL_MEDIUMS.has(medium)) return "email";
    if (SOCIAL_MEDIUMS.has(medium)) return "social";
    if (SEARCH_MEDIUMS.has(medium)) return "search";
    if (REFERRAL_MEDIUMS.has(medium)) return "referral";
  }
  if (ref === null) return "direct";
  if (ref === "invalid") return "unknown";
  if (EMAIL_HOSTS.some((re) => re.test(ref))) return "email"; // before search: mail.google.com
  if (SEARCH_HOSTS.some((re) => re.test(ref))) return "search";
  if (SOCIAL_HOSTS.some((re) => re.test(ref))) return "social";
  return "referral";
}

/** 128-bit random id, base64url without padding (22 characters). */
export function generateEntranceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 3339 UTC, whole seconds. */
export function formatOccurredAt(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isAcquisition(v: unknown): v is Acquisition {
  return typeof v === "string" && (ACQUISITION_VALUES as readonly string[]).includes(v);
}

export function assemblePayload(p: { websiteId: string; ip: string; pageKey: string; acquisition: Acquisition; now?: Date; entranceId?: string }): EntrancePayload {
  return {
    contract: ENTRANCE_CONTRACT,
    website_id: p.websiteId,
    ip: p.ip,
    entrance_id: p.entranceId ?? generateEntranceId(),
    occurred_at: formatOccurredAt(p.now ?? new Date()),
    page_key: p.pageKey,
    acquisition: p.acquisition,
    eligibility: ELIGIBILITY_RULE_SET_ID,
  };
}
