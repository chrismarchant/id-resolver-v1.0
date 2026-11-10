/**
 * Qualification policy and provider-value canonicalisation.
 *
 * A domain is never assumed to be the visitor's employer: only an allowlisted
 * provider usage type qualifies it. Everything here is pure and synchronous.
 */
import type { OutcomeReason, PipelineConfig } from "../contracts/runtime.js";

const MAX_DOMAIN_LENGTH = 253;
const MAX_ORGANISATION_LENGTH = 200;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonical lowercase host, or null when the value is not a conservative
 * hostname (labels of [a-z0-9-], at least one dot, no leading/trailing hyphen,
 * <= 253 chars, non-numeric final label so IP literals never pass).
 */
export function canonicaliseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (d.endsWith(".")) d = d.slice(0, -1);
  if (d.startsWith("www.")) d = d.slice(4);
  if (d.length === 0 || d.length > MAX_DOMAIN_LENGTH) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL.test(l))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return null;
  return d;
}

// C0/C1 controls plus zero-width and bidi override/isolate characters.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/** Trimmed, whitespace-collapsed, control-free organisation name (<= 200 code points) or null. */
export function canonicaliseOrganisationName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  const capped = Array.from(cleaned).slice(0, MAX_ORGANISATION_LENGTH).join("").trim();
  return capped.length === 0 ? null : capped;
}

/** Uppercased usage-type code, or null when absent/implausible. */
export function canonicaliseUsageType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim().toUpperCase();
  return /^[A-Z0-9/_-]{1,16}$/.test(u) ? u : null;
}

export type Qualification =
  | { kind: "qualified"; category: string; reason: Extract<OutcomeReason, "provider_resolved"> }
  | { kind: "excluded"; reason: Extract<OutcomeReason, "provider_excluded_usage_type" | "provider_network_owner"> }
  | { kind: "unknown"; reason: Extract<OutcomeReason, "provider_denied_domain" | "provider_unknown_usage_type"> };

export type QualificationPolicy = Pick<
  PipelineConfig["policy"],
  "qualified_usage_types" | "excluded_usage_types" | "denied_domains" | "network_owner_guard"
>;

// ---- network-owner guard ------------------------------------------------------
//
// A provider can label an address with a business usage type (e.g. COM) while
// the organisation it names is the network operator that owns the address
// block, with a domain that belongs to someone else (an ISP's business line,
// its reverse DNS, or a customer of the block). Such a result is the network
// owner, not the visitor's employer. It is recognised when the organisation
// name does not belong to the domain AND either the provider names the
// organisation as the network's operator (its ISP field equals the
// organisation, compared in the adapter) or the name itself is a network
// operator's name (network, broadband, telecom, hosting, ...).

/** Words that make an organisation name a network operator's name. Matched as whole words. */
const NETWORK_OPERATOR_WORDS = new Set([
  "network",
  "networks",
  "networking",
  "broadband",
  "telecom",
  "telecoms",
  "telecommunication",
  "telecommunications",
  "telekom",
  "telecomunicacoes",
  "telecomunicaciones",
  "communications",
  "internet",
  "isp",
  "hosting",
  "datacenter",
  "datacentre",
  "colocation",
  "cable",
  "wireless",
  "fiber",
  "fibre",
  "infocomm",
  "transit",
  "backbone",
]);
const NETWORK_OPERATOR_PHRASES = [/\bdata\s+cent(?:er|re)s?\b/, /\bweb\s+hosting\b/];

const STOP_WORDS = new Set(["the", "and", "of", "for", "de", "la", "le", "du", "des", "del", "y", "et", "und"]);
/** Legal forms: never part of a domain's name or initials. */
const LEGAL_FORMS = new Set([
  "private", "pvt", "pte", "limited", "ltd", "llc", "llp", "lp", "inc", "incorporated", "corp", "corporation", "co", "company",
  "plc", "gmbh", "ag", "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "oy", "ab", "as", "aps", "kk", "pty", "sdn", "bhd", "jsc", "ooo", "sl",
]);
/** Descriptive words: part of a name's initials, but too common to show that a domain is the organisation's. */
const DESCRIPTIVE_WORDS = new Set([
  ...NETWORK_OPERATOR_WORDS,
  "group", "holding", "holdings", "international", "global", "solutions", "solution", "services", "service", "systems", "technologies",
  "technology", "tech", "enterprises", "enterprise", "industries", "partners", "associates", "consulting", "trading", "ventures",
]);

/** Second-level labels of public suffixes such as co.uk, com.au, ac.in. */
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc", "or", "ne", "gob", "gv", "nic", "mil", "res"]);

function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** Two organisation names are the same organisation: equal words once stop words and legal forms are removed. */
export function sameOrganisation(a: string, b: string): boolean {
  const key = (s: string) => words(s).filter((w) => !STOP_WORDS.has(w) && !LEGAL_FORMS.has(w)).join(" ");
  const ka = key(a);
  return ka.length > 0 && ka === key(b);
}

/** True when the organisation name is a network operator's name (whole-word match). */
export function isNetworkOperatorName(name: string): boolean {
  const ws = words(name);
  if (ws.some((w) => NETWORK_OPERATOR_WORDS.has(w))) return true;
  const spaced = ws.join(" ");
  return NETWORK_OPERATOR_PHRASES.some((re) => re.test(spaced));
}

/** The domain's own labels: every label left of the public suffix, hyphens removed. */
function ownLabels(domain: string): string[] {
  const labels = domain.split(".");
  let end = labels.length - 1; // drop the top-level label
  if (labels.length >= 3 && SECOND_LEVEL_SUFFIXES.has(labels[end - 1] ?? "")) end -= 1;
  return labels.slice(0, end).map((l) => l.replace(/-/g, "")).filter((l) => l.length > 0);
}

/**
 * Whether the organisation name plausibly belongs to the domain. Lenient on
 * purpose (the guard only ever excludes on a clear mismatch): a distinctive
 * name word of 3+ characters inside a domain label (`Juniper Networks` and
 * juniper.net), a domain label inside the joined name (`Palo Alto Networks` and
 * paloaltonetworks.com), or the initials of the name (`International Business
 * Machines` and ibm.com).
 */
export function organisationMatchesDomain(organisationName: string, domain: string): boolean {
  const labels = ownLabels(domain);
  if (labels.length === 0) return true;
  const named = words(organisationName).filter((w) => !STOP_WORDS.has(w) && !LEGAL_FORMS.has(w));
  const distinctive = named.filter((w) => w.length >= 3 && !DESCRIPTIVE_WORDS.has(w));
  if (distinctive.some((w) => labels.some((l) => l.includes(w)))) return true;
  const joined = named.join("");
  if (labels.some((l) => l.length >= 3 && joined.includes(l))) return true;
  return named.length >= 2 && labels.includes(named.map((w) => w[0]).join(""));
}

export interface QualificationInput {
  domain: string;
  usageType: string | null;
  /** The provider's organisation name (canonical), when it gave one. */
  organisationName?: string | null;
  /** True when the provider names the organisation as the operator of the address's network (adapter-computed). */
  organisationIsNetworkOperator?: boolean;
}

/** Apply the configured policy to an already-canonical domain and raw usage type. */
export function qualify(input: QualificationInput, policy: QualificationPolicy): Qualification {
  const domain = canonicaliseDomain(input.domain);
  const denied = new Set(policy.denied_domains.map((d) => canonicaliseDomain(d) ?? d.trim().toLowerCase()));
  if (domain === null || denied.has(domain)) return { kind: "unknown", reason: "provider_denied_domain" };

  const usage = canonicaliseUsageType(input.usageType);
  if (usage === null) return { kind: "unknown", reason: "provider_unknown_usage_type" };
  const upper = (xs: string[]) => new Set(xs.map((x) => x.trim().toUpperCase()));
  if (upper(policy.excluded_usage_types).has(usage)) return { kind: "excluded", reason: "provider_excluded_usage_type" };
  if (!upper(policy.qualified_usage_types).has(usage)) return { kind: "unknown", reason: "provider_unknown_usage_type" };
  if (policy.network_owner_guard !== false && isNetworkOwner(domain, input)) return { kind: "excluded", reason: "provider_network_owner" };
  return { kind: "qualified", category: usage, reason: "provider_resolved" };
}

/** The network-owner guard (see above). Needs an organisation name; without one nothing can be told. */
export function isNetworkOwner(domain: string, input: Pick<QualificationInput, "organisationName" | "organisationIsNetworkOperator">): boolean {
  const name = canonicaliseOrganisationName(input.organisationName);
  if (name === null) return false;
  if (!(input.organisationIsNetworkOperator === true || isNetworkOperatorName(name))) return false;
  return !organisationMatchesDomain(name, domain);
}
