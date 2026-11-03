# @salescrusader/idr-collector

Optional browser collector for ID Resolver V1 (version `0.1.0-dev.0`, not published). It sends a small, closed set
of page events to **your own website's first-party route**. That route is `createCollectorRoute` in
`@salescrusader/idr-tanstack`. The website server checks each event and forwards it to the resolver with its own
server-held token.

* It is not needed for company resolution. The server adapter works without it.
* Browser events are stored with `origin=browser` and are **never joined to companies** (owner decision D4). They
  carry no identifier.
* Zero runtime dependencies, browser ESM, about 2.2 KB gzip (2251 bytes measured; the budget is 3 KB and a test enforces it).
* Contract: `docs/contracts/event.v1.md` (frozen). The vocabulary is `docs/contracts/event-vocabulary.v1.json`. It is
  **proposed and pending owner approval (CHR-59)**, and this package embeds an exact copy.

## Data that is NEVER collected

The collector cannot send any of the following, because no code path reads them. Tests prove this on the shipped
bundle (a static scan) and in a DOM and a real browser (with filled forms, links and text).

* **No identifiers.** No cookies, no `localStorage`, `sessionStorage` or IndexedDB, no session or visitor id, no
  user id. The `event_id` is random per event and is never stored.
* **No fingerprinting.** It never reads the user agent, platform, languages, screen, time zone, canvas, fonts,
  plugins, devices, hardware or network information.
* **No IP.** The browser has no IP to send. The website route never reads an IP header into what it forwards.
* **No content.** No form values, field names, labels or form actions. No text content, no link URLs (`href`) and
  no other attributes. No DOM capture, selection, mutation observation or session recording.
* **No URL parts other than the path.** Only `location.pathname` is sent. The query string, the fragment, the host
  and the referrer are never sent. The server turns the path into a `page_key` with the same mapper as the entrance
  middleware: identifier-like segments become `:email`, `:uuid`, `:n` or `:token`.
* **No browser-to-company matching.** Nothing in the browser knows or asserts a company.

Each event is exactly this, and has no other field:

```json
{ "v": 1, "event_id": "<22 random base64url chars>", "occurred_at": "2026-11-03T10:00:00Z",
  "type": "conversion_intent", "name": "cta_click", "path": "/pricing", "consent": "granted" }
```

## Browser events are forgeable telemetry

Treat what this collector produces as **indicative, aggregate telemetry, never as evidence**
(`docs/contracts/event.v1.md`, clarification CHR-66 G4-I1; no wire change):

* The route's `Origin` and `Sec-Fetch-Site` checks stop other websites' pages, not scripts. Anyone can post
  plausible events to your first-party route, with any allowlisted name, any path and `consent: "granted"`.
* That is inherent to owner decision D4: there is no visitor identity, session, cookie or IP to authenticate a sender
  by, and there must not be.
* It is bounded by the closed vocabulary and your allowlist, the consent policy (`Sec-GPC: 1` is always refused), the
  time window, the replay cache, the 1 KiB limit and the route's and the resolver's rate limits. The route's budget is
  per instance, not per client, so one sender can also use it up.
* **Never use browser events for security or billing decisions**: not for access control, fraud or abuse detection,
  rate limiting, invoicing, contractual metrics, or any decision about a person or a company.

## Install

Until the package is published, install the packed tarball (`npm pack -w @salescrusader/idr-collector`) or use a
workspace path. Bundle it into your own client JavaScript. It is then served from your own origin
(`script-src 'self'`). There is no CDN or third-party host. For a site without a bundler, the build also writes a
self-hostable `dist/idr-collector.min.js` (exported as `@salescrusader/idr-collector/idr-collector.min.js`).

## Use

Add the server route first (see the `createCollectorRoute` section of the `@salescrusader/idr-tanstack` README),
for example at `/idr/e`. Then start the collector once on the client:

```tsx
// TanStack Start: src/routes/__root.tsx (client side only: useEffect does not run during SSR)
import { useEffect } from "react";
import { initCollector } from "@salescrusader/idr-collector";

function useIdrCollector() {
  useEffect(() => {
    const collector = initCollector({
      endpoint: "/idr/e",
      allow: ["page_view", "scroll_50", "scroll_90", "engaged_30s", "cta_click", "form_start", "form_submit"],
      consent: "required",
      hasConsent: () => window.myCmp?.hasConsent("analytics") === true,      // your consent platform
      onConsentChange: (listener) => window.myCmp?.onChange((s) => listener(s.analytics === true)),
      spa: true,
    });
    return () => collector.stop();
  }, []);
}
```

`initCollector(options)` returns `{ track(name), stop() }`. Invalid options throw a `TypeError` at init. After that,
nothing the collector does throws into the page.

| option | meaning |
|---|---|
| `endpoint` | required. A **same-origin path** such as `/idr/e`. Absolute URLs, `//host`, `/\host`, other schemes, a query or a fragment are refused at init |
| `allow` | required. The names this site collects, a subset of the vocabulary. Any other name is dropped silently, and an unknown name in `allow` throws |
| `consent` | required. `"required"`, `"not_required"` or `"off"` (see below) |
| `hasConsent()` | consent platform hook: returns `true` once the visitor has consented |
| `onConsentChange(listener)` | consent platform hook: register `listener(granted)`. It may return an unsubscribe function, which `stop()` calls |
| `spa` | `true` reports same-document route changes as page views. Default `false` |

`track(name)` sends one allowlisted event for the current page, for example `pricing_view` from your pricing route,
or `video_start` and `video_complete` from your player's own events.

### What triggers each event

| name | trigger |
|---|---|
| `page_view` | the initial view, and with `spa: true` every change of `location.pathname` (not query or hash changes) |
| `scroll_50`, `scroll_90` | the bottom of the viewport passes 50% / 90% of the page height. At most once per page view |
| `engaged_30s` | 30 s of **visible** time on the page (hidden time does not count). At most once per page view |
| any allowlisted name | a click on (or inside) an element with `data-idr-event="<name>"`, for example `cta_click`, `file_download`, `outbound_link`. Only that attribute is read: never the link URL or the text |
| `form_start` | the first focus inside a `form[data-idr-form]` (once per form per page view) |
| `form_submit` | a submit of a `form[data-idr-form]` |
| any allowlisted name | `track(name)` |

```html
<a href="/files/report.pdf" data-idr-event="file_download">Report</a>   <!-- the URL is not sent -->
<a href="https://partner.example.org" data-idr-event="outbound_link">Partner</a>
<button data-idr-event="cta_click">Book a demo</button>
<form data-idr-form>...</form>   <!-- no value or field name is ever read -->
```

The listeners are passive and run in the capture phase. They never cancel, delay or change a click or a submit.
Listeners are attached only for the events in `allow`, and only while consent holds.

### SPA page views: Navigation API first, then a bounded history hook

* **Where the Navigation API exists**, the collector listens to `navigation`'s `currententrychange`. This observes every
  same-document URL change, including a router's `pushState`, and patches nothing.
* **Where it does not exist**, `popstate` alone would miss router navigations (they use `pushState`). The collector
  then also wraps `history.pushState` and `history.replaceState`. The wrapper is bounded and safe:
  * it calls the original first, with the same `this` and arguments;
  * it lets the original's exceptions through unchanged, and its own code never throws;
  * it emits at most one `page_view` per actual change of `location.pathname`;
  * `stop()` removes it. If another script wrapped history after it, the wrapper is left in place but does
    nothing.

### Consent and Global Privacy Control

* **`"off"`**: nothing is ever observed or sent, and the hooks are not called.
* **`"required"`**: nothing is observed (no listeners, no timers) and nothing is sent until consent is granted.
  * `hasConsent()` is asked before every event.
  * A `false` pushed through `onConsentChange` blocks at once and removes the listeners.
  * When consent is granted, collection starts with a `page_view` for the current page.
  * With `hasConsent` alone (no `onConsentChange`), a grant after page load is picked up by the next `track()` call.
  * Events from before consent are never queued or sent later.
* **`"not_required"`**: for sites that have decided no consent is needed. The hooks are not consulted, and events
  say `consent: "not_required"`.
* **GPC**: when `navigator.globalPrivacyControl === true`, nothing is observed or sent, in every mode. The server
  route also refuses requests that carry `Sec-GPC: 1`.

The server enforces its own policy whatever the browser claims. Its consent mode must match the resolver's
`EVENT_CONSENT_MODE` (default `required`). In `required` mode it can also check consent itself, for example from your
consent platform's cookie.

### Transport and limits

* **Beacon first.** `navigator.sendBeacon(endpoint, Blob)` with the JSON body as `text/plain;charset=UTF-8`. This is a
  CORS-safelisted type, so the beacon is never refused for its type, and the contract allows it for exactly this
  case.
* **fetch fallback.** If the beacon is missing, throws or returns `false`, the collector makes one `fetch(endpoint,
  { method: "POST", keepalive: true, credentials: "same-origin", mode: "same-origin", referrerPolicy:
  "no-referrer", cache: "no-store" })` with `application/json`.
  * `same-origin` credentials let your server-side consent check read your consent cookie. The route itself never
    reads or forwards cookies.
* **Bounded.** At most 30 events per page view and 300 per document. At most 4 fallback fetches in flight; anything
  beyond that is dropped. A body over 1 KiB, which only a very long path can produce, is not sent.
* **Dropped on failure.** There is no retry, queue or storage, and nothing is ever thrown into the page. Failed or
  rejected requests are swallowed.

## Content-Security-Policy

The collector works under a strict policy such as:

```
script-src 'self'; connect-src 'self'; style-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'
```

* There is no `eval`, `new Function`, string timer, dynamic import, worker or inline script.
* It creates or injects no elements and no styles, and uses no `innerHTML` or other HTML sinks. It is therefore
  Trusted Types compatible.
* It contacts no third-party host and contains no absolute URL. It sends only to your same-origin `endpoint`.
* It needs no `unsafe-inline`, `unsafe-eval`, nonce or hash beyond what your own bundle already needs.

How this is verified:

* **Static scan.** `test/bundle.test.ts` scans the minified build for every construct above, and for storage,
  fingerprinting and content-capture APIs.
* **Real browser.** `test/csp-browser.test.ts` serves the build to headless Chrome under the policy above, plus
  `default-src 'none'`.
  * A positive control proves the browser enforces the policy: `eval`, `Function`, `innerHTML`, a string timer and a
    cross-origin fetch are all blocked.
  * The collector then runs a full scenario (page view, clicks, a filled form, scroll, SPA navigation, the fetch
    fallback) with zero violations, zero exceptions and zero reports.
  * Every beacon reached the route with exactly the contract fields, `Origin` set and
    `Sec-Fetch-Site: same-origin`.
  * The test needs a Chrome or Chromium binary (`CHROME_PATH`, or the usual `/usr/bin` names). Without one it is
    **skipped** and reported as skipped. `IDR_REQUIRE_BROWSER=1` turns a missing browser into a failure.

## Development

```bash
npm install --ignore-scripts                      # at the repository root
npm run verify -w @salescrusader/idr-collector    # typecheck + tests (happy-dom, size budget, CSP scan, Chrome if present)
npm run build -w @salescrusader/idr-collector     # dist/ (tsc) + dist/idr-collector.min.js (esbuild), prints the gzip size
```

Dev dependencies: `esbuild` (the build and the size test; already in the repository's lockfile through `tsx`),
`happy-dom` (DOM test environment), `typescript`, `vitest`, `@types/node`.

### Verified end to end

The TanStack probe app (`packages/tanstack/verification`, section "Gate 4" of `RESULTS.md`) bundles this
collector into its client and registers `createCollectorRoute`. On local workerd and on the Node target, a page
loaded in headless Chrome sent its `page_view` beacon through the route to a stand-in resolver: `204` to the
browser, then `event.v1` delivered through `waitUntil`.

### Not verified

* Safari and Firefox were not run. In particular, Safari and Firefox without the Navigation API use the history hook,
  which was exercised in the DOM environment only.
* Real consent platforms were not tested. The hooks were tested with fakes.
* The test exercises Chrome's handling of the 64 KiB beacon/keepalive quota only lightly.

This package has not had an independent security review.
