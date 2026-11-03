import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_EVENTS_PER_DOCUMENT, MAX_EVENTS_PER_PAGE } from "../src/index.js";
import { el, installTransport, resetDom, scrollTo, setVisibility, start } from "./helpers.js";

beforeEach(() => resetDom("/pricing"));
afterEach(() => resetDom());

const names = async (t: ReturnType<typeof installTransport>) => (await t.payloads()).map((p) => `${p["name"]}@${p["path"]}`);

describe("page_view", () => {
  it("one page_view for the initial view, with type page_view and the path", async () => {
    const t = installTransport();
    start();
    const [p] = await t.payloads();
    expect(p).toMatchObject({ v: 1, type: "page_view", name: "page_view", path: "/pricing", consent: "not_required" });
    expect(Date.parse(p!["occurred_at"] as string)).toBeLessThanOrEqual(Date.now());
  });

  it("spa: false: route changes are not page views and history is not touched", async () => {
    const t = installTransport();
    const push = history.pushState;
    start({ spa: false });
    expect(history.pushState).toBe(push);
    history.pushState(null, "", "/about");
    expect(await names(t)).toEqual(["page_view@/pricing"]);
  });

  it("spa: true without the Navigation API: pushState, replaceState and popstate path changes are page views", async () => {
    const t = installTransport();
    expect((globalThis as { navigation?: unknown }).navigation).toBeUndefined();
    start({ spa: true });
    history.pushState({ a: 1 }, "", "/about");
    history.replaceState(null, "", "/contact");
    history.pushState(null, "", "/contact?tab=2#x"); // same path: not a new page view
    history.replaceState(null, "", "/contact"); // same path
    history.pushState(null, "", "/blog");
    history.replaceState(null, "", "/pricing");
    window.dispatchEvent(new PopStateEvent("popstate")); // path unchanged since the last page view
    expect(await names(t)).toEqual(["page_view@/pricing", "page_view@/about", "page_view@/contact", "page_view@/blog", "page_view@/pricing"]);
  });

  it("the history hook calls the original with the same arguments and this, and lets its errors through", () => {
    installTransport();
    const calls: unknown[][] = [];
    const original = history.pushState;
    history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
      calls.push([this, ...args]);
      if (args[2] === "/boom") throw new DOMException("refused", "SecurityError");
      return original.apply(this, args);
    };
    try {
      start({ spa: true });
      history.pushState({ s: 1 }, "", "/x");
      expect(calls).toEqual([[history, { s: 1 }, "", "/x"]]);
      expect(() => history.pushState(null, "", "/boom")).toThrow("refused");
    } finally {
      resetDom();
      history.pushState = original;
    }
  });

  it("stop() restores history.pushState/replaceState; if another script wrapped them later, ours stays inert", async () => {
    const t = installTransport();
    const push = history.pushState;
    const replace = history.replaceState;
    const c = start({ spa: true });
    expect(history.pushState).not.toBe(push);
    c.stop();
    expect(history.pushState).toBe(push);
    expect(history.replaceState).toBe(replace);

    const c2 = start({ spa: true });
    const ours = history.pushState;
    const theirs = function (this: History, ...a: Parameters<History["pushState"]>) {
      return ours.apply(this, a);
    };
    history.pushState = theirs;
    c2.stop();
    expect(history.pushState).toBe(theirs); // not clobbered
    history.pushState(null, "", "/after-stop");
    expect(await names(t)).toEqual(["page_view@/pricing", "page_view@/pricing"]);
    history.pushState = push;
  });

  it("spa: true with the Navigation API: uses currententrychange and does not patch history", async () => {
    const t = installTransport();
    const navigation = new EventTarget();
    vi.stubGlobal("navigation", navigation);
    const push = history.pushState;
    const c = start({ spa: true });
    expect(history.pushState).toBe(push);
    history.pushState(null, "", "/docs");
    navigation.dispatchEvent(new Event("currententrychange"));
    history.pushState(null, "", "/docs#section");
    navigation.dispatchEvent(new Event("currententrychange"));
    expect(await names(t)).toEqual(["page_view@/pricing", "page_view@/docs"]);
    c.stop();
    history.pushState(null, "", "/later");
    navigation.dispatchEvent(new Event("currententrychange"));
    expect(await names(t)).toHaveLength(2);
  });
});

describe("scroll_50 / scroll_90", () => {
  it("fire at 50% and 90% of the page, at most once per page view, and again after an SPA navigation", async () => {
    const t = installTransport();
    start({ allow: ["page_view", "scroll_50", "scroll_90"], spa: true });
    scrollTo(0); // 25% seen
    scrollTo(1000); // 50%
    scrollTo(1100);
    scrollTo(500);
    scrollTo(2600); // 90%
    scrollTo(3000);
    history.pushState(null, "", "/next");
    scrollTo(3000); // both at once on the new page
    scrollTo(3000);
    expect(await names(t)).toEqual(["page_view@/pricing", "scroll_50@/pricing", "scroll_90@/pricing", "page_view@/next", "scroll_50@/next", "scroll_90@/next"]);
  });

  it("no scroll listener when neither scroll name is allowlisted", () => {
    installTransport();
    const add = vi.spyOn(window, "addEventListener");
    start({ allow: ["page_view"] });
    expect(add.mock.calls.map((c) => c[0])).not.toContain("scroll");
  });
});

describe("engaged_30s", () => {
  it("counts visible time only, fires once per page view", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = installTransport();
    start({ allow: ["page_view", "engaged_30s"] });
    vi.advanceTimersByTime(20_000); // 20 s visible
    setVisibility("hidden");
    vi.advanceTimersByTime(60_000); // hidden time does not count
    expect(await names(t)).toEqual(["page_view@/pricing"]);
    setVisibility("visible");
    vi.advanceTimersByTime(9_999); // 29.999 s visible
    expect(await names(t)).toEqual(["page_view@/pricing"]);
    vi.advanceTimersByTime(1); // 30 s
    vi.advanceTimersByTime(120_000);
    expect(await names(t)).toEqual(["page_view@/pricing", "engaged_30s@/pricing"]);
  });

  it("a page that starts hidden counts from when it becomes visible; an SPA navigation restarts the count", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    setVisibility("hidden", false);
    const t = installTransport();
    start({ allow: ["page_view", "engaged_30s"], spa: true });
    vi.advanceTimersByTime(45_000);
    expect(await names(t)).toEqual(["page_view@/pricing"]);
    setVisibility("visible");
    vi.advanceTimersByTime(25_000);
    history.pushState(null, "", "/next"); // restart: 25 s on /pricing is lost
    vi.advanceTimersByTime(29_000);
    expect(await names(t)).toEqual(["page_view@/pricing", "page_view@/next"]);
    vi.advanceTimersByTime(1_000);
    expect(await names(t)).toEqual(["page_view@/pricing", "page_view@/next", "engaged_30s@/next"]);
  });

  it("no timer at all when engaged_30s is not allowlisted, and stop() clears a running timer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    installTransport();
    start({ allow: ["page_view"] });
    expect(vi.getTimerCount()).toBe(0);
    const c = start({ allow: ["page_view", "engaged_30s"] });
    expect(vi.getTimerCount()).toBe(1);
    c.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("marked elements and forms", () => {
  it("a click on (or inside) a data-idr-event element sends that allowlisted name", async () => {
    const t = installTransport();
    start({ allow: ["page_view", "cta_click", "video_start"] });
    const cta = el("div", { "data-idr-event": "cta_click" });
    const icon = el("span", {}, undefined, cta);
    icon.click();
    el("button", { "data-idr-event": "video_start" }).click();
    el("button", {}, "unmarked").click();
    expect(await names(t)).toEqual(["page_view@/pricing", "cta_click@/pricing", "video_start@/pricing"]);
  });

  it("form_start once per marked form per page view; form_submit per submit; unmarked forms ignored", async () => {
    const t = installTransport();
    start({ allow: ["page_view", "form_start", "form_submit"], spa: true });
    const a = el("form", { "data-idr-form": "" });
    const a1 = el("input", {}, undefined, a);
    const a2 = el("input", {}, undefined, a);
    const b = el("form", { "data-idr-form": "newsletter" });
    const b1 = el("input", {}, undefined, b);
    const plain = el("form");
    const p1 = el("input", {}, undefined, plain);
    for (const x of [a1, a2, a1, b1, p1]) x.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    a.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    plain.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    history.pushState(null, "", "/next");
    a1.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(await names(t)).toEqual(["page_view@/pricing", "form_start@/pricing", "form_start@/pricing", "form_submit@/pricing", "page_view@/next", "form_start@/next"]);
  });

  it("listeners are passive: the collector never cancels a click or a submit", () => {
    installTransport();
    start({ allow: ["page_view", "cta_click", "form_submit"] });
    const button = el("button", { "data-idr-event": "cta_click" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    const form = el("form", { "data-idr-form": "" });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(false);
  });
});

describe("bounds", () => {
  it(`at most ${MAX_EVENTS_PER_PAGE} events per page view; the budget resets on an SPA navigation`, async () => {
    const t = installTransport();
    const c = start({ allow: ["page_view", "cta_click"], spa: true });
    for (let i = 0; i < 100; i++) c.track("cta_click");
    expect(await t.payloads()).toHaveLength(MAX_EVENTS_PER_PAGE);
    history.pushState(null, "", "/next");
    c.track("cta_click");
    const all = await names(t);
    expect(all).toHaveLength(MAX_EVENTS_PER_PAGE + 2);
    expect(all.slice(-2)).toEqual(["page_view@/next", "cta_click@/next"]);
  });

  it(`at most ${MAX_EVENTS_PER_DOCUMENT} events per document, however many SPA navigations`, async () => {
    const t = installTransport();
    const c = start({ allow: ["page_view", "cta_click"], spa: true });
    for (let i = 0; i < 200; i++) {
      history.pushState(null, "", `/p${i}`);
      c.track("cta_click");
    }
    expect(await t.payloads()).toHaveLength(MAX_EVENTS_PER_DOCUMENT);
  });

  it("every body is far below the route's 1 KiB limit", async () => {
    history.replaceState(null, "", "/" + "a".repeat(600));
    const t = installTransport();
    start();
    const [s] = await t.sent();
    expect(new TextEncoder().encode(s!.body).length).toBeLessThan(1024);
  });
});
