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
  | { kind: "excluded"; reason: Extract<OutcomeReason, "provider_excluded_usage_type"> }
  | { kind: "unknown"; reason: Extract<OutcomeReason, "provider_denied_domain" | "provider_unknown_usage_type"> };

export type QualificationPolicy = Pick<
  PipelineConfig["policy"],
  "qualified_usage_types" | "excluded_usage_types" | "denied_domains"
>;

/** Apply the configured policy to an already-canonical domain and raw usage type. */
export function qualify(input: { domain: string; usageType: string | null }, policy: QualificationPolicy): Qualification {
  const domain = canonicaliseDomain(input.domain);
  const denied = new Set(policy.denied_domains.map((d) => canonicaliseDomain(d) ?? d.trim().toLowerCase()));
  if (domain === null || denied.has(domain)) return { kind: "unknown", reason: "provider_denied_domain" };

  const usage = canonicaliseUsageType(input.usageType);
  if (usage === null) return { kind: "unknown", reason: "provider_unknown_usage_type" };
  const upper = (xs: string[]) => new Set(xs.map((x) => x.trim().toUpperCase()));
  if (upper(policy.excluded_usage_types).has(usage)) return { kind: "excluded", reason: "provider_excluded_usage_type" };
  if (upper(policy.qualified_usage_types).has(usage)) return { kind: "qualified", category: usage, reason: "provider_resolved" };
  return { kind: "unknown", reason: "provider_unknown_usage_type" };
}
