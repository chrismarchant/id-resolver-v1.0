// @vitest-environment node
//
// Runs the shipped bundle in a real headless Chrome under a strict Content-Security-Policy (no unsafe-eval, no
// unsafe-inline, Trusted Types enforced, connect-src 'self'), against a local stand-in for the first-party route.
// Skipped (reported as skipped, never silently green) when no Chrome/Chromium binary is found; set CHROME_PATH to
// point at one. IDR_REQUIRE_BROWSER=1 turns a missing browser into a failure.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleCollector } from "../scripts/bundle.mjs";
import { Browser, findChrome } from "./cdp.js";

const CHROME = findChrome();
const REQUIRE = process.env["IDR_REQUIRE_BROWSER"] === "1";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
  "report-uri /csp-report",
].join("; ");

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>csp probe</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head>
<body>
<button id="cta" data-idr-event="cta_click">Book a secret demo</button>
<a id="dl" href="/files/secret-report.pdf?token=abc123" data-idr-event="file_download">Download the secret report</a>
<form id="f" data-idr-form action="/submit-secret"><label for="email">Secret label</label><input id="email" name="secret_field_name"><button type="submit">Send</button></form>
<div class="tall">Paragraph with a secret sentence</div>
</body></html>`;

const APP = `import { initCollector } from "/collector.js";
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective + " " + e.blockedURI));
window.__violations = violations;
// The site's own handlers keep the test on the page (an SPA would do the same).
document.getElementById("f").addEventListener("submit", (e) => e.preventDefault());
document.getElementById("dl").addEventListener("click", (e) => e.preventDefault());
window.__collector = initCollector({
  endpoint: "/idr/e",
  allow: ["page_view", "cta_click", "file_download", "form_start", "form_submit", "scroll_50", "scroll_90", "engaged_30s"],
  consent: "not_required",
  spa: true,
});
window.__ready = true;`;

// Positive control: proves this browser enforces the policy (each attempt must be blocked).
const CONTROL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/control.js"></script></head><body><p id="p"></p></body></html>`;
const CONTROL = `const blocked = {};
const attempt = (name, fn) => { try { fn(); blocked[name] = false; } catch { blocked[name] = true; } };
attempt("eval", () => eval("1"));
attempt("Function", () => new Function("return 1")());
attempt("innerHTML", () => { document.getElementById("p").innerHTML = "<b>x</b>"; });
attempt("stringTimer", () => setTimeout("1", 0));
blocked.crossOriginFetch = await fetch("http://127.0.0.2:9/x").then(() => false, () => true);
window.__control = blocked;`;

interface Hit {
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

describe.skipIf(!CHROME && !REQUIRE)("real browser (headless Chrome) under a strict CSP", () => {
  let server: http.Server;
  let base = "";
  let browser: Browser;
  const hits: Hit[] = [];
  const reports: string[] = [];

  beforeAll(async () => {
    if (!CHROME) throw new Error("IDR_REQUIRE_BROWSER=1 but no Chrome/Chromium found (set CHROME_PATH)");
    const collector = await bundleCollector();
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://placeholder.invalid").pathname;
        const send = (status: number, type: string, text: string) => res.writeHead(status, { "content-type": type, "content-security-policy": CSP, "cache-control": "no-store" }).end(text);
        if (req.method === "POST" && url === "/idr/e") {
          hits.push({ url, body, headers: req.headers });
          return res.writeHead(204, { "cache-control": "no-store" }).end();
        }
        if (req.method === "POST" && url === "/csp-report") {
          reports.push(body);
          return res.writeHead(204).end();
        }
        if (url === "/collector.js") return send(200, "text/javascript", collector);
        if (url === "/app.js") return send(200, "text/javascript", APP);
        if (url === "/control.js") return send(200, "text/javascript", CONTROL);
        if (url === "/app.css") return send(200, "text/css", ".tall{height:6000px}");
        if (url === "/control") return send(200, "text/html; charset=utf-8", CONTROL_PAGE);
        if (url === "/page" || url.startsWith("/page/")) return send(200, "text/html; charset=utf-8", PAGE);
        return send(404, "text/plain", "not found");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await Browser.launch(CHROME);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  const waitForHits = async (n: number) => {
    const end = Date.now() + 15_000;
    while (hits.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };

  it("control: this browser enforces the policy (eval, Function, innerHTML, string timers and cross-origin fetch are blocked)", async () => {
    await browser.navigate(`${base}/control`);
    await browser.waitFor("window.__control");
    expect(await browser.eval("window.__control")).toEqual({ eval: true, Function: true, innerHTML: true, stringTimer: true, crossOriginFetch: true });
  });

  it("the collector loads and runs with zero CSP violations; beacons reach the same-origin route with exactly the contract fields", async () => {
    reports.length = 0;
    browser.exceptions.length = 0;
    browser.consoleErrors.length = 0;
    await browser.navigate(`${base}/page`);
    await browser.waitFor("window.__ready");
    await waitForHits(1);
    await browser.eval(`(() => {
      document.getElementById("cta").click();
      document.getElementById("dl").click();
      const input = document.getElementById("email");
      input.value = "person@example.com";
      input.focus();
      document.getElementById("f").requestSubmit();
      window.scrollTo(0, document.documentElement.scrollHeight);
      return true;
    })()`);
    await waitForHits(7);
    await browser.eval(`history.pushState(null, "", "/page/next?token=abc123#frag"); window.__collector.track("cta_click"); true`);
    await waitForHits(9);

    const bodies = hits.map((h) => JSON.parse(h.body) as Record<string, unknown>);
    const seen = bodies.map((b) => `${b["name"]}@${b["path"]}`);
    expect(seen.slice(0, 2)).toEqual(["page_view@/page", "cta_click@/page"]);
    expect(new Set(seen)).toEqual(new Set(["page_view@/page", "cta_click@/page", "file_download@/page", "form_start@/page", "form_submit@/page", "scroll_50@/page", "scroll_90@/page", "page_view@/page/next", "cta_click@/page/next"]));
    expect(hits).toHaveLength(9);
    for (const b of bodies) {
      expect(Object.keys(b).sort()).toEqual(["consent", "event_id", "name", "occurred_at", "path", "type", "v"]);
      expect(b["event_id"]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(b["consent"]).toBe("not_required");
    }
    expect(new Set(bodies.map((b) => b["event_id"])).size).toBe(9);
    const wire = hits.map((h) => h.body).join("\n");
    for (const secret of ["person@example.com", "secret", "token", "abc123", "frag", "Download", "Paragraph", "label"]) expect(wire).not.toContain(secret);
    for (const h of hits) {
      expect(h.headers["content-type"]?.toLowerCase()).toBe("text/plain;charset=utf-8");
      expect(h.headers["origin"]).toBe(base);
      expect(h.headers["sec-fetch-site"]).toBe("same-origin");
      expect(h.headers["cookie"]).toBeUndefined();
    }

    expect(await browser.eval("window.__violations")).toEqual([]);
    expect(reports).toEqual([]);
    expect(browser.exceptions).toEqual([]);
    expect(browser.consoleErrors.filter((e) => /Content.Security.Policy|Trusted Type|Refused/i.test(e))).toEqual([]);
  }, 60_000);

  it("fetch fallback in the real browser: same-origin, keepalive, JSON, no Referer, still no violation", async () => {
    hits.length = 0;
    await browser.eval(`navigator.sendBeacon = () => false; window.__collector.track("cta_click"); true`);
    await waitForHits(1);
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.headers["content-type"]).toBe("application/json");
    expect(h.headers["sec-fetch-site"]).toBe("same-origin");
    expect(h.headers["sec-fetch-mode"]).toBe("same-origin");
    expect(h.headers["origin"]).toBe(base);
    expect(h.headers["referer"]).toBeUndefined();
    expect(JSON.parse(h.body)).toMatchObject({ name: "cta_click", path: "/page/next" });
    expect(await browser.eval("window.__violations")).toEqual([]);
    expect(reports).toEqual([]);
  }, 30_000);
});
