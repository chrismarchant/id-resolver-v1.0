import { vi } from "vitest";
import { initCollector, type Collector, type CollectorOptions } from "../src/index.js";

export type BeaconMode = "ok" | "false" | "throw" | "absent";
export type FetchMode = "ok" | "reject" | "throw" | "hang";

export interface Sent {
  via: "beacon" | "fetch";
  url: string;
  /** The raw body string as it would go on the wire. */
  body: string;
  contentType: string;
  init?: RequestInit;
}

const live: Collector[] = [];
let sentRaw: Array<Promise<Sent>> = [];
let visibility: DocumentVisibilityState = "visible";

export interface Transport {
  beacon: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  /** Everything handed to sendBeacon or fetch so far, bodies resolved. */
  sent(): Promise<Sent[]>;
  /** Parsed bodies. */
  payloads(): Promise<Array<Record<string, unknown>>>;
}

/**
 * Replaces `navigator` (sendBeacon, GPC) and `fetch` with recording fakes. Nothing reaches the network.
 */
export function installTransport(opts: { beacon?: BeaconMode; fetch?: FetchMode; gpc?: boolean } = {}): Transport {
  sentRaw = [];
  const beaconMode = opts.beacon ?? "ok";
  const fetchMode = opts.fetch ?? "ok";
  const beacon = vi.fn((url: string, data: Blob) => {
    if (beaconMode === "throw") throw new TypeError("beacon refused");
    sentRaw.push(data.text().then((body) => ({ via: "beacon" as const, url, body, contentType: data.type })));
    return beaconMode === "ok";
  });
  const fetchFn = vi.fn((url: string, init: RequestInit) => {
    if (fetchMode === "throw") throw new TypeError("fetch refused");
    const headers = new Headers(init.headers);
    sentRaw.push(Promise.resolve({ via: "fetch" as const, url, body: String(init.body), contentType: headers.get("content-type") ?? "", init }));
    if (fetchMode === "reject") return Promise.reject(new TypeError("network down"));
    if (fetchMode === "hang") return new Promise<Response>(() => {});
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const nav: Record<string, unknown> = { userAgent: "test" };
  if (beaconMode !== "absent") nav["sendBeacon"] = beacon;
  if (opts.gpc !== undefined) nav["globalPrivacyControl"] = opts.gpc;
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("fetch", fetchFn);
  return {
    beacon,
    fetch: fetchFn,
    sent: () => Promise.all(sentRaw),
    payloads: async () => (await Promise.all(sentRaw)).map((s) => JSON.parse(s.body) as Record<string, unknown>),
  };
}

/** Starts a collector that is stopped automatically after the test. */
export function start(options: Partial<CollectorOptions> = {}): Collector {
  const c = initCollector({ endpoint: "/idr/e", allow: ["page_view"], consent: "not_required", ...options } as CollectorOptions);
  live.push(c);
  return c;
}

export function setVisibility(state: DocumentVisibilityState, dispatch = true): void {
  visibility = state;
  if (dispatch) document.dispatchEvent(new Event("visibilitychange"));
}

/** Sets the scroll geometry and dispatches a scroll event. */
export function scrollTo(scrollY: number, innerHeight = 1000, scrollHeight = 4000): void {
  Object.defineProperty(window, "scrollY", { value: scrollY, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: scrollHeight, configurable: true });
  window.dispatchEvent(new Event("scroll"));
}

/** Resets DOM state between tests. Builds the DOM with createElement, never with HTML strings. */
export function resetDom(path = "/pricing"): void {
  for (const c of live.splice(0)) c.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
  history.replaceState(null, "", path);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
  Object.defineProperty(document, "hidden", { get: () => visibility !== "visible", configurable: true });
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string, parent: Element = document.body): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export const CONTRACT_KEYS = ["consent", "event_id", "name", "occurred_at", "path", "type", "v"];

/** Strict validator for the browser-to-route body of event.v1 (docs/contracts/event.v1.md, section 1). */
export function validateBrowserEvent(body: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(CONTRACT_KEYS)) errors.push(`keys ${Object.keys(body).join(",")}`);
  if (body["v"] !== 1) errors.push("v");
  if (typeof body["event_id"] !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(body["event_id"])) errors.push("event_id");
  if (typeof body["occurred_at"] !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(body["occurred_at"])) errors.push("occurred_at");
  if (typeof body["path"] !== "string" || !body["path"].startsWith("/") || /[?#]/.test(body["path"])) errors.push("path");
  if (body["consent"] !== "granted" && body["consent"] !== "not_required") errors.push("consent");
  return errors;
}
