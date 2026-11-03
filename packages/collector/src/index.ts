import { EVENT_VOCABULARY, type EventName, type EventType } from "./vocabulary.js";

export { EVENT_VOCABULARY, type EventName, type EventType } from "./vocabulary.js";

/**
 * `required`: nothing is observed or sent until the consent hooks say yes.
 * `not_required`: the site has decided that no consent is needed (the hooks are not consulted).
 * `off`: nothing is ever observed or sent.
 */
export type ConsentMode = "required" | "not_required" | "off";

export interface CollectorOptions {
  /** Same-origin path of the site's first-party route, for example `/idr/e`. Absolute, protocol-relative and cross-origin URLs are refused at init. */
  endpoint: string;
  /** The event names this site collects: a subset of `event-vocabulary.v1`. Anything else is dropped. */
  allow: readonly EventName[];
  consent: ConsentMode;
  /** Consent-management hook: `true` once the visitor has granted consent. In `required` mode it is asked before every event. */
  hasConsent?: () => boolean;
  /**
   * Consent-management hook: the collector registers a listener that the CMP calls with each new decision. It may
   * return an unsubscribe function, which `stop()` calls. Without it, a grant made after init is picked up only by
   * the next `track()` call.
   */
  onConsentChange?: (listener: (granted: boolean) => void) => void | (() => void);
  /** Report same-document route changes (SPA navigations) as page views. Default `false`. */
  spa?: boolean;
}

export interface Collector {
  /** Sends one allowlisted event for the current page. Anything else is dropped silently. Never throws. */
  track(name: string): void;
  /** Removes every listener, timer and history hook and unsubscribes from the CMP. Never throws. */
  stop(): void;
}

/** The exact body sent to the first-party route (`event.v1`, section 1). It has no other field. */
export interface CollectorEvent {
  v: 1;
  event_id: string;
  occurred_at: string;
  type: EventType;
  name: EventName;
  path: string;
  consent: "granted" | "not_required";
}

/** Events per page view; further events on that page view are dropped. */
export const MAX_EVENTS_PER_PAGE = 30;
/** Events per document (bounds an SPA that navigates in a loop). */
export const MAX_EVENTS_PER_DOCUMENT = 300;
/** `fetch` fallbacks in flight at once; an event beyond that is dropped. */
export const MAX_IN_FLIGHT = 4;
/** The first-party route's body limit (event.v1). */
const MAX_BODY_BYTES = 1024;

const ENGAGED_MS = 30_000;
const ONCE_PER_PAGE = ["scroll_50", "scroll_90", "engaged_30s"];
/** A path starting with exactly one `/` (never `//` or `/\`, which browsers read as another host), no query or fragment. */
const ENDPOINT = /^\/(?![/\\])[\w\-.~!$&'()*+,;=:@%/]{0,255}$/;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function fail(what: string): never {
  throw new TypeError("idr-collector: " + what);
}

/** 22 base64url characters from `crypto.getRandomValues` (132 bits; 256 is a multiple of 64, so `& 63` is unbiased). Never stored. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  let id = "";
  for (const b of bytes) id += ID_ALPHABET.charAt(b & 63);
  return id;
}

const marked = (target: EventTarget | null, selector: string): Element | null => (target instanceof Element ? target.closest(selector) : null);

/**
 * Starts the collector. Invalid options throw a `TypeError` here, at init; after that nothing the collector does
 * throws into the page. Without a DOM (server-side rendering) it returns an inert collector.
 */
export function initCollector(options: CollectorOptions): Collector {
  const o: Partial<CollectorOptions> = options ?? {};
  const endpoint = o.endpoint;
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) fail("endpoint must be a same-origin path such as /idr/e");
  const typeOf = new Map<string, EventType>();
  for (const type of Object.keys(EVENT_VOCABULARY.types) as EventType[]) for (const name of EVENT_VOCABULARY.types[type]) typeOf.set(name, type);
  const allow = new Set<string>();
  if (!Array.isArray(o.allow)) fail("allow must be an array of event-vocabulary.v1 names");
  for (const name of o.allow as readonly unknown[]) {
    if (typeof name !== "string" || !typeOf.has(name)) fail("allow must be an array of event-vocabulary.v1 names");
    allow.add(name);
  }
  const mode = o.consent;
  if (mode !== "required" && mode !== "not_required" && mode !== "off") fail('consent must be "required", "not_required" or "off"');
  const hasConsent = typeof o.hasConsent === "function" ? o.hasConsent : undefined;
  const onConsentChange = typeof o.onConsentChange === "function" ? o.onConsentChange : undefined;
  if (mode === "required" && !hasConsent && !onConsentChange) fail('consent "required" needs hasConsent or onConsentChange');

  const inert: Collector = { track() {}, stop() {} };
  if (typeof document === "undefined" || typeof location === "undefined") return inert;
  if (new URL(endpoint, location.href).origin !== location.origin) fail("endpoint must be same-origin");
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  // Global Privacy Control is an opt-out signal: never observe, never send.
  if (mode === "off" || nav.globalPrivacyControl === true) return inert;

  let stopped = false;
  let active = false;
  let pushed: boolean | undefined;
  let unsubscribe: (() => void) | undefined;
  const cleanups: Array<() => void> = [];
  let path = "";
  let pageCount = 0;
  let documentCount = 0;
  let inFlight = 0;
  let once = new Set<string>();
  let startedForms = new WeakSet<Element>();
  let visibleMs = 0;
  let visibleSince: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const consented = (): boolean => {
    if (stopped || nav.globalPrivacyControl === true) return false;
    if (mode === "not_required") return true;
    if (pushed === false) return false;
    if (!hasConsent) return pushed === true;
    try {
      return hasConsent() === true;
    } catch {
      return false;
    }
  };

  /** Beacon first (text/plain, a CORS-safelisted type), then one same-origin keepalive fetch. Failures are dropped. */
  const send = (event: CollectorEvent): void => {
    const body = JSON.stringify(event);
    // The route refuses bodies over 1 KiB (only a very long path gets there); ASCII JSON, so length = bytes.
    if (body.length > MAX_BODY_BYTES) return;
    try {
      if (nav.sendBeacon(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
    } catch {
      // No sendBeacon, or it threw: fall back to fetch.
    }
    if (inFlight >= MAX_IN_FLIGHT) return;
    inFlight++;
    const done = (): void => {
      inFlight--;
    };
    try {
      fetch(endpoint, {
        method: "POST",
        body,
        keepalive: true,
        credentials: "same-origin",
        mode: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
      }).then(done, done);
    } catch {
      done();
    }
  };

  const emit = (name: string): void => {
    try {
      const type = typeOf.get(name);
      if (!type || !allow.has(name) || once.has(name) || !sync()) return;
      if (pageCount >= MAX_EVENTS_PER_PAGE || documentCount >= MAX_EVENTS_PER_DOCUMENT) return;
      if (ONCE_PER_PAGE.includes(name)) once.add(name);
      pageCount++;
      documentCount++;
      send({
        v: 1,
        event_id: randomId(),
        occurred_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        type,
        name: name as EventName,
        path: location.pathname,
        consent: mode === "required" ? "granted" : "not_required",
      });
    } catch {
      // Never into the page.
    }
  };

  const listen = (target: EventTarget, type: string, fn: (event: Event) => void, capture = true): void => {
    const handler = (event: Event): void => {
      try {
        fn(event);
      } catch {
        // Never into the page.
      }
    };
    target.addEventListener(type, handler, { capture, passive: true });
    cleanups.push(() => target.removeEventListener(type, handler, { capture }));
  };

  /** engaged_30s: counts visible time only; the timer runs only while the page is visible. */
  const arm = (): void => {
    clearTimeout(timer);
    if (active && visibleSince !== undefined && allow.has("engaged_30s") && !once.has("engaged_30s")) {
      timer = setTimeout(tick, Math.max(0, ENGAGED_MS - visibleMs));
    }
  };
  const settleVisible = (): void => {
    const now = Date.now();
    if (visibleSince !== undefined) visibleMs += now - visibleSince;
    visibleSince = document.visibilityState === "visible" ? now : undefined;
  };
  const tick = (): void => {
    try {
      settleVisible();
      if (visibleMs >= ENGAGED_MS) emit("engaged_30s");
      else arm();
    } catch {
      // Never into the page.
    }
  };
  const onVisibility = (): void => {
    settleVisible();
    arm();
  };

  const onScroll = (): void => {
    const height = document.documentElement.scrollHeight;
    if (height > 0) {
      const seen = (scrollY + innerHeight) / height;
      if (seen >= 0.5) emit("scroll_50");
      if (seen >= 0.9) emit("scroll_90");
    }
  };
  // Only the developer-set attribute value is read: never text, href, value or any other attribute.
  const onClick = (event: Event): void => {
    const element = marked(event.target, "[data-idr-event]");
    if (element) emit(element.getAttribute("data-idr-event") ?? "");
  };
  // Forms: only the fact of first focus / submit. No value, field name, element list or FormData is ever read.
  const onFocusIn = (event: Event): void => {
    const form = marked(event.target, "form[data-idr-form]");
    if (form && !startedForms.has(form)) {
      startedForms.add(form);
      emit("form_start");
    }
  };
  const onSubmit = (event: Event): void => {
    if (marked(event.target, "form[data-idr-form]")) emit("form_submit");
  };

  const newPage = (): void => {
    path = location.pathname;
    pageCount = 0;
    once = new Set();
    startedForms = new WeakSet();
    visibleMs = 0;
    visibleSince = document.visibilityState === "visible" ? Date.now() : undefined;
    arm();
    emit("page_view");
  };
  const onNavigate = (): void => {
    if (active && location.pathname !== path) newPage();
  };

  /**
   * SPA navigations. The Navigation API observes every same-document URL change (router pushState included)
   * without patching anything. Where it is missing: popstate plus a history hook that calls the original
   * first, returns its result, lets its exceptions through untouched, never throws itself, and is removed on
   * stop() (left in place as a no-op only if another script wrapped history after it).
   */
  const watchNavigation = (): void => {
    const navigation = (globalThis as { navigation?: EventTarget }).navigation;
    if (navigation && typeof navigation.addEventListener === "function") {
      listen(navigation, "currententrychange", onNavigate);
      return;
    }
    listen(window, "popstate", onNavigate);
    for (const key of ["pushState", "replaceState"] as const) {
      const original = history[key];
      const hooked = function (this: History, ...args: Parameters<History["pushState"]>): void {
        original.apply(this, args);
        try {
          onNavigate();
        } catch {
          // Never into the page.
        }
      };
      history[key] = hooked;
      cleanups.push(() => {
        if (history[key] === hooked) history[key] = original;
      });
    }
  };

  /** Observes nothing before consent: listeners exist only while consent holds. */
  const activate = (): void => {
    active = true;
    if (allow.has("scroll_50") || allow.has("scroll_90")) listen(window, "scroll", onScroll, false);
    if (allow.has("engaged_30s")) listen(document, "visibilitychange", onVisibility);
    listen(document, "click", onClick);
    if (allow.has("form_start")) listen(document, "focusin", onFocusIn);
    if (allow.has("form_submit")) listen(document, "submit", onSubmit);
    if (o.spa === true) watchNavigation();
    newPage();
  };
  const deactivate = (): void => {
    active = false;
    clearTimeout(timer);
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Never into the page.
      }
    }
  };
  function sync(): boolean {
    const ok = consented();
    if (ok && !active) activate();
    else if (!ok && active) deactivate();
    return ok;
  }

  if (mode === "required" && onConsentChange) {
    try {
      const off = onConsentChange((granted) => {
        try {
          pushed = granted === true;
          sync();
        } catch {
          // Never into the CMP.
        }
      });
      if (typeof off === "function") unsubscribe = off;
    } catch {
      // A throwing CMP hook leaves consent where it was.
    }
  }
  try {
    sync();
  } catch {
    // Never into the page.
  }

  return {
    track(name: string): void {
      try {
        emit(String(name));
      } catch {
        // Never into the page.
      }
    },
    stop(): void {
      try {
        stopped = true;
        deactivate();
        unsubscribe?.();
      } catch {
        // Never into the page.
      }
    },
  };
}
