/**
 * The first-party collector endpoint (G5-D-F1). The entrance middleware never reports a request to this path,
 * whatever its method, and the collector route checks that it is mounted there.
 *
 * It must be the same value as the browser collector's `endpoint` and the path of the `createCollectorRoute`
 * server route. The documented default is `/idr/e`.
 */
export const DEFAULT_COLLECTOR_PATH = "/idr/e";

/**
 * The browser collector's `endpoint` rule without `*` (no wildcard) and `%` (no percent-encoding): a same-origin
 * absolute path, never `//host` or `/\host`, no query string or fragment, at most 256 characters.
 */
const COLLECTOR_PATH = /^\/(?![/\\])[\w\-.~!$&'()+,;=:@/]{0,255}$/;
const DOT_OR_EMPTY_SEGMENT = /\/\/|\/\.{1,2}(?:\/|$)/;

const INVALID = "idr-tanstack: collectorPath must be a plain same-origin path such as /idr/e (no query string, fragment, wildcard, percent-encoding, empty or dot segment; at most 256 characters)";

/**
 * Validates a configured collector path and returns its match key: lower case, without a trailing slash.
 * `undefined` and `null` give the default. Throws (without echoing the value) on anything else that is not a plain
 * path; `/` alone is refused, because it would exclude the home page.
 */
export function resolveCollectorPath(value: unknown): string {
  const raw = value === undefined || value === null ? DEFAULT_COLLECTOR_PATH : value;
  if (typeof raw !== "string" || !COLLECTOR_PATH.test(raw) || DOT_OR_EMPTY_SEGMENT.test(raw)) throw new Error(INVALID);
  const key = (raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw).toLowerCase();
  if (key === "/") throw new Error(INVALID);
  return key;
}

/** Decodes runs of percent-escapes as UTF-8; a run that is not valid UTF-8 has only its ASCII escapes decoded. */
function decodePercent(path: string): string {
  if (!path.includes("%")) return path;
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-7][0-9A-Fa-f])/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
}

/**
 * True when a request path (a `URL.pathname`, where the URL parser has already resolved `.`, `..`, `%2e` and `\`)
 * is the collector path in any spelling a router could dispatch to it: percent-encoded characters, upper or mixed
 * case (TanStack Router matches static segments case-insensitively by default), trailing slashes, and repeated
 * slashes. It deliberately over-excludes this one path's family (an encoded `%2F` separator, repeated inner slashes,
 * case variants on a case-sensitive router) and never matches anything else: `/idr/ex`, `/idr/e-mail`, `/idr` and
 * `/idr/e/x` are different paths. Linear in the path length.
 *
 * `key` is a value returned by `resolveCollectorPath`.
 */
export function isCollectorPath(pathname: string, key: string): boolean {
  if (pathname === key) return true;
  let p = decodePercent(pathname).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.toLowerCase() === key;
}
