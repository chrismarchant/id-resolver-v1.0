# @salescrusader/idr-tanstack

ID Resolver V1 server adapter for TanStack Start (version `0.1.0-dev.0`, not published).

For each eligible **document request** the website's **server** reports one small, anonymous "entrance" to the
resolver (`entrance.v1`). It never touches the page response, sets no cookie, adds no script and sends nothing from the
browser. It returns nothing to the page: the resolver answers with a status only (owner decision D2), and there is no
browser-to-company matching anywhere (D4).

* Zero runtime dependencies; Web APIs only (Cloudflare Workers and Node 22).
* Server only: it throws at creation if a `window` exists, and the TanStack `.server()` call keeps it out of client
  bundles (checked by a test that builds the probe app and scans client assets).
* Fail-open: every failure ends in a silent drop. See "Latency and failure behaviour" for the verified numbers.

Contract: `docs/contracts/entrance.v1.md` (frozen). Lifecycle evidence: `verification/RESULTS.md`.

## Install

The package is not published yet. Until it is, install the packed tarball (`npm pack -w @salescrusader/idr-tanstack`
from this repository) or a workspace path. Then:

```bash
npm install @salescrusader/idr-tanstack
```

## Server-only environment variables

| variable | value |
|---|---|
| `IDR_RESOLVER_URL` | base URL of the resolver, https (for example `https://<resolver-host>`); `/v1/entrances` is appended |
| `IDR_RESOLVER_TOKEN` | the resolver bearer token (at least 32 characters). A secret |
| `IDR_WEBSITE_ID` | must equal the resolver's `WEBSITE_ID` (`^[a-z0-9][a-z0-9-]{0,62}$`) |

Set them as **server secrets/variables of the deployment** (on Cloudflare: Workers secrets and variables). **Never give them a
`VITE_` prefix**: Vite inlines `VITE_*` values into client JavaScript. The token must not appear in client code,
in the page, in logs or in analytics.

## Register it in `src/start.ts`

```ts
import { createStart, createMiddleware } from "@tanstack/react-start";
import { createIdrServerMiddleware } from "@salescrusader/idr-tanstack";

const idr = createMiddleware().server(
  // A function: read at the first request, when Workers bindings exist.
  createIdrServerMiddleware(() => ({
    resolverUrl: process.env.IDR_RESOLVER_URL ?? "",
    token: process.env.IDR_RESOLVER_TOKEN ?? "",
    websiteId: process.env.IDR_WEBSITE_ID ?? "",
    trustPolicy: { mode: "cloudflare" }, // choose deliberately, see below
  })),
);

export const startInstance = createStart(() => ({ requestMiddleware: [idr] }));
```

If you already have request middleware, add `idr` to the array; order does not matter to the adapter.
With an options **object** (not a function) an invalid configuration throws when the app boots; with a **function** it
is checked at the first request, and an invalid configuration disables reporting (the page is never affected) and is
reported once to `onDeliveryResult` as `skipped/config_invalid`.

Note for TanStack Start 1.169: `next()` resolves to the middleware context, not a `Response`. The adapter returns
exactly what `next()` returned, so it composes with any other middleware.

### Options

| option | default | meaning |
|---|---|---|
| `resolverUrl`, `token`, `websiteId` | required | see above; https required unless `allowInsecureHttp` (local development only) |
| `trustPolicy` | **required** | `cloudflare`, `xff`, `header` or `none` |
| `timeoutMs` | 5000 (250 to 10000) | per attempt, `AbortSignal.timeout`; above the resolver's 4000 ms request deadline |
| `retry`, `retryDelayMs` | `true`, 250 | one retry, only with `waitUntil` (see below) |
| `maxInFlight` | 50 (1 to 500) | reports in flight per process/isolate; extra ones are dropped (`overload`) |
| `onUnsupportedBackground`, `blockingBudgetMs` | `"drop"`, 250 (50 to 1000) | edge isolate with no `waitUntil` only: drop, or block for at most the budget |
| `eligibility` | `{}` | `includePaths`, `excludePaths` (exact path, `/prefix/*`, or RegExp), `extraBotPatterns` |
| `pageKeyMapper` | `defaultPageKeyMapper` | replaces the conservative default (see below). Use `compileRouteTemplates(["/blog/:slug", "/products/:id"])` when you know your routes |
| `siteHosts` | host of the request URL | host names counted as "internal" referrers |
| `onDeliveryResult` | none | receives non-identifying status (below) |
| `allowDocumentationRanges` | `false` | accept RFC 5737/3849 IPs; tests and local development only |

## Choosing a trust policy

The IP the resolver looks up is whatever this policy selects, so a wrong choice lets a visitor choose which company is
"seen". The policy is mandatory and has no default.

| your deployment | policy |
|---|---|
| Runs on, or only behind, Cloudflare (Lovable's default Cloudflare target) | `{ mode: "cloudflare" }`: uses `CF-Connecting-IP`. **Only valid when requests can reach the app only through Cloudflare**, which overwrites that header. If the origin can be reached directly (another hostname, a workers.dev URL you left on, a non-Cloudflare CDN in front), a visitor can send `CF-Connecting-IP` themselves: do not use this mode there. |
| Behind N proxies you control that each append to `X-Forwarded-For` | `{ mode: "xff", trustedHops: N }`: counts from the **right**. N = 1 means the last entry (added by your single proxy). Entries to the left are attacker-controllable and are never read. Fewer entries than N is rejected. |
| One proxy sets a single-valued header and overwrites any client copy | `{ mode: "header", name: "<header>" }` |
| Unsure, or you want to switch reporting off | `{ mode: "none" }`: nothing is sent |

Whatever the policy, the value must be one plain public unicast address. These are **rejected, and then nothing is
sent**: missing or repeated headers, comma lists in a single-valued header, malformed text, ports, brackets, zone
ids, private, loopback, link-local, CGNAT, multicast, reserved, documentation (unless `allowDocumentationRanges`),
and every IPv4-mapped/embedded IPv6 form (`::ffff:a.b.c.d`, `::a.b.c.d`, NAT64, 6to4, Teredo). The accepted IP is sent
in canonical form and is transient: it is not logged, not returned and not given to `onDeliveryResult`.

## What is sent, and when

Rule set `tsa-1` decides eligibility from request metadata only. A request is reported when it is a successful (2xx)
HTML response to a **GET** that is not excluded by any of:

* `Sec-Fetch-Dest` other than `document`, `Sec-Fetch-Mode` other than `navigate`, or an `Accept` without `text/html`
  (each checked only when the header is present); an `Upgrade` header
* prefetch or prerender (`Purpose`, `Sec-Purpose`, `X-Moz`, `X-Purpose`)
* no `User-Agent`, or a bot, monitor, crawler, HTTP library, SEO tool or preview fetcher (the V0.1 expression, extended)
* static asset extensions, `/_serverFn`, `/_server`, `/_build`, `/assets`, `/.well-known`, `/api`, health paths
  (`/health`, `/healthz`, `/readyz`, `/livez`, `/ping`), robots, sitemaps, favicon
* your `excludePaths` (and anything outside `includePaths`, when set)

The body is exactly: `contract`, `website_id`, `ip`, `entrance_id` (128-bit random, base64url), `occurred_at` (now, UTC),
`page_key` (normalised path with identifier-like segments replaced, see below; at most 256 characters, never a query string or fragment), `acquisition` (one of
`direct|search|social|email|paid|referral|internal|unknown`, from the referrer **host** versus your site host and
`utm_medium`; raw values never leave the function) and `eligibility: "tsa-1"`. No header, cookie, user agent, referrer
or query string is sent.

### `page_key` privacy: the default mapper

Dynamic path segments can carry reset tokens, e-mail addresses or order numbers, and `page_key` is stored by the resolver
and served in the reporting feed. Unless you pass your own `pageKeyMapper`, `defaultPageKeyMapper` rewrites such segments:

| Segment | Becomes |
| --- | --- |
| any segment over 128 characters (not classified, which bounds the work per request) | `:token` |
| e-mail address (also percent-encoded `%40`, and several addresses in one segment) | `:email` |
| UUID | `:uuid` |
| digit run of 4 or more (a plain year such as `2026` is kept) | `:n`, in place (`order-12345` becomes `order-:n`) |
| hex/base64url token of 16+ characters that is not a readable slug, or a 12+ character run mixing letters and digits | `:token` |

The mapper runs on the response path, so its cost is bounded: every check is linear in the segment length, and
mapping stops once the output passes the 256-character `page_key` limit. The tests require a 16 KB adversarial path to
map in under 20 ms (it takes well under 1 ms on a development machine).

Readable slugs (`pricing`, `case-studies`, `2026-11-03-product-update`) are kept. This is a heuristic, not a guarantee: to
control exactly what is sent, supply your own mapper. It replaces the default entirely:

```ts
import { compileRouteTemplates, defaultPageKeyMapper } from "@salescrusader/idr-tanstack";
// Known routes only; anything else falls through to the conservative default.
const templates = compileRouteTemplates(["/blog/:slug", "/products/:id"]);
pageKeyMapper: (path) => templates(path) ?? defaultPageKeyMapper(path),
```

## Latency and failure behaviour (verified)

Verified on the Lovable stack (TanStack Start 1.168.60 / Nitro 3.0.260603-beta / Vite 8.1.5, Cloudflare target) under
local workerd, details in `verification/RESULTS.md`:

* On Cloudflare, `request.waitUntil` is available in request middleware. A promise that is neither awaited nor passed
  to `waitUntil` is **silently cancelled** when the response completes, so the adapter never relies on fire-and-forget
  there. `getEvent()` is not usable in TanStack request middleware.
* **Added TTFB: about 0 ms** (measured 0 to 3 ms). The report starts after `next()` returns and runs in `waitUntil`
  (Cloudflare and srvx/Nitro Node) or detached (long-lived Node/Bun/Deno process).
* **No background context** (an edge isolate without `waitUntil`, not the Cloudflare/Nitro case): the report is
  **dropped** by default (`skipped/no_background_context`). With `onUnsupportedBackground: "await"` the response is
  held for at most `blockingBudgetMs` (default 250 ms, aborted at the budget), so the budget is also the worst-case
  added TTFB there.
* **Retry:** one retry after 250 ms, only with `waitUntil`, only for timeout, network error, 429, 502, 503, 504, and
  never for 400/401/403/413/500 or after a long `Retry-After`. The retry reuses the `entrance_id`, so the resolver
  records at most one observation.
* **Drop policy:** anything else (timeout, network, 4xx, 5xx, redirect, more than `maxInFlight` in flight) is dropped:
  no queue, no persistence, no later replay. Nothing is thrown into the page and the response object is returned
  untouched (no header, no cookie, same body).
* Worst case for one report with `waitUntil`: 2 attempts x 5 s + 0.25 s, entirely after the response.

### Delivery results (`onDeliveryResult`)

Called once per handled request with a non-identifying object, never with an IP, token, URL, path or header value:

```ts
{ outcome: "delivered" | "dropped" | "skipped",
  reason: string,              // see below
  mode: "wait_until" | "detached" | "blocking" | "none",
  attempts: number, httpStatus?: number,
  resolverStatus?: string,     // the resolver's `status` on a 200
  recorded?: boolean, durationMs: number }
```

`reason`: `ok`; `timeout`, `network`, `http_4xx`, `http_429`, `http_5xx`, `http_other` (dropped); `overload` (dropped);
`no_background_context`, `config_invalid`, `eligibility:<rule>` (for example `eligibility:bot_or_monitor`),
`ip:<reason>` (for example `ip:ip_non_public`, `ip:header_missing`) (skipped). A thrown or rejected hook is ignored.

```ts
onDeliveryResult: (r) => { if (r.outcome !== "skipped") console.log("idr", r.outcome, r.reason, r.attempts); }
```

## Confirm connectivity and fail-open behaviour

**Connectivity.** `checkConnectivity` sends one synthetic entrance for a documentation-range IP (`198.51.100.1`). A
production resolver answers `200 ineligible` without any provider lookup, which proves URL, token, website id and
contract acceptance. It does not record an observation. (A development resolver that allows documentation ranges treats it as a
normal mock lookup.)

```js
// check-idr.mjs   run: node --env-file=.env.local check-idr.mjs   (never commit the env file)
import { checkConnectivity } from "@salescrusader/idr-tanstack";
const r = await checkConnectivity({
  resolverUrl: process.env.IDR_RESOLVER_URL, token: process.env.IDR_RESOLVER_TOKEN,
  websiteId: process.env.IDR_WEBSITE_ID, trustPolicy: { mode: "none" },
});
console.log(r); // { ok: true, reason: "delivered", httpStatus: 200, resolverStatus: "ineligible", latencyMs }
```

`401` means a wrong token, `403` a `website_id` that differs from the resolver's `WEBSITE_ID`, `400` a contract
mismatch, `network` or `timeout` an unreachable URL, `config_invalid` a malformed option.

**End to end.** Load a real page in a normal browser through the deployed site and watch the resolver's counters (its
ops usage tooling) or your `onDeliveryResult` log: expect `delivered` with `resolverStatus` of `qualified`,
`no_match` and so on. A request from `curl` is skipped on purpose (`eligibility:accept`, `bot_or_monitor`).

**Fail-open.** In a preview deployment set `IDR_RESOLVER_URL` to an unreachable `https://resolver.invalid` (and, in a
second pass, a wrong token). Pages must render exactly as before with unchanged timing, and the hook must show
`dropped/network` (or `dropped/http_4xx`). Nothing else changes. Restore the real values afterwards.

## Lower-level primitives

`buildEntrance(request, options)` (eligibility, trust policy and payload, nothing sent), `selectClientIp(request,
trustPolicy)`, `isEligible(request, rules)`, `classifyAcquisition({ referrer, siteHosts, utmMedium })`,
`normalisePageKey(pathOrUrl, mapper?)`, `compileRouteTemplates(templates)`, `parsePublicIp(text)`, `checkConnectivity(options)`.

## Development

```bash
npm install --ignore-scripts                     # at the repository root (registers the workspace)
npm run verify -w @salescrusader/idr-tanstack    # typecheck + tests
```

The bundle-safety test builds `verification/cf-lifecycle` (its own lockfile; install it with
`npm ci --ignore-scripts` there). Without it that one test is **skipped**, not passed.

Residual risks are listed in the cell report; this package has not had an independent security review.
