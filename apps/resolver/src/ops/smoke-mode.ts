/**
 * Pure decisions for the development smoke test (src/ops/smoke.ts, CHR-72),
 * kept apart from the suite so they can be unit tested without running it.
 *
 *   - documentationRangeMode: whether the target treats RFC 5737 / RFC 3849
 *     documentation addresses as eligible, read from the smoke process's own
 *     environment (the smoke runs inside the service, so that is the target's
 *     environment) with the service's own parser and default;
 *   - killSwitchPhasePlan: whether the kill-switch phase can run at all;
 *   - killSwitchProbeAddress: a synthetic documentation address that is new
 *     on every run, so it is never served from the cache.
 *
 * Nothing here prints anything; the suite reports enum values only.
 */
import { ConfigSchema } from "../config/index.js";
import type { SmokeTargetKind } from "./smoke-target.js";

export type DocumentationRangeMode = "documentation_ranges_enabled" | "documentation_ranges_disabled";

const DocumentationRangesSchema = ConfigSchema.pick({ ALLOW_DOCUMENTATION_RANGES: true });

/**
 * The documentation-range mode, with the service's own parser and default
 * (src/config: unset means disabled), so the smoke and the service it runs in
 * read the same variable the same way. A value the service would refuse is
 * refused here too (exit 2); the reason names the variable, never its value.
 */
export function documentationRangeMode(
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; mode: DocumentationRangeMode } | { ok: false; reason: string } {
  const parsed = DocumentationRangesSchema.safeParse({ ALLOW_DOCUMENTATION_RANGES: env["ALLOW_DOCUMENTATION_RANGES"] });
  if (!parsed.success) return { ok: false, reason: "ALLOW_DOCUMENTATION_RANGES must be true, false, 1 or 0" };
  return { ok: true, mode: parsed.data.ALLOW_DOCUMENTATION_RANGES ? "documentation_ranges_enabled" : "documentation_ranges_disabled" };
}

export type KillSwitchPhasePlan = "run" | "skipped_documentation_ranges_disabled" | "skipped_target_not_this_service";

/**
 * Whether the kill-switch phase runs.
 *
 *   - Its probe needs an ELIGIBLE address that belongs to no real network.
 *     Only documentation ranges are both synthetic and potentially eligible,
 *     and they are eligible only while ALLOW_DOCUMENTATION_RANGES is true
 *     (RFC 9637's 3fff::/20 is "reserved", hence never eligible). With the
 *     ranges disabled every eligible address is a real one, so the phase is
 *     skipped rather than probing with a real address.
 *   - The switch is written in THIS environment's database (DATABASE_URL,
 *     INSTALLATION_ID). Only a target that runs with this environment reads
 *     it: this service by its private domain, or a loopback service started
 *     with the same environment. Another *.railway.internal service is not
 *     touched.
 */
export function killSwitchPhasePlan(mode: DocumentationRangeMode, target: SmokeTargetKind): KillSwitchPhasePlan {
  if (mode === "documentation_ranges_disabled") return "skipped_documentation_ranges_disabled";
  if (target === "railway_internal") return "skipped_target_not_this_service";
  return "run";
}

/**
 * Marker groups under the RFC 3849 documentation prefix 2001:db8::/32: "ks"
 * for the disabled probe, "kt" for the post-restore control. A non-zero third
 * group keeps both away from every scripted mock address (2001:db8::10).
 */
export const KILL_SWITCH_PROBE_PREFIX = "2001:db8:6b73";
export const KILL_SWITCH_CONTROL_PREFIX = "2001:db8:6b74";
export const PROBE_RANDOM_BYTES = 10;

/**
 * A synthetic documentation address, `<prefix>:` followed by five random
 * 16-bit groups (80 bits), so every run probes an address no earlier run has
 * sent: it can never be a cache hit, whatever an earlier run left behind
 * (a disabled outcome leaves only an already-expired reservation row, but a
 * run in which the switch did NOT take effect would leave a fresh no_match
 * row for TTL_NO_MATCH_S, and a fixed address would then be served from the
 * cache by every later run).
 */
export function killSwitchProbeAddress(prefix: string, random: Uint8Array): string {
  if (random.length !== PROBE_RANDOM_BYTES) throw new Error(`killSwitchProbeAddress needs ${PROBE_RANDOM_BYTES} random bytes`);
  const groups: string[] = [];
  for (let i = 0; i < PROBE_RANDOM_BYTES; i += 2) groups.push(((random[i]! << 8) | random[i + 1]!).toString(16));
  return `${prefix}:${groups.join(":")}`;
}
