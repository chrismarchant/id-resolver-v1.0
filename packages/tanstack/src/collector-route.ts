import { isCollectorPath } from "./collector-path.js";
import { intIn, resolveDelivery, type ResolvedDelivery, type ResolverDeliveryOptions } from "./config.js";
import { deliverEvent } from "./delivery.js";
import { formatOccurredAt, normalisePageKey } from "./payload.js";
import { fire, scheduleDelivery, skipped, type DeliveryHook, type InFlight } from "./schedule.js";
import { EVENT_CONTRACT, type EventPayload } from "./types.js";
import { EVENT_VOCABULARY, type EventName } from "./vocabulary.js";

/**
 * `required` (default, like the resolver's `EVENT_CONSENT_MODE`): only events carrying `consent: "granted"` (and
 * passing `hasConsent`, when set) are accepted. `not_required`: `granted` and `not_required` are accepted. `off`:
 * every event is refused. Use the same mode as the resolver, or the resolver refuses what this route forwards.
 */
export type CollectorConsentMode = "required" | "not_required" | "off";

/**
 * Options of the first-party collector route. The resolver connection, delivery and `page_key` options are the
 * same as the entrance middleware's, so one shared object can be spread into both. There is no trust policy:
 * this route never reads a client IP.
 */
export interface CollectorRouteOptions extends ResolverDeliveryOptions {
  /** Site allowlist: the event names this site accepts, a subset of `event-vocabulary.v1`. */
  allow: readonly EventName[];
  /** Default `"required"`. */
  consent?: CollectorConsentMode;
  /**
   * Server-side consent check in `required` mode, for example reading your consent platform's cookie. The browser's
   * claim alone is then not enough: `false`, a throw or a rejection refuses the event (403), and so does a hook that
   * has not settled within `consentTimeoutMs` (fail closed).
   */
  hasConsent?: (request: Request) => boolean | Promise<boolean>;
  /** How long `hasConsent` may take before the event is refused as without consent (403). 10..10000, default 1000. */
  consentTimeoutMs?: number;
  /** How long reading the request body may take before the request is refused (408) and the body cancelled. 100..60000, default 5000. */
  bodyTimeoutMs?: number;
  /**
   * Accepted `Origin` values (`scheme://host[:port]`). Default: the origin of the request URL. Set it when a proxy
   * in front of the app changes the scheme or host of the request URL.
   */
  origins?: readonly string[];
  /** Accepted distance of `occurred_at` from server time, in either direction. 5000..240000, default 120000. */
  maxClockSkewMs?: number;
  /** Accepted `event_id`s remembered for replay detection, per route instance. 100..100000, default 10000. */
  replayCacheSize?: number;
  /** Accepted events per window, per route instance (never per client or IP). Default 600 per 60000 ms. */
  rateLimit?: { events?: number; windowMs?: number };
}

/** A TanStack Start server-route handler (`server.handlers.POST`). A plain `Request` is accepted too. */
export type CollectorRouteHandler = (ctx: { request: Request } | Request) => Promise<Response>;

interface ResolvedCollector extends ResolvedDelivery {
  allow: ReadonlySet<string>;
  consent: CollectorConsentMode;
  hasConsent: ((request: Request) => boolean | Promise<boolean>) | undefined;
  consentTimeoutMs: number;
  bodyTimeoutMs: number;
  origins: readonly string[] | undefined;
  maxClockSkewMs: number;
  replayCacheSize: number;
  rateEvents: number;
  rateWindowMs: number;
}

/** The route's body limit (`event.v1`, section 1). */
export const COLLECTOR_MAX_BODY_BYTES = 1024;
const BODY_KEYS = ["v", "event_id", "occurred_at", "type", "name", "path", "consent"];
const EVENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PATH_FORBIDDEN = /[\s\u0000-\u001f\u007f\\]/;
const PATH_MAX = 1024;
const TYPE_OF: ReadonlyMap<string, string> = new Map(Object.entries(EVENT_VOCABULARY.types).flatMap(([type, names]) => names.map((name) => [name, type] as const)));

function resolveCollector(options: CollectorRouteOptions): ResolvedCollector {
  const delivery = resolveDelivery(options);
  if (!Array.isArray(options.allow) || !options.allow.every((n: unknown) => typeof n === "string" && TYPE_OF.has(n))) {
    throw new Error("idr-tanstack: allow must be an array of event-vocabulary.v1 names");
  }
  const consent = options.consent ?? "required";
  if (consent !== "required" && consent !== "not_required" && consent !== "off") throw new Error("idr-tanstack: consent must be required, not_required or off");
  if (options.hasConsent !== undefined && typeof options.hasConsent !== "function") throw new Error("idr-tanstack: hasConsent must be a function");
  let origins: string[] | undefined;
  if (options.origins !== undefined) {
    if (!Array.isArray(options.origins)) throw new Error("idr-tanstack: origins must be an array of origins such as https://www.example.com");
    origins = options.origins.map((o: unknown) => {
      let u: URL | undefined;
      try {
        u = new URL(String(o));
      } catch {
        u = undefined;
      }
      if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== o) throw new Error("idr-tanstack: origins must be an array of origins such as https://www.example.com");
      return u.origin;
    });
  }
  const rate = options.rateLimit ?? {};
  return {
    ...delivery,
    allow: new Set(options.allow),
    consent,
    hasConsent: options.hasConsent,
    consentTimeoutMs: intIn("consentTimeoutMs", options.consentTimeoutMs, 10, 10_000, 1_000),
    bodyTimeoutMs: intIn("bodyTimeoutMs", options.bodyTimeoutMs, 100, 60_000, 5_000),
    origins,
    maxClockSkewMs: intIn("maxClockSkewMs", options.maxClockSkewMs, 5_000, 240_000, 120_000),
    replayCacheSize: intIn("replayCacheSize", options.replayCacheSize, 100, 100_000, 10_000),
    rateEvents: intIn("rateLimit.events", rate.events, 1, 100_000, 600),
    rateWindowMs: intIn("rateLimit.windowMs", rate.windowMs, 1_000, 3_600_000, 60_000),
  };
}

/**
 * Accepted event_ids, oldest first. An entry lives `ttlMs` (twice the clock-skew window: any replay that the
 * window would still accept is caught) or until `max` newer ids push it out. The resolver also stores at most one
 * row per event_id, so an id that falls out of this cache early is still recorded once.
 */
class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}
  has(id: string, now: number): boolean {
    for (const [key, expires] of this.seen) {
      if (expires > now) break;
      this.seen.delete(key);
    }
    return this.seen.has(id);
  }
  add(id: string, now: number): void {
    this.seen.set(id, now + this.ttlMs);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

/** Fixed-window budget for the whole route instance. It is not keyed by IP or by anything else about a client. */
class RateBudget {
  private windowStart = Number.NEGATIVE_INFINITY;
  private used = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  take(now: number): boolean {
    if (now - this.windowStart >= this.windowMs || now < this.windowStart) {
      this.windowStart = now;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}

interface State {
  cfg: ResolvedCollector;
  replay: ReplayCache;
  rate: RateBudget;
  inFlight: InFlight;
  /** `skipped/collector:path_mismatch` was reported (at most once per route instance). */
  pathMismatchReported: boolean;
}

const newState = (cfg: ResolvedCollector): State => ({ cfg, replay: new ReplayCache(cfg.replayCacheSize, 2 * cfg.maxClockSkewMs), rate: new RateBudget(cfg.rateEvents, cfg.rateWindowMs), inFlight: { n: 0 }, pathMismatchReported: false });

/** No body, no cookie, never cached. */
function bare(status: number): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (status === 405) headers["allow"] = "POST";
  return new Response(null, { status, headers });
}

const TOO_LARGE = Symbol("too_large");
const TIMED_OUT = Symbol("timed_out");

/** A promise that resolves TIMED_OUT after `ms`, and the function that clears its timer (always call it). */
function expiry(ms: number): { expired: Promise<typeof TIMED_OUT>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return { expired, clear: () => clearTimeout(timer) };
}

/**
 * Reads at most COLLECTOR_MAX_BODY_BYTES within `timeoutMs` (CHR-66 G4-I3: a slow-dripping body cannot hold the
 * request open). Stops and cancels the stream as soon as either limit is passed.
 */
async function readLimited(request: Request, timeoutMs: number): Promise<string | null | typeof TOO_LARGE | typeof TIMED_OUT> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,12}$/.test(declared.trim())) return null;
    if (Number(declared) > COLLECTOR_MAX_BODY_BYTES) return TOO_LARGE;
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = expiry(timeoutMs);
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline.expired]);
      if (next === TIMED_OUT) {
        void reader.cancel().catch(() => {});
        return TIMED_OUT;
      }
      const { done, value } = next;
      if (done) break;
      if (!ArrayBuffer.isView(value)) {
        void reader.cancel().catch(() => {});
        return null;
      }
      total += value.byteLength;
      if (total > COLLECTOR_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch {
    return null;
  } finally {
    deadline.clear();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface BrowserEvent {
  event_id: string;
  occurred_at: string;
  type: string;
  name: string;
  path: string;
  consent: "granted" | "not_required";
}

/** Strict schema: exactly the seven fields, each well-formed. Returns the rejection reason as a string. */
function parseEvent(raw: unknown): BrowserEvent | "schema" | "path" {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "schema";
  const keys = Object.keys(raw);
  if (keys.length !== BODY_KEYS.length || !BODY_KEYS.every((k) => Object.prototype.hasOwnProperty.call(raw, k))) return "schema";
  const r = raw as Record<string, unknown>;
  const { event_id, occurred_at, type, name, path, consent } = r;
  if (r["v"] !== 1) return "schema";
  if (typeof event_id !== "string" || !EVENT_ID.test(event_id)) return "schema";
  if (typeof occurred_at !== "string" || !OCCURRED_AT.test(occurred_at)) return "schema";
  if (typeof type !== "string" || typeof name !== "string") return "schema";
  if (consent !== "granted" && consent !== "not_required") return "schema";
  // The path only: no query string, no fragment, nothing a URL parser could read as another host.
  if (typeof path !== "string" || path.length > PATH_MAX || !path.startsWith("/") || path.includes("?") || path.includes("#") || PATH_FORBIDDEN.test(path)) return "path";
  return { event_id, occurred_at, type, name, path, consent };
}

/**
 * The site's consent hook, bounded by `timeoutMs` (CHR-66 G4-I3). Only a `true` that arrives in time is consent:
 * `false`, any other value, a throw, a rejection and a hook still pending at the deadline all refuse (fail closed).
 * The deadline cannot interrupt a hook that blocks synchronously.
 */
async function askConsent(hook: (request: Request) => boolean | Promise<boolean>, request: Request, timeoutMs: number): Promise<boolean | typeof TIMED_OUT> {
  const deadline = expiry(timeoutMs);
  try {
    const answer = await Promise.race([Promise.resolve().then(() => hook(request)), deadline.expired]);
    return answer === TIMED_OUT ? TIMED_OUT : answer === true;
  } catch {
    return false;
  } finally {
    deadline.clear();
  }
}

/**
 * First-party collector route for TanStack Start (`event.v1`, browser to website server).
 *
 *   createFileRoute("/idr/e")({ server: { handlers: { POST: createCollectorRoute(() => options) } } })
 *
 * Checks, in this order: method POST; `Origin` is a site origin and `Sec-Fetch-Site` (when present) is
 * `same-origin`; content type; body at most 1 KiB, read with a hard limit and within `bodyTimeoutMs` (else 408);
 * strict schema; vocabulary and site allowlist; consent policy (mode, `Sec-GPC: 1`, `hasConsent` within
 * `consentTimeoutMs`, else 403); the `occurred_at` window; the `event_id` replay cache; the per-instance rate
 * budget. An accepted event is answered `204` at once and forwarded to
 * `<resolverUrl>/v1/events` on the shared non-blocking path (`waitUntil`, detached, or drop); its outcome goes
 * to `onDeliveryResult`. A refused one gets a bare `4xx`. Responses have no body, no cookie and
 * `Cache-Control: no-store`.
 *
 * It reads only the `Origin`, `Sec-Fetch-Site`, `Content-Type`, `Content-Length` and `Sec-GPC` request headers and
 * forwards none of them: never an IP header, user agent, cookie or referrer. What it forwards is the website id
 * plus the validated fields, with `path` mapped to `page_key` by the same composed mapper as the middleware.
 *
 * `options` may be a function, evaluated on the first request. A lazily found configuration error disables the
 * route (every POST is answered `204` and dropped) and is reported once as `skipped/config_invalid`.
 *
 * Mount it at `collectorPath` (default `/idr/e`), the path the entrance middleware never reports. When a POST
 * arrives on another path, `skipped/collector:path_mismatch` is reported once; the answer is unchanged.
 */
export function createCollectorRoute(options: CollectorRouteOptions | (() => CollectorRouteOptions)): CollectorRouteHandler {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error("idr-tanstack: createCollectorRoute must only run on the server");
  }
  let state: State | null = typeof options === "function" ? null : newState(resolveCollector(options));
  let failed = false;

  function current(): State | null {
    if (state) return state;
    if (failed || typeof options !== "function") return null;
    let raw: CollectorRouteOptions | undefined;
    try {
      raw = options();
      state = newState(resolveCollector(raw));
      return state;
    } catch {
      failed = true;
      const hook: DeliveryHook | undefined = typeof raw?.onDeliveryResult === "function" ? raw.onDeliveryResult : undefined;
      void fire(hook, skipped("config_invalid", Date.now()));
      return null;
    }
  }

  async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    if (request.method !== "POST") return bare(405);
    const s = current();
    if (!s) return bare(204);
    const c = s.cfg;
    const reject = (status: number, reason: string): Response => {
      void fire(c.onDeliveryResult, skipped(`collector:${reason}`, started));
      return bare(status);
    };
    // A signal only, never a refusal: the route is mounted at a path other than `collectorPath`, so the entrance
    // middleware (which excludes `collectorPath`) does not exclude this route's path. Reported once per instance.
    if (!s.pathMismatchReported) {
      let path: string | null = null;
      try {
        path = new URL(request.url).pathname;
      } catch {
        path = null;
      }
      if (path !== null && !isCollectorPath(path, c.collectorPath)) {
        s.pathMismatchReported = true;
        void fire(c.onDeliveryResult, skipped("collector:path_mismatch", started));
      }
    }

    // 2. CSRF-style origin checks.
    const origin = request.headers.get("origin");
    let allowed = c.origins;
    if (!allowed) {
      try {
        allowed = [new URL(request.url).origin];
      } catch {
        allowed = [];
      }
    }
    if (origin === null || !allowed.includes(origin)) return reject(403, "origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite !== null && fetchSite !== "same-origin") return reject(403, "sec_fetch_site");
    // 3. Content type.
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "text/plain") return reject(415, "content_type");
    // 4. Size, with a hard limit.
    const text = await readLimited(request, c.bodyTimeoutMs);
    if (text === TIMED_OUT) return reject(408, "body_timeout");
    if (text === TOO_LARGE) return reject(413, "too_large");
    if (text === null) return reject(400, "malformed");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return reject(400, "malformed");
    }
    // 5. Strict schema.
    const event = parseEvent(raw);
    if (typeof event === "string") return reject(400, event);
    // 6. Vocabulary, then the site allowlist.
    if (TYPE_OF.get(event.name) !== event.type) return reject(400, "vocabulary");
    if (!c.allow.has(event.name)) return reject(403, "not_allowed");
    // 7. Consent policy: the server decides, whatever the browser claims.
    if (c.consent === "off") return reject(403, "consent_off");
    if (request.headers.get("sec-gpc") === "1") return reject(403, "gpc");
    if (c.consent === "required") {
      if (event.consent !== "granted") return reject(403, "consent");
      if (c.hasConsent) {
        const consent = await askConsent(c.hasConsent, request, c.consentTimeoutMs);
        if (consent === TIMED_OUT) return reject(403, "consent_timeout");
        if (!consent) return reject(403, "consent");
      }
    }
    // 8. occurred_at window.
    const at = Date.parse(event.occurred_at);
    const now = Date.now();
    if (!Number.isFinite(at) || Math.abs(now - at) > c.maxClockSkewMs) return reject(400, "occurred_at");
    // 9. Replay cache; 10. rate budget. An id is remembered only once the event is accepted.
    if (s.replay.has(event.event_id, now)) return reject(409, "replay");
    if (!s.rate.take(now)) return reject(429, "rate");
    s.replay.add(event.event_id, now);

    const payload: EventPayload = {
      contract: EVENT_CONTRACT,
      website_id: c.websiteId,
      event_id: event.event_id,
      occurred_at: formatOccurredAt(new Date(at)),
      type: event.type,
      name: event.name,
      page_key: normalisePageKey(event.path, c.pageKeyMapper),
      consent: event.consent,
    };
    await scheduleDelivery(request, c, s.inFlight, started, (mode, allowRetry, timeoutMs) => deliverEvent(c, payload, { mode, allowRetry, timeoutMs }));
    return bare(204);
  }

  return async function idrCollectorRoute(ctx: { request: Request } | Request): Promise<Response> {
    const request = (ctx as { request?: Request }).request ?? (ctx as Request);
    try {
      return await handle(request);
    } catch {
      return bare(400);
    }
  };
}
