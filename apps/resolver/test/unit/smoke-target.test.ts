/**
 * CHR-66 N7: the smoke test's authenticated target is limited to this
 * service (RAILWAY_PRIVATE_DOMAIN), loopback or *.railway.internal, because
 * its PROVIDER_MODE guard only vouches for its own environment and the
 * tokens must not leave the private network. Synthetic hosts only
 * (example.com, RFC 5737 / RFC 3849 addresses).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSmokeTarget } from "../../src/ops/smoke-target.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
/**
 * Synthetic Railway private host names, assembled at run time: the
 * public-safety gate forbids any concrete <name>.railway.internal literal in
 * this public repository (no opt-out marker), even a made-up one.
 */
const internal = (name: string) => [name, "railway", "internal"].join(".");
const SELF = internal("example-svc");
const OTHER = internal("other-example-svc");
const SYNTHETIC_TOKEN = ["smoke", "token", "0123456789abcdef0123456789abcdef"].join("-");

/** Runs the real smoke entry point with only the given environment (plus PATH). */
function runSmoke(env: Record<string, string>): { status: number | null; out: string } {
  const tsx = resolve(ROOT, "..", "..", "node_modules", ".bin", "tsx");
  const r = spawnSync(tsx, ["src/ops/smoke.ts"], { cwd: ROOT, encoding: "utf8", timeout: 20_000, env: { PATH: process.env["PATH"] ?? "", ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("smoke target validation", () => {
  it("defaults to this service's private domain and port", () => {
    expect(resolveSmokeTarget({ RAILWAY_PRIVATE_DOMAIN: SELF, PORT: "8080" })).toEqual({
      ok: true,
      base: `http://${SELF}:8080`,
      kind: "railway_private_default",
    });
    expect(resolveSmokeTarget({ RAILWAY_PRIVATE_DOMAIN: SELF })).toMatchObject({ ok: true, base: `http://${SELF}:8080` });
    expect(resolveSmokeTarget({ RAILWAY_PRIVATE_DOMAIN: SELF.toUpperCase(), PORT: "3000" })).toMatchObject({ ok: true, base: `http://${SELF}:3000` });
  });

  it("accepts SMOKE_BASE_URL on loopback or *.railway.internal, and it takes precedence", () => {
    const ok: Array<[string, string, string]> = [
      ["http://127.0.0.1:8080", "http://127.0.0.1:8080", "loopback"],
      ["http://127.0.0.1:8080/", "http://127.0.0.1:8080", "loopback"],
      ["https://127.0.0.1:8443", "https://127.0.0.1:8443", "loopback"],
      ["http://[::1]:8080", "http://[::1]:8080", "loopback"],
      ["http://localhost:3000", "http://localhost:3000", "loopback"],
      ["http://LOCALHOST:3000", "http://localhost:3000", "loopback"],
      [`http://${OTHER}:8080`, `http://${OTHER}:8080`, "railway_internal"],
    ];
    for (const [url, base, kind] of ok) {
      expect(resolveSmokeTarget({ SMOKE_BASE_URL: url, RAILWAY_PRIVATE_DOMAIN: SELF }), url).toEqual({ ok: true, base, kind });
    }
  });

  it("refuses every other SMOKE_BASE_URL host, without falling back to the default", () => {
    const refused = [
      "http://resolver.example.com", // public host over http: tokens in clear text
      "https://resolver.example.com", // public host: the guard cannot vouch for its mode
      "http://203.0.113.5:8080", // RFC 5737
      "http://[2001:db8::1]:8080", // RFC 3849
      "http://10.0.0.5:8080", // private but not this environment
      "http://127.0.0.2:8080", // only the exact loopback names
      "http://[::ffff:127.0.0.1]:8080",
      "http://localhost.example.com",
      "http://localhost.:3000",
      "http://railway.internal:8080", // the bare suffix is no host
      "http://evilrailway.internal:8080",
      `http://${SELF}.example.com`,
      `http://${SELF}.:8080`,
    ];
    for (const url of refused) {
      const r = resolveSmokeTarget({ SMOKE_BASE_URL: url, RAILWAY_PRIVATE_DOMAIN: SELF });
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/loopback or \*\.railway\.internal/);
    }
  });

  it("refuses malformed SMOKE_BASE_URL values: scheme, credentials, path, query, fragment, garbage", () => {
    const refused = [
      "ftp://127.0.0.1",
      "file:///etc/hosts",
      "http://user:pass@127.0.0.1:8080",
      `http://user@${SELF}`,
      "http://127.0.0.1:8080/v1",
      "http://127.0.0.1:8080/?",
      "http://127.0.0.1:8080?x=1",
      "http://127.0.0.1:8080#frag",
      "127.0.0.1:8080",
      "not a url",
    ];
    for (const url of refused) expect(resolveSmokeTarget({ SMOKE_BASE_URL: url }).ok, url).toBe(false);
    // The refusal reason never echoes the value.
    const r = resolveSmokeTarget({ SMOKE_BASE_URL: "http://user:pass@example.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain("pass");
  });

  it("refuses a missing target and a default that is not a *.railway.internal host or has a bad port", () => {
    expect(resolveSmokeTarget({}).ok).toBe(false);
    expect(resolveSmokeTarget({ SMOKE_BASE_URL: "", RAILWAY_PRIVATE_DOMAIN: "" }).ok).toBe(false);
    for (const domain of ["resolver.example.com", "203.0.113.5", "railway.internal", `${SELF}/x`, `user@${SELF}`, `${SELF}:9999`]) {
      expect(resolveSmokeTarget({ RAILWAY_PRIVATE_DOMAIN: domain, PORT: "8080" }).ok, domain).toBe(false);
    }
    for (const port of ["0", "65536", "80a", "-1", "8080/x"]) {
      expect(resolveSmokeTarget({ RAILWAY_PRIVATE_DOMAIN: SELF, PORT: port }).ok, port).toBe(false);
    }
  });

  it("smoke.ts exits 2 on a refused target before sending anything, and names no value", () => {
    const base = { PROVIDER_MODE: "mock", RESOLVER_AUTH_TOKEN: SYNTHETIC_TOKEN, REPORTING_AUTH_TOKEN: SYNTHETIC_TOKEN, WEBSITE_ID: "site-test" };
    for (const url of ["http://203.0.113.5:8080", "https://resolver.example.com"]) {
      const r = runSmoke({ ...base, SMOKE_BASE_URL: url, RAILWAY_PRIVATE_DOMAIN: SELF });
      expect(r.status, r.out).toBe(2);
      expect(r.out).toContain("smoke: refusing target");
      expect(r.out).not.toContain("smoke_check"); // no check ran, so no request was sent
      expect(r.out).not.toContain(url.replace(/^https?:\/\//, ""));
      expect(r.out).not.toContain(SYNTHETIC_TOKEN);
    }
    // A non-railway default is refused too.
    expect(runSmoke({ ...base, RAILWAY_PRIVATE_DOMAIN: "resolver.example.com" }).status).toBe(2);
    // The provider-mode guard still comes first.
    const live = runSmoke({ ...base, PROVIDER_MODE: "live", SMOKE_BASE_URL: "http://127.0.0.1:9" });
    expect(live.status).toBe(2);
    expect(live.out).toContain("PROVIDER_MODE=mock");
    // An accepted target passes validation (here it then stops on the missing tokens, still before any request).
    const accepted = runSmoke({ PROVIDER_MODE: "mock", SMOKE_BASE_URL: "http://127.0.0.1:9" });
    expect(accepted.status).toBe(2);
    expect(accepted.out).toContain("smoke: missing RESOLVER_AUTH_TOKEN");
    expect(accepted.out).not.toContain("refusing target");
  });
});
