/**
 * Target validation for the development smoke test (src/ops/smoke.ts),
 * kept pure so it can be unit tested without running the smoke test.
 *
 * The smoke test sends both bearer tokens of THIS service and is guarded by
 * THIS process's PROVIDER_MODE. That guard can only vouch for its own
 * environment, so the authenticated target is restricted to:
 *
 *   - the default: http://$RAILWAY_PRIVATE_DOMAIN:$PORT, i.e. this same
 *     service in this same environment (its PROVIDER_MODE is the one checked).
 *     RAILWAY_PRIVATE_DOMAIN must end in ".railway.internal";
 *   - SMOKE_BASE_URL whose host is loopback (127.0.0.1, [::1], localhost) or
 *     ends in ".railway.internal" (Railway's private network, encrypted in
 *     transit). Pointing it at another service is the operator's assertion
 *     that that service runs with PROVIDER_MODE=mock; the guard cannot check it.
 *
 * Any other host is refused: the tokens would leave the private network
 * (in clear text over http) and the guard would say nothing about the
 * target's provider mode. SMOKE_BASE_URL must be a bare http(s) origin: no
 * credentials, path, query or fragment.
 */

export type SmokeTargetKind = "railway_private_default" | "loopback" | "railway_internal";

export type SmokeTarget = { ok: true; base: string; kind: SmokeTargetKind } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const RAILWAY_INTERNAL_SUFFIX = ".railway.internal";

function isRailwayInternal(host: string): boolean {
  return host.length > RAILWAY_INTERNAL_SUFFIX.length && host.endsWith(RAILWAY_INTERNAL_SUFFIX);
}

function parseOrigin(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * The base URL the authenticated checks may use, from the smoke process's
 * environment, or the reason to refuse (exit 2).
 */
export function resolveSmokeTarget(env: Readonly<Record<string, string | undefined>>): SmokeTarget {
  const value = (name: string) => {
    const v = env[name];
    return v === undefined || v === "" ? undefined : v;
  };
  const explicit = value("SMOKE_BASE_URL");
  if (explicit !== undefined) {
    const u = parseOrigin(explicit);
    if (!u) return { ok: false, reason: "SMOKE_BASE_URL is not a valid URL" };
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "SMOKE_BASE_URL must use http or https" };
    if (u.username !== "" || u.password !== "") return { ok: false, reason: "SMOKE_BASE_URL must not carry credentials" };
    if ((u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "" || explicit.includes("?") || explicit.includes("#")) {
      return { ok: false, reason: "SMOKE_BASE_URL must be an origin (no path, query or fragment)" };
    }
    // WHATWG URL lower-cases the host and brackets IPv6 literals.
    const host = u.hostname;
    if (LOOPBACK_HOSTS.has(host)) return { ok: true, base: u.origin, kind: "loopback" };
    if (isRailwayInternal(host)) return { ok: true, base: u.origin, kind: "railway_internal" };
    return { ok: false, reason: "SMOKE_BASE_URL host must be loopback or *.railway.internal (the PROVIDER_MODE guard only vouches for this environment)" };
  }

  const privateDomain = value("RAILWAY_PRIVATE_DOMAIN");
  if (privateDomain === undefined) return { ok: false, reason: "no target: set RAILWAY_PRIVATE_DOMAIN (inside the service) or SMOKE_BASE_URL" };
  const port = value("PORT") ?? "8080";
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) return { ok: false, reason: "PORT is not a valid port" };
  const u = parseOrigin(`http://${privateDomain}:${port}`);
  // The parsed host must be exactly the domain given (no path, credentials or port smuggled in).
  if (!u || u.hostname !== privateDomain.toLowerCase() || !isRailwayInternal(u.hostname)) {
    return { ok: false, reason: "RAILWAY_PRIVATE_DOMAIN must be a *.railway.internal host name" };
  }
  return { ok: true, base: u.origin, kind: "railway_private_default" };
}
