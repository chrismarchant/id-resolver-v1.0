/**
 * The first-party collector endpoint (G5-D-F1). The entrance middleware never reports a request to this path,
 * whatever its method, and the collector route checks that it is mounted there.
 *
 * It must be the same value as the browser collector's `endpoint`: the full request path as the browser sends it
 * (including any router `basepath`). The documented default is `/idr/e`.
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

// ---------------------------------------------------------------------------------------------------------------
// Pass 1: the router's own canonicalisation (G5R2-L1).
//
// Derived from the TanStack versions the repository's probe app pins (packages/tanstack/verification/cf-lifecycle
// lockfile: @tanstack/start-server-core 1.169.39, @tanstack/router-core 1.171.34). Before a server route or a page
// is chosen, start-server-core does:
//   createStartHandler.js:281  const { url, handledProtocolRelativeURL } = getNormalizedURL(request.url)
//   createStartHandler.js:284  a pathname that starts with "//" is answered with a 308 redirect (no dispatch)
//   createStartHandler.js:479  executeRewriteInput(router.rewrite, url).pathname   (basepath / input rewrites)
//   createStartHandler.js:480  router.getMatchedRoutes(pathname)
// router-core:
//   ssr/ssr-server.js:365-376  getNormalizedURL: `url.replace("\\", "%5C")`; `new URL(url)`; leading slashes of a
//                              "//" path collapsed; `decodePath(pathname)`; then `new URL(decodedPathname + query +
//                              hash, origin)`: a second WHATWG parse, which strips leading and trailing C0 controls
//                              and spaces, removes tab and newline, resolves dot segments and percent-encodes what
//                              it must (space, non-ASCII, ...)
//   utils.js:173-176           sanitizePathSegment: re-encodes [\x00-\x1f\x7f"<>`{}] after decoding
//   utils.js:177-188           decodeSegment: decodeURI, or per-escape decodeURI when the whole segment is invalid
//   utils.js:257-271           decodePath: decodeSegment between the escapes %25 and %5C, which stay encoded
//   router.js:235-243          getMatchedRoutes -> findRouteMatch(trimPathRight(pathname))
//   path.js:18-21              trimPathRight: a path longer than "/" that ends in "/" loses every trailing slash
//   route-tree module (dist/esm/new-*-route-tree.js, home of processRouteTree):
//                              :285-286 findMatch: path.split("/"); :502-503 static segments compared with
//                              part.toLowerCase() when the router is not caseSensitive (router.js:634 and :249 there:
//                              default false)
//
// So the router reaches the collector route for `/idr/e%20` (decodePath gives "/idr/e ", and the second URL parse
// strips the trailing space; a decoded control character is re-encoded by sanitizePathSegment first, so a space is
// the only one) and for `/x/%2%65%2%65/idr/e` (a stray "%" and the decoded "2e" form "%2e%2e", which the second
// parse resolves as a parent segment). Instead of special-casing such families, pass 1 repeats each step;
// test/collector-path-router.test.ts compares it with the installed router itself.

const PATH_UNSAFE = /[\x00-\x1f\x7f"<>`{}]/g;

/** router-core utils.js:173-176. */
function sanitizePathSegment(segment: string): string {
  return segment.replace(PATH_UNSAFE, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** A "%" that does not start an ASCII escape ("%" plus two hex digits below 80). */
const NOT_AN_ASCII_ESCAPE = /%(?![0-7][0-9A-Fa-f])/;

/** decodeURI leaves an escape of one of these as it is (ECMA-262 reservedURISet plus "#"). */
const URI_RESERVED = new Set([";", "/", "?", ":", "@", "&", "=", "+", "$", ",", "#"]);

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

/** The byte of the escape "%XX" at index i, or -1 when there is none. */
function escapeAt(s: string, i: number): number {
  if (i + 3 > s.length || s.charCodeAt(i) !== 37) return -1;
  const hi = hexValue(s.charCodeAt(i + 1));
  const lo = hexValue(s.charCodeAt(i + 2));
  return hi < 0 || lo < 0 ? -1 : hi * 16 + lo;
}

/**
 * decodeURI(s), or null where decodeURI throws a URIError (ECMA-262 Decode: a "%" without two hex digits, or escapes
 * that are not one valid UTF-8 sequence: a lone continuation byte, a truncated or overlong sequence, a surrogate, a
 * code point above U+10FFFF). Written without exceptions, which cost microseconds per escape on hostile input. The
 * tests compare it with decodeURI itself on random input.
 */
export function decodeUriOrNull(s: string): string | null {
  if (!s.includes("%")) return s;
  // Only ASCII escapes: decodeURI cannot throw, and the native one is faster.
  if (!NOT_AN_ASCII_ESCAPE.test(s)) return decodeURI(s);
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) !== 37) {
      const next = s.indexOf("%", i);
      const end = next === -1 ? s.length : next;
      out += s.slice(i, end);
      i = end;
      continue;
    }
    const b = escapeAt(s, i);
    if (b < 0) return null;
    if (b < 0x80) {
      const ch = String.fromCharCode(b);
      out += URI_RESERVED.has(ch) ? s.slice(i, i + 3) : ch;
      i += 3;
      continue;
    }
    let n: number;
    let cp: number;
    if ((b & 0xe0) === 0xc0) [n, cp] = [2, b & 0x1f];
    else if ((b & 0xf0) === 0xe0) [n, cp] = [3, b & 0x0f];
    else if ((b & 0xf8) === 0xf0) [n, cp] = [4, b & 0x07];
    else return null;
    for (let k = 1; k < n; k++) {
      const cb = escapeAt(s, i + 3 * k);
      if (cb < 0 || (cb & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (cp < (n === 2 ? 0x80 : n === 3 ? 0x800 : 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += 3 * n;
  }
  return out;
}

/**
 * router-core utils.js:177-188: decodeURI(segment); when that throws, each escape on its own (decodeURI of a single
 * escape decodes an ASCII byte that is not reserved and throws otherwise, so the escape stays).
 */
function decodeSegment(segment: string): string {
  const decoded =
    decodeUriOrNull(segment) ??
    segment.replace(/%[0-9A-F]{2}/gi, (match) => {
      const b = parseInt(match.slice(1), 16);
      const ch = String.fromCharCode(b);
      return b < 0x80 && !URI_RESERVED.has(ch) ? ch : match;
    });
  return sanitizePathSegment(decoded);
}

/** router-core utils.js:257-271: %25 and %5C stay encoded, everything between them is decoded. */
function decodePath(path: string): string {
  if (!path || !/[%\\\x00-\x1f\x7f]/.test(path)) return path;
  const re = /%25|%5C/gi;
  let cursor = 0;
  let result = "";
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    result += decodeSegment(path.slice(cursor, match.index)) + match[0];
    cursor = re.lastIndex;
  }
  return result + decodeSegment(path.slice(cursor));
}

/**
 * router-core path.js:18-21 trimPathRight: when the path is longer than "/" and ends with "/", every trailing slash
 * is removed (so "//" becomes ""). Written as a loop: linear for any input.
 */
function trimTrailingSlashes(path: string): string {
  if (path.length <= 1 || path.charCodeAt(path.length - 1) !== 0x2f) return path;
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/**
 * The pathname the router matches routes against, for a request whose `URL.pathname` is `pathname`
 * (ssr-server.js:365-376, then trimPathRight). Two deliberate differences, both over-exclusion only:
 *  - a pathname that starts with "//" is canonicalised as its redirect target (the router answers 308 there);
 *  - the query string is not considered: with one, the router keeps trailing spaces, and this function strips them.
 * Returns null if the second parse fails (the router would then not dispatch at all). Linear in the path length.
 */
export function routerPathname(pathname: string): string | null {
  const start = pathname.startsWith("//") ? pathname.replace(/^\/+/, "/") : pathname;
  let reparsed: string;
  try {
    reparsed = new URL(decodePath(start), "http://canonical.invalid").pathname;
  } catch {
    return null;
  }
  return trimTrailingSlashes(reparsed);
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 2: deliberate over-exclusion of the collector path's own family (kept from Gate 5): ASCII percent-escapes
// decoded (including %2F and %5C, which the router keeps encoded), backslashes and repeated slashes treated as one
// separator, one trailing slash dropped, compared in lower case. It matches spellings the router does not dispatch
// to the route (for example /idr%2Fe, /idr//e) and never a different path. Non-ASCII escapes stay encoded: they can
// never equal a key, which is plain ASCII.

function decodeAsciiEscapes(path: string): string {
  if (!path.includes("%")) return path;
  // Only ASCII escapes: decodeURIComponent decodes exactly those and cannot throw.
  if (!NOT_AN_ASCII_ESCAPE.test(path)) return decodeURIComponent(path);
  return path.replace(/%([0-7][0-9A-Fa-f])/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function broadPathname(pathname: string): string {
  let p = decodeAsciiEscapes(pathname).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * True when a request path (a `URL.pathname`) is the collector path: when the router would dispatch it to the
 * collector route (pass 1, the router's own canonicalisation, compared case-insensitively as the router does by
 * default), or when it is a deliberately over-excluded spelling of the same path (pass 2). Never a different path:
 * `/idr/ex`, `/idr/e-mail`, `/idr`, `/idr/e/x` and `/idr/x%20` stay eligible. Linear in the path length.
 *
 * `key` is a value returned by `resolveCollectorPath`.
 */
export function isCollectorPath(pathname: string, key: string): boolean {
  if (pathname === key) return true;
  const routed = routerPathname(pathname);
  if (routed !== null && routed.toLowerCase() === key) return true;
  return broadPathname(pathname).toLowerCase() === key;
}
