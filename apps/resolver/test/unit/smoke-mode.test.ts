/**
 * CHR-72: the smoke test's documentation-range mode, kill-switch phase plan
 * and probe-address scheme (src/ops/smoke-mode.ts). Synthetic values only:
 * RFC 5737 / RFC 3849 documentation addresses.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { canonicaliseIp } from "../../src/ip/canonical.js";
import { DEFAULT_MOCK_SCRIPT } from "../../src/provider/mock.js";
import {
  documentationRangeMode,
  eventsMode,
  eventsPhasePlan,
  KILL_SWITCH_CONTROL_PREFIX,
  KILL_SWITCH_PROBE_PREFIX,
  killSwitchPhasePlan,
  killSwitchProbeAddress,
  PROBE_RANDOM_BYTES,
  smokeSuite,
} from "../../src/ops/smoke-mode.js";
import type { SmokeTargetKind } from "../../src/ops/smoke-target.js";
import { TEST_AUTH_TOKEN, TEST_HMAC_SECRET } from "../helpers/env.js";
import { TEST_RUNTIME_PASSWORD } from "../helpers/runtime-role.js";

const SERVICE_REQUIRED = {
  INSTALLATION_ID: "inst-test",
  WEBSITE_ID: "site-test",
  RESOLVER_AUTH_TOKEN: TEST_AUTH_TOKEN,
  IP_HMAC_SECRET: TEST_HMAC_SECRET,
  DATABASE_URL: "postgres://user:pw@db.invalid:5432/resolver",
  OBSERVATION_RETENTION_DAYS: "14",
  // Production (the default NODE_ENV) requires the separate runtime role (Gate 5).
  DATABASE_RUNTIME_PASSWORD: TEST_RUNTIME_PASSWORD,
};

describe("smoke documentation-range mode", () => {
  it("maps the variable to an enum: true/1 enabled; false/0/unset disabled (the service default)", () => {
    expect(documentationRangeMode({ ALLOW_DOCUMENTATION_RANGES: "true" })).toEqual({ ok: true, mode: "documentation_ranges_enabled" });
    expect(documentationRangeMode({ ALLOW_DOCUMENTATION_RANGES: "1" })).toEqual({ ok: true, mode: "documentation_ranges_enabled" });
    expect(documentationRangeMode({ ALLOW_DOCUMENTATION_RANGES: "false" })).toEqual({ ok: true, mode: "documentation_ranges_disabled" });
    expect(documentationRangeMode({ ALLOW_DOCUMENTATION_RANGES: "0" })).toEqual({ ok: true, mode: "documentation_ranges_disabled" });
    expect(documentationRangeMode({})).toEqual({ ok: true, mode: "documentation_ranges_disabled" });
  });

  it("refuses a value the service would refuse, naming the variable but never the value", () => {
    for (const v of ["yes", "TRUE", "", "on", "true "]) {
      const r = documentationRangeMode({ ALLOW_DOCUMENTATION_RANGES: v });
      expect(r.ok, JSON.stringify(v)).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("ALLOW_DOCUMENTATION_RANGES");
        if (v.trim().length > 0) expect(r.reason).not.toContain(v);
      }
    }
  });

  it("reads the variable exactly as the service does (same parser, same default)", () => {
    for (const v of ["true", "false", "1", "0", undefined, "", "yes", "TRUE"]) {
      const env = v === undefined ? { ...SERVICE_REQUIRED } : { ...SERVICE_REQUIRED, ALLOW_DOCUMENTATION_RANGES: v };
      let service: boolean | "refused";
      try {
        service = loadConfig(env).ALLOW_DOCUMENTATION_RANGES;
      } catch {
        service = "refused";
      }
      const smoke = documentationRangeMode(env);
      const smokeView = smoke.ok ? smoke.mode === "documentation_ranges_enabled" : "refused";
      expect(smokeView, JSON.stringify(v)).toBe(service);
    }
  });

  it("ignores every other variable", () => {
    expect(documentationRangeMode({ ALLOW_DOCUMENTATION_RANGES: "true", PROVIDER_MODE: "nonsense" })).toEqual({ ok: true, mode: "documentation_ranges_enabled" });
  });
});

describe("smoke kill-switch phase plan", () => {
  const kinds: SmokeTargetKind[] = ["railway_private_default", "loopback", "railway_internal"];

  it("runs only with documentation ranges enabled and against this service or loopback", () => {
    expect(killSwitchPhasePlan("documentation_ranges_enabled", "railway_private_default")).toBe("run");
    expect(killSwitchPhasePlan("documentation_ranges_enabled", "loopback")).toBe("run");
    expect(killSwitchPhasePlan("documentation_ranges_enabled", "railway_internal")).toBe("skipped_target_not_this_service");
  });

  it("is skipped whenever documentation ranges are disabled (no synthetic address is eligible then)", () => {
    for (const k of kinds) expect(killSwitchPhasePlan("documentation_ranges_disabled", k)).toBe("skipped_documentation_ranges_disabled");
  });

  it("the premise: with documentation ranges disabled, no documentation-style address is eligible", () => {
    // RFC 5737, RFC 3849 and RFC 9637 (3fff::/20): every synthetic candidate is ineligible.
    for (const ip of ["192.0.2.1", "198.51.100.1", "203.0.113.1", "2001:db8::1", "3fff::1", killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, randomBytes(PROBE_RANDOM_BYTES))]) {
      const c = canonicaliseIp(ip, { allowDocumentationRanges: false });
      expect(c.ok && c.eligible, ip).toBe(false);
    }
  });
});

describe("smoke kill-switch probe address", () => {
  const draw = (prefix: string) => killSwitchProbeAddress(prefix, randomBytes(PROBE_RANDOM_BYTES));

  it("is an RFC 3849 documentation address: eligible only while documentation ranges are enabled", () => {
    for (const prefix of [KILL_SWITCH_PROBE_PREFIX, KILL_SWITCH_CONTROL_PREFIX]) {
      for (let i = 0; i < 200; i++) {
        const ip = draw(prefix);
        expect(ip.startsWith(`${prefix}:`)).toBe(true);
        const enabled = canonicaliseIp(ip, { allowDocumentationRanges: true });
        expect(enabled, ip).toMatchObject({ ok: true, family: 6, eligible: true });
        const disabled = canonicaliseIp(ip, { allowDocumentationRanges: false });
        expect(disabled, ip).toMatchObject({ ok: true, family: 6, eligible: false, range: "documentation" });
      }
    }
  });

  it("never equals a scripted mock address, so the mock answers an unscripted no_domain", () => {
    const scripted = new Set(Object.keys(DEFAULT_MOCK_SCRIPT));
    for (let i = 0; i < 500; i++) {
      for (const prefix of [KILL_SWITCH_PROBE_PREFIX, KILL_SWITCH_CONTROL_PREFIX]) {
        const c = canonicaliseIp(draw(prefix), { allowDocumentationRanges: true });
        expect(c.ok && scripted.has(c.canonical)).toBe(false);
      }
    }
  });

  it("is new on every run (80 random bits), and the probe and control prefixes never meet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const c = canonicaliseIp(draw(KILL_SWITCH_PROBE_PREFIX), { allowDocumentationRanges: true });
      if (c.ok) seen.add(c.canonical);
    }
    expect(seen.size).toBe(2_000);
    const probe = canonicaliseIp(killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, Buffer.alloc(PROBE_RANDOM_BYTES)), { allowDocumentationRanges: true });
    const control = canonicaliseIp(killSwitchProbeAddress(KILL_SWITCH_CONTROL_PREFIX, Buffer.alloc(PROBE_RANDOM_BYTES)), { allowDocumentationRanges: true });
    expect(probe.ok && control.ok && probe.canonical !== control.canonical).toBe(true);
  });

  it("is deterministic for given bytes, valid for all-zero and all-one bytes, and refuses a wrong length", () => {
    const bytes = Buffer.from("00010203040506070809", "hex");
    expect(killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, bytes)).toBe(killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, Buffer.from(bytes)));
    expect(killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, bytes)).toBe(`${KILL_SWITCH_PROBE_PREFIX}:1:203:405:607:809`);
    for (const fill of [0x00, 0xff]) {
      const ip = killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, Buffer.alloc(PROBE_RANDOM_BYTES, fill));
      expect(canonicaliseIp(ip, { allowDocumentationRanges: true })).toMatchObject({ ok: true, eligible: true });
    }
    expect(() => killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, Buffer.alloc(9))).toThrow();
    expect(() => killSwitchProbeAddress(KILL_SWITCH_PROBE_PREFIX, Buffer.alloc(11))).toThrow();
  });
});

describe("smoke events mode (Gate 5)", () => {
  it("maps EVENTS_ENABLED and EVENT_CONSENT_MODE to enums with the service's defaults (off; required)", () => {
    expect(eventsMode({})).toEqual({ ok: true, mode: "events_disabled", consentMode: "required" });
    expect(eventsMode({ EVENTS_ENABLED: "true" })).toEqual({ ok: true, mode: "events_enabled", consentMode: "required" });
    expect(eventsMode({ EVENTS_ENABLED: "1", EVENT_CONSENT_MODE: "not_required" })).toEqual({ ok: true, mode: "events_enabled", consentMode: "not_required" });
    expect(eventsMode({ EVENTS_ENABLED: "false", EVENT_CONSENT_MODE: "required" })).toEqual({ ok: true, mode: "events_disabled", consentMode: "required" });
  });

  it("refuses a value the service would refuse, naming the variable but never the value", () => {
    for (const env of [{ EVENTS_ENABLED: "yes" }, { EVENTS_ENABLED: "" }, { EVENT_CONSENT_MODE: "optional" }, { EVENT_CONSENT_MODE: "REQUIRED" }]) {
      const r = eventsMode(env);
      expect(r.ok, JSON.stringify(env)).toBe(false);
      if (!r.ok) {
        const [name, value] = Object.entries(env)[0]!;
        expect(r.reason).toContain(name);
        if (value.length > 0) expect(r.reason).not.toContain(`${value} `);
        expect(r.reason).not.toMatch(/yes|optional|REQUIRED/);
      }
    }
  });

  it("reads both variables exactly as the service does (same parser, same defaults)", () => {
    for (const enabled of ["true", "false", "1", "0", undefined, "", "yes"]) {
      for (const consent of ["required", "not_required", undefined, "x"]) {
        const env: Record<string, string> = { ...SERVICE_REQUIRED };
        if (enabled !== undefined) env["EVENTS_ENABLED"] = enabled;
        if (consent !== undefined) env["EVENT_CONSENT_MODE"] = consent;
        let service: string;
        try {
          const c = loadConfig(env);
          service = `${String(c.EVENTS_ENABLED)}/${c.EVENT_CONSENT_MODE}`;
        } catch {
          service = "refused";
        }
        const smoke = eventsMode(env);
        const smokeView = smoke.ok ? `${String(smoke.mode === "events_enabled")}/${smoke.consentMode}` : "refused";
        expect(smokeView, JSON.stringify({ enabled, consent })).toBe(service);
      }
    }
  });

  it("plans the database checks only against this service or loopback, and the disabled check whenever events are off", () => {
    expect(eventsPhasePlan("events_enabled", "railway_private_default")).toBe("run");
    expect(eventsPhasePlan("events_enabled", "loopback")).toBe("run");
    expect(eventsPhasePlan("events_enabled", "railway_internal")).toBe("run_without_database");
    for (const k of ["railway_private_default", "loopback", "railway_internal"] as const) expect(eventsPhasePlan("events_disabled", k)).toBe("check_disabled");
  });
});

describe("smoke suite argument", () => {
  it("full by default; rollback-check on request; anything else refused without echoing it", () => {
    expect(smokeSuite([])).toEqual({ ok: true, suite: "full" });
    expect(smokeSuite(["--mode", "full"])).toEqual({ ok: true, suite: "full" });
    expect(smokeSuite(["--mode", "rollback-check"])).toEqual({ ok: true, suite: "rollback_check" });
    expect(smokeSuite(["--mode=rollback-check"])).toEqual({ ok: true, suite: "rollback_check" });
    for (const argv of [["--mode"], ["--mode", "rollback"], ["rollback-check"], ["--mode", "rollback-check", "x"], ["--mode=secret-value"], ["--other"]]) {
      const r = smokeSuite(argv);
      expect(r.ok, argv.join(" ")).toBe(false);
      if (!r.ok) expect(r.reason).not.toContain("secret-value");
    }
  });
});
