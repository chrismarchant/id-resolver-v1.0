import { parsePublicIp, type ParseIpOptions } from "./ip.js";
import type { IpSelection, TrustPolicy } from "./types.js";

const HEADER_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Headers that can never carry a trusted client IP. */
const FORBIDDEN_HEADER_NAMES = new Set(["host", "cookie", "authorization", "user-agent", "referer", "origin", "content-length", "accept", "x-forwarded-host", "forwarded"]);
const MAX_XFF_ENTRIES = 20;
const MAX_HEADER_LENGTH = 512;

/** Throws on a policy that cannot be used safely. Called at creation. */
export function validateTrustPolicy(policy: TrustPolicy): void {
  const p = policy as { mode?: unknown; trustedHops?: unknown; name?: unknown } | null;
  if (!p || typeof p !== "object") throw new Error("idr-tanstack: trustPolicy is required (cloudflare | xff | header | none)");
  switch (p.mode) {
    case "cloudflare":
    case "none":
      return;
    case "xff":
      if (typeof p.trustedHops !== "number" || !Number.isInteger(p.trustedHops) || p.trustedHops < 1 || p.trustedHops > 10) {
        throw new Error("idr-tanstack: trustPolicy xff requires an integer trustedHops between 1 and 10");
      }
      return;
    case "header": {
      const name = typeof p.name === "string" ? p.name.toLowerCase() : "";
      if (!HEADER_TOKEN.test(name) || FORBIDDEN_HEADER_NAMES.has(name)) {
        throw new Error("idr-tanstack: trustPolicy header requires a valid single-valued header name");
      }
      return;
    }
    default:
      throw new Error("idr-tanstack: trustPolicy.mode must be cloudflare, xff, header or none");
  }
}

function singleValue(request: Request, name: string): { ok: true; value: string } | { ok: false; reason: "header_missing" | "header_multiple" | "header_malformed" } {
  const raw = request.headers.get(name);
  if (raw === null) return { ok: false, reason: "header_missing" };
  // Headers.get joins repeated headers with ", ": a comma means more than one value.
  if (raw.includes(",")) return { ok: false, reason: "header_multiple" };
  const value = raw.trim();
  if (value.length === 0 || value.length > 64 || /\s/.test(value)) return { ok: false, reason: "header_malformed" };
  return { ok: true, value };
}

/**
 * Chooses the client IP under an explicit trust policy. Fails closed: any
 * malformed, repeated, private, reserved, loopback, link-local or mapped value
 * returns a closed rejection reason (never the value) and the caller sends
 * nothing.
 */
export function selectClientIp(request: Request, policy: TrustPolicy, options: ParseIpOptions = {}): IpSelection {
  switch (policy.mode) {
    case "none":
      return { ok: false, reason: "policy_none" };
    case "cloudflare":
      return fromSingle(request, "cf-connecting-ip", options);
    case "header":
      return fromSingle(request, policy.name.toLowerCase(), options);
    case "xff":
      return fromXff(request, policy.trustedHops, options);
    default:
      return { ok: false, reason: "policy_none" };
  }
}

function fromSingle(request: Request, name: string, options: ParseIpOptions): IpSelection {
  const v = singleValue(request, name);
  if (!v.ok) return { ok: false, reason: v.reason };
  const parsed = parsePublicIp(v.value, options);
  if (!parsed.ok) return { ok: false, reason: parsed.reason === "malformed" ? "ip_malformed" : "ip_non_public" };
  return { ok: true, ip: parsed.ip, family: parsed.family };
}

function fromXff(request: Request, trustedHops: number, options: ParseIpOptions): IpSelection {
  if (!Number.isInteger(trustedHops) || trustedHops < 1) return { ok: false, reason: "policy_none" };
  const raw = request.headers.get("x-forwarded-for");
  if (raw === null) return { ok: false, reason: "header_missing" };
  if (raw.length > MAX_HEADER_LENGTH) return { ok: false, reason: "xff_too_long" };
  const entries = raw.split(",").map((e) => e.trim());
  if (entries.length > MAX_XFF_ENTRIES) return { ok: false, reason: "xff_too_long" };
  // trustedHops proxies are ours; the entry they appended (counting from the
  // right) is the client as seen by the outermost trusted proxy. Anything to
  // its left is attacker-controllable and is never consulted.
  if (entries.length < trustedHops) return { ok: false, reason: "xff_too_few_hops" };
  const chosen = entries[entries.length - trustedHops] ?? "";
  if (chosen === "") return { ok: false, reason: "header_malformed" };
  const parsed = parsePublicIp(chosen, options);
  if (!parsed.ok) return { ok: false, reason: parsed.reason === "malformed" ? "ip_malformed" : "ip_non_public" };
  return { ok: true, ip: parsed.ip, family: parsed.family };
}
