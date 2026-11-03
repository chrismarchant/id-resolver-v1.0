import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_VOCABULARY, initCollector, type CollectorOptions, type EventName } from "../src/index.js";
import { CONTRACT_KEYS, el, installTransport, resetDom, start, validateBrowserEvent } from "./helpers.js";

const ALL = Object.values(EVENT_VOCABULARY.types).flat() as EventName[];

beforeEach(() => resetDom("/pricing"));
afterEach(() => resetDom());

describe("collector privacy: what can never leave the page", () => {
  it("a filled form: no payload contains any value, field name, id, placeholder, label or action", async () => {
    const t = installTransport();
    const form = el("form", { "data-idr-form": "", action: "/submit-secret-action", id: "signup-form-id" });
    const label = el("label", { for: "email-field-id" }, "Your secret label", form);
    const input = el("input", { name: "secret_field_name", id: "email-field-id", placeholder: "secret placeholder" }, undefined, form);
    const area = el("textarea", { name: "secret_area_name" }, undefined, form);
    input.value = "person@example.com";
    area.value = "my secret message";
    expect(label).toBeTruthy();
    start({ allow: ["page_view", "form_start", "form_submit"] });
    input.focus();
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    area.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const sent = await t.sent();
    expect((await t.payloads()).map((p) => p["name"])).toEqual(["page_view", "form_start", "form_submit"]);
    const wire = sent.map((s) => s.body).join("\n");
    for (const secret of ["person@example.com", "my secret message", "secret_field_name", "secret_area_name", "email-field-id", "secret placeholder", "Your secret label", "submit-secret-action", "signup-form-id", "example.com"]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("text content, link URLs and attribute values other than data-idr-event never appear in a payload", async () => {
    const t = installTransport();
    const link = el("a", { href: "https://files.example.com/secret-report.pdf?token=abc123", "data-idr-event": "file_download", title: "secret title" }, "Download the secret report");
    const out = el("a", { href: "https://partner.example.net/secret-path", "data-idr-event": "outbound_link" }, "Partner secret text");
    const cta = el("button", { "data-idr-event": "cta_click", "aria-label": "secret aria" }, "Book a secret demo");
    const inner = el("span", {}, "nested secret span", cta);
    el("p", {}, "Paragraph with a secret sentence");
    // The DOM environment would follow the links; a real browser sends the beacon from the capture-phase
    // listener before it navigates. Cancel the navigation (bubble phase, after the collector) to stay on the page.
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener("click", stay);
    start({ allow: ["page_view", "file_download", "outbound_link", "cta_click"] });
    link.click();
    out.click();
    inner.click(); // a click on a child of the marked element
    document.removeEventListener("click", stay);
    const payloads = await t.payloads();
    expect(payloads.map((p) => p["name"])).toEqual(["page_view", "file_download", "outbound_link", "cta_click"]);
    expect(payloads.every((p) => p["path"] === "/pricing")).toBe(true);
    const wire = (await t.sent()).map((s) => s.body).join("\n");
    for (const secret of ["secret", "example.com", "example.net", "token", "abc123", ".pdf", "Download", "Partner", "Paragraph", "aria", "title", "href"]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("sends location.pathname only: never the query string, fragment, host or referrer", async () => {
    history.replaceState(null, "", "/reset/abc?email=person%40example.com&token=s3cr3t#frag-secret");
    const t = installTransport();
    start();
    const [p] = await t.payloads();
    expect(p!["path"]).toBe("/reset/abc");
    const wire = (await t.sent())[0]!.body;
    for (const secret of ["email", "token", "s3cr3t", "frag", "example.com", "www."]) expect(wire).not.toContain(secret);
  });

  it("payload keys are exactly the event.v1 browser fields, for every vocabulary name", async () => {
    const t = installTransport();
    const c = start({ allow: ALL });
    for (const name of ALL) c.track(name);
    const payloads = await t.payloads();
    expect(payloads.length).toBeGreaterThanOrEqual(ALL.length);
    for (const p of payloads) {
      expect(Object.keys(p).sort()).toEqual(CONTRACT_KEYS);
      expect(validateBrowserEvent(p)).toEqual([]);
      const type = p["type"] as keyof typeof EVENT_VOCABULARY.types;
      expect((EVENT_VOCABULARY.types[type] as readonly string[]).includes(p["name"] as string)).toBe(true);
    }
  });

  it("event_ids are unique, base64url, at least 16 characters, and come from crypto.getRandomValues", async () => {
    const t = installTransport();
    const spy = vi.spyOn(crypto, "getRandomValues");
    const c = start({ allow: ["page_view", "cta_click"] });
    for (let i = 0; i < 20; i++) c.track("cta_click");
    const ids = (await t.payloads()).map((p) => p["event_id"] as string);
    expect(ids).toHaveLength(21);
    expect(new Set(ids).size).toBe(21);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(spy).toHaveBeenCalledTimes(21);
  });

  it("no crypto.getRandomValues: nothing is sent (there is no Math.random fallback)", async () => {
    const t = installTransport();
    const random = vi.spyOn(Math, "random");
    vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("unavailable");
    });
    const c = start({ allow: ["page_view", "cta_click"] });
    c.track("cta_click");
    expect(await t.sent()).toHaveLength(0);
    expect(random).not.toHaveBeenCalled();
  });

  it("never touches cookies, localStorage, sessionStorage or indexedDB", async () => {
    installTransport();
    const touched: string[] = [];
    const cookie = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document), "cookie") ?? Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", { get: () => (touched.push("cookie:get"), ""), set: () => void touched.push("cookie:set"), configurable: true });
    const trap = (name: string) => new Proxy({}, { get: () => (touched.push(name), () => null) });
    vi.stubGlobal("localStorage", trap("localStorage"));
    vi.stubGlobal("sessionStorage", trap("sessionStorage"));
    vi.stubGlobal("indexedDB", trap("indexedDB"));
    try {
      const c = start({ allow: ALL, spa: true });
      el("button", { "data-idr-event": "cta_click" }).click();
      history.pushState(null, "", "/next");
      c.track("pricing_view");
      expect(touched).toEqual([]);
    } finally {
      delete (document as unknown as Record<string, unknown>)["cookie"];
      if (cookie) expect(cookie).toBeTruthy();
    }
  });
});

describe("collector: endpoint is refused at init unless it is a same-origin path", () => {
  it.each([
    ["absolute https", "https://www.example.com/idr/e"],
    ["absolute cross-origin", "https://collector.example.net/idr/e"],
    ["protocol-relative", "//collector.example.net/idr/e"],
    ["backslash host", "/\\collector.example.net/idr/e"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/plain,x"],
    ["relative without slash", "idr/e"],
    ["with query", "/idr/e?x=1"],
    ["with fragment", "/idr/e#x"],
    ["whitespace", "/idr/ e"],
    ["empty", ""],
    ["not a string", 42 as unknown as string],
  ])("%s", (_name, endpoint) => {
    installTransport();
    expect(() => initCollector({ endpoint, allow: ["page_view"], consent: "not_required" })).toThrow(/idr-collector: endpoint/);
  });

  it("accepts a same-origin path", () => {
    installTransport();
    expect(() => start({ endpoint: "/_idr/e" })).not.toThrow();
  });
});

describe("collector: option validation at init", () => {
  it.each([
    ["unknown name in allow", { allow: ["page_view", "rage_click"] }],
    ["allow is not an array", { allow: "page_view" }],
    ["inherited property name", { allow: ["constructor"] }],
    ["bad consent mode", { consent: "maybe" }],
    ["required without any consent hook", { consent: "required" }],
  ])("%s throws", (_name, over) => {
    installTransport();
    expect(() => initCollector({ endpoint: "/idr/e", allow: ["page_view"], consent: "not_required", ...over } as unknown as CollectorOptions)).toThrow(/idr-collector/);
  });
});

describe("collector: Global Privacy Control", () => {
  it("navigator.globalPrivacyControl === true: nothing is ever sent, in any consent mode, and no listener is added", async () => {
    for (const consent of ["not_required", "required"] as const) {
      const t = installTransport({ gpc: true });
      const add = vi.spyOn(document, "addEventListener");
      const addWin = vi.spyOn(window, "addEventListener");
      let listener: ((g: boolean) => void) | undefined;
      const c = start({ consent, allow: ALL, spa: true, hasConsent: () => true, onConsentChange: (l) => void (listener = l) });
      listener?.(true);
      c.track("cta_click");
      el("button", { "data-idr-event": "cta_click" }).click();
      history.pushState(null, "", "/next-" + consent);
      expect(await t.sent()).toHaveLength(0);
      expect(t.beacon).not.toHaveBeenCalled();
      expect(t.fetch).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(addWin).not.toHaveBeenCalled();
      add.mockRestore();
      addWin.mockRestore();
    }
  });

  it("globalPrivacyControl false or absent does not block", async () => {
    const t = installTransport({ gpc: false });
    start();
    expect(await t.payloads()).toHaveLength(1);
  });
});

describe("collector: consent", () => {
  it("off: nothing is ever sent and nothing is observed, even if the hooks say yes", async () => {
    const t = installTransport();
    const add = vi.spyOn(document, "addEventListener");
    const hook = vi.fn(() => true);
    const sub = vi.fn();
    const c = start({ consent: "off", allow: ALL, spa: true, hasConsent: hook, onConsentChange: sub });
    c.track("cta_click");
    el("button", { "data-idr-event": "cta_click" }).click();
    expect(await t.sent()).toHaveLength(0);
    expect(hook).not.toHaveBeenCalled();
    expect(sub).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("required + hasConsent false: nothing is sent and no listener is attached until consent is granted", async () => {
    const t = installTransport();
    let granted = false;
    let notify: ((g: boolean) => void) | undefined;
    const add = vi.spyOn(document, "addEventListener");
    const c = start({ consent: "required", allow: ["page_view", "cta_click", "scroll_50"], hasConsent: () => granted, onConsentChange: (l) => void (notify = l) });
    const button = el("button", { "data-idr-event": "cta_click" });
    button.click();
    c.track("cta_click");
    expect(await t.sent()).toHaveLength(0);
    expect(add).not.toHaveBeenCalled();

    granted = true;
    notify!(true);
    button.click();
    const payloads = await t.payloads();
    expect(payloads.map((p) => p["name"])).toEqual(["page_view", "cta_click"]);
    expect(payloads.every((p) => p["consent"] === "granted")).toBe(true);
  });

  it("required: a revocation stops sending at once and removes the listeners", async () => {
    const t = installTransport();
    let granted = true;
    let notify: ((g: boolean) => void) | undefined;
    const remove = vi.spyOn(document, "removeEventListener");
    const c = start({ consent: "required", allow: ["page_view", "cta_click"], hasConsent: () => granted, onConsentChange: (l) => void (notify = l) });
    const button = el("button", { "data-idr-event": "cta_click" });
    button.click();
    granted = false;
    notify!(false);
    expect(remove).toHaveBeenCalled();
    button.click();
    c.track("cta_click");
    expect((await t.payloads()).map((p) => p["name"])).toEqual(["page_view", "cta_click"]);
  });

  it("required with only hasConsent: checked before every event, and a later grant starts on the next track()", async () => {
    const t = installTransport();
    let granted = false;
    const hook = vi.fn(() => granted);
    const c = start({ consent: "required", allow: ["page_view", "pricing_view"], hasConsent: hook });
    c.track("pricing_view");
    expect(await t.sent()).toHaveLength(0);
    granted = true;
    c.track("pricing_view");
    expect((await t.payloads()).map((p) => p["name"])).toEqual(["page_view", "pricing_view"]);
    granted = false;
    c.track("pricing_view");
    expect(await t.sent()).toHaveLength(2);
  });

  it("required with only onConsentChange: the pushed decision is used; a pushed false wins over hasConsent", async () => {
    const t = installTransport();
    let notify: ((g: boolean) => void) | undefined;
    const c = start({ consent: "required", allow: ["page_view", "cta_click"], onConsentChange: (l) => void (notify = l) });
    c.track("cta_click");
    expect(await t.sent()).toHaveLength(0);
    notify!(true);
    c.track("cta_click");
    notify!(false);
    c.track("cta_click");
    expect((await t.payloads()).map((p) => p["name"])).toEqual(["page_view", "cta_click"]);
  });

  it("a throwing hasConsent counts as no consent and never reaches the page", async () => {
    const t = installTransport();
    const c = start({
      consent: "required",
      allow: ["page_view", "cta_click"],
      hasConsent: () => {
        throw new Error("cmp broke");
      },
    });
    expect(() => c.track("cta_click")).not.toThrow();
    expect(await t.sent()).toHaveLength(0);
  });

  it("a throwing onConsentChange registration does not throw from init", () => {
    installTransport();
    expect(() =>
      start({
        consent: "required",
        onConsentChange: () => {
          throw new Error("cmp broke");
        },
      }),
    ).not.toThrow();
  });

  it("stop() calls the CMP unsubscribe and nothing is sent afterwards", async () => {
    const t = installTransport();
    let notify: ((g: boolean) => void) | undefined;
    const unsubscribe = vi.fn();
    const c = start({ consent: "required", allow: ["page_view", "cta_click"], onConsentChange: (l) => ((notify = l), unsubscribe) });
    c.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    notify!(true);
    c.track("cta_click");
    expect(await t.sent()).toHaveLength(0);
  });

  it("not_required: the consent field says not_required and the hooks are not consulted", async () => {
    const t = installTransport();
    const hook = vi.fn(() => false);
    start({ consent: "not_required", hasConsent: hook });
    const [p] = await t.payloads();
    expect(p!["consent"]).toBe("not_required");
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("collector: allowlist", () => {
  it("drops names outside the allowlist, outside the vocabulary, and from marked elements that are not allowlisted", async () => {
    const t = installTransport();
    const c = start({ allow: ["page_view", "cta_click"] });
    for (const name of ["pricing_view", "rage_click", "__proto__", "constructor", "toString", "", "PAGE_VIEW", "cta_click "]) c.track(name);
    el("button", { "data-idr-event": "demo_request_start" }).click();
    el("button", { "data-idr-event": "made_up" }).click();
    el("button", { "data-idr-event": "cta_click" }).click();
    expect((await t.payloads()).map((p) => p["name"])).toEqual(["page_view", "cta_click"]);
  });

  it("page_view itself is dropped when it is not allowlisted", async () => {
    const t = installTransport();
    const c = start({ allow: ["cta_click"] });
    c.track("cta_click");
    expect((await t.payloads()).map((p) => p["name"])).toEqual(["cta_click"]);
  });

  it("track() never throws, whatever it is given", () => {
    installTransport();
    const c = start();
    for (const bad of [undefined, null, 1, {}, Symbol("x"), () => 1]) expect(() => c.track(bad as unknown as string)).not.toThrow();
  });
});
