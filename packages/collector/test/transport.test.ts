import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IN_FLIGHT } from "../src/index.js";
import { installTransport, resetDom, start } from "./helpers.js";

beforeEach(() => resetDom("/pricing"));
afterEach(() => resetDom());

/** Collects page errors and unhandled rejections while `fn` runs plus a few ticks. */
async function pageErrors(fn: () => void | Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = [];
  const onError = (e: Event) => errors.push(e);
  const onNodeRejection = (r: unknown) => errors.push(r);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);
  process.on("unhandledRejection", onNodeRejection);
  try {
    await fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onError);
    process.off("unhandledRejection", onNodeRejection);
  }
  return errors;
}

describe("transport", () => {
  it("sendBeacon first: the endpoint path and a text/plain JSON blob; fetch is not used", async () => {
    const t = installTransport({ beacon: "ok" });
    start({ endpoint: "/_idr/e" });
    const [s] = await t.sent();
    expect(s).toMatchObject({ via: "beacon", url: "/_idr/e" });
    expect(s!.contentType.toLowerCase()).toBe("text/plain;charset=utf-8");
    expect(() => JSON.parse(s!.body)).not.toThrow();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["sendBeacon returns false", "false"],
    ["sendBeacon throws", "throw"],
    ["sendBeacon is missing", "absent"],
  ] as const)("%s: falls back to one same-origin keepalive fetch", async (_n, beacon) => {
    const t = installTransport({ beacon });
    start();
    const sent = await t.sent();
    const viaFetch = sent.filter((s) => s.via === "fetch");
    expect(viaFetch).toHaveLength(1);
    const f = viaFetch[0]!;
    expect(f.url).toBe("/idr/e");
    expect(f.contentType).toBe("application/json");
    expect(f.init).toMatchObject({ method: "POST", keepalive: true, credentials: "same-origin", mode: "same-origin", referrerPolicy: "no-referrer", cache: "no-store" });
    if (beacon === "false") expect(sent.find((s) => s.via === "beacon")!.body).toBe(f.body);
  });

  it("fetch rejects: dropped silently, no retry, no error or unhandled rejection reaches the page", async () => {
    const t = installTransport({ beacon: "false", fetch: "reject" });
    const errors = await pageErrors(() => {
      const c = start({ allow: ["page_view", "cta_click"] });
      c.track("cta_click");
    });
    expect(errors).toEqual([]);
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("fetch throws synchronously: dropped silently", async () => {
    const t = installTransport({ beacon: "absent", fetch: "throw" });
    const errors = await pageErrors(() => {
      const c = start({ allow: ["page_view", "cta_click"] });
      expect(() => c.track("cta_click")).not.toThrow();
    });
    expect(errors).toEqual([]);
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it(`bounded: at most ${MAX_IN_FLIGHT} fallback fetches in flight; the rest are dropped`, async () => {
    const t = installTransport({ beacon: "false", fetch: "hang" });
    const c = start({ allow: ["page_view", "cta_click"] });
    for (let i = 0; i < 10; i++) c.track("cta_click");
    expect(t.fetch).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
  });

  it("a slot is released when a fetch settles", async () => {
    let release: (() => void) | undefined;
    const t = installTransport({ beacon: "false" });
    t.fetch.mockImplementation(() => new Promise<Response>((r) => (release = () => r(new Response(null, { status: 204 })))));
    const c = start({ allow: ["page_view", "cta_click"] });
    for (let i = 0; i < 10; i++) c.track("cta_click");
    expect(t.fetch).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    c.track("cta_click");
    expect(t.fetch).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);
  });

  it("an event whose body would exceed the route's 1 KiB limit is not sent", async () => {
    history.replaceState(null, "", "/" + "a".repeat(1100));
    const t = installTransport();
    start();
    expect(await t.sent()).toHaveLength(0);
  });

  it("no network at all (neither sendBeacon nor fetch): nothing throws", async () => {
    installTransport({ beacon: "absent" });
    vi.stubGlobal("fetch", undefined);
    const errors = await pageErrors(() => {
      const c = start({ allow: ["page_view", "cta_click"] });
      c.track("cta_click");
    });
    expect(errors).toEqual([]);
  });
});
