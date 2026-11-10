# @salescrusader/idr-tanstack

ID Resolver V1 server adapter for TanStack Start (version `0.1.0-dev.1`, not published).

For each eligible **document request** the website's **server** reports one small, anonymous "entrance" to the
resolver (`entrance.v1`). It never touches the page response, sets no cookie, adds no script and sends nothing from the
browser. It returns nothing to the page: the resolver answers with a status only (owner decision D2), and there is no
browser-to-company matching anywhere (D4).

* Zero runtime dependencies; Web APIs only (Cloudflare Workers and Node 22).
* Server only: it throws at creation if a `window` exists, and the TanStack `.server()` call keeps it out of client
  bundles (checked by a test that builds the probe app and scans client assets).
* Fail-open: every failure ends in a silent drop. See "Latency and failure behaviour" for the verified numbers.

Contract: `docs/contracts/entrance.v1.md` (frozen). Lifecycle evidence: `verification/RESULTS.md`.

Optional: `createCollectorRoute` is the first-party route for the browser collector (`event.v1`). See
"Browser events: `createCollectorRoute`" below.

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
| `collectorPath` | `/idr/e` | the request path of the collector route (`createCollectorRoute`) as the browser sends it, including any router `basepath`; never reported, see "What is sent, and when". A plain path: no query string, fragment, wildcard, percent-encoding, empty or dot segment; at most 256 characters; not `/` |
| `pageKeyMapper` | none | your own mapper, e.g. `compileRouteTemplates(["/blog/:slug", "/products/:id"])`. The conservative default mapper still runs after it (see below) |
| `pageKeyDefaultMapper` | `true` | `false` switches the default mapper off so that `pageKeyMapper` alone decides; requires `pageKeyMapper` (see below) |
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
* **the collector path**, by default and without any configuration (see below)

**The collector path is never an entrance.** With only `POST` registered on the collector route (as shown under
"Browser events"), TanStack Start serves a `GET` or `HEAD` to `/idr/e` itself: its router renders the empty route
page, `200 text/html`. Before Gate 5 the middleware reported such a browser navigation as an entrance with
`page_key` `/idr/e` (finding G5-D-F1). The middleware now never reports the path in `collectorPath` (default
`/idr/e`):

* whether or not the site mounts `createCollectorRoute`, whatever the route's `allow` list or `consent` mode;
* for every HTTP method (it is checked before the method rule, on its own);
* for every request path that TanStack Start's own canonicalisation turns into the collector path. The adapter
  repeats the router's steps: it percent-decodes the path as the router does (except `%25` and `%5C`), parses it
  again as a URL (which strips trailing spaces, so `/idr/e%20` reaches the route, and resolves dot segments, also
  ones that only appear after decoding), trims trailing slashes, and compares in lower case (TanStack Router matches
  static segments case-insensitively by default). This was derived from, and is tested against, the router code the
  repository's probe app pins (`@tanstack/start-server-core` 1.169.39, `@tanstack/router-core` 1.171.34): a
  differential test replays the router's dispatch on hand-written spellings, a grid of combinations and 50,000 random
  mutations, and the probe app under local workerd confirms it end to end. Another TanStack version may canonicalise
  differently; the differential test is the place to re-check it after an upgrade;
* deliberately also for a few spellings the router does not dispatch to the route, all of the same path: a doubled
  leading slash (the router answers it with a redirect to the path), repeated inner slashes, an encoded `%2F` or `%5C`
  separator, trailing spaces followed by a query string, and upper case on a case-sensitive router. A different
  path is never excluded: `/idr/ex`, `/idr/e-mail`, `/idr`, `/idr/e/x` and `/idr/x%20` stay eligible;
* `includePaths` cannot re-admit it, and `excludePaths: ["/idr/e"]` is no longer needed (it is harmless).

Such a request is reported to `onDeliveryResult` as `skipped/eligibility:collector_path`. Only the report is
skipped: the page, its status and its headers are exactly what your router answered, and the response object is
returned untouched.

**`collectorPath` is the request path, as the browser sends it.** It must equal the collector's `endpoint`. Without a
router `basepath`, that is also the route file's path (`createFileRoute("/idr/e")`). With the documented `/idr/e`
the default already matches and you configure nothing. If you mount the route elsewhere, set `collectorPath` to
that path in the options of **both** the middleware and the route (one shared options object does both). If a
`POST` reaches the route on any other path, the route reports `skipped/collector:path_mismatch` once per instance
(its answers do not change). That signal means the middleware is not excluding the path the route really lives on.

**Basepath and input rewrites are not covered.** The middleware sees the request path before the router applies
its `basepath` or a `rewrite.input` (createStartHandler.js:479 in the pinned version):

* With `basepath: "/app"`, the browser posts to `/app/idr/e`, so set `collectorPath: "/app/idr/e"` (the full request
  path, not the route file's `/idr/e`). TanStack's basepath rewrite also passes paths without the base through
  unchanged (router-core `rewrite.js`, `rewriteBasepath`), so `/idr/e` reaches the same route too. That spelling is
  not excluded: add it to `excludePaths` (for example `excludePaths: ["/idr/e"]`).
* With an input rewrite, for example locale prefixes (`/de/idr/e` rewritten to `/idr/e`), every rewritten
  spelling reaches the route and none of them is excluded. List them in `excludePaths`, for example
  `excludePaths: [/^\/[a-z]{2}\/idr\/e\/?$/i]`.

`excludePaths` matches the raw path (exact, prefix or RegExp). It does not repeat the router's decoding, so encoded
variants of those extra spellings (such as `/de/idr/%65`) are not excluded.

The body is exactly: `contract`, `website_id`, `ip`, `entrance_id` (128-bit random, base64url), `occurred_at` (now, UTC),
`page_key` (normalised path with identifier-like segments replaced, see below; at most 256 characters, never a query string or fragment), `acquisition` (one of
`direct|search|social|email|paid|referral|internal|unknown`, from the referrer **host** versus your site host and
`utm_medium`; raw values never leave the function) and `eligibility: "tsa-1"`. No header, cookie, user agent, referrer
or query string is sent.

### `page_key` privacy: the default mapper

Dynamic path segments can carry reset tokens, e-mail addresses or order numbers, and `page_key` is stored by the resolver
and served in the reporting feed. `defaultPageKeyMapper` rewrites such segments, and it always applies unless you
explicitly switch it off with `pageKeyDefaultMapper: false`:

| Segment | Becomes |
| --- | --- |
| any segment over 128 characters (not classified, which bounds the work per request) | `:token` |
| a segment that is not valid percent-encoding (a lone `%`, invalid UTF-8) | `:token` |
| e-mail address (also percent-encoded `%40`, and several addresses in one segment) | `:email` |
| UUID | `:uuid` |
| digit run of 4 or more (a plain year such as `2026` is kept) | `:n`, in place (`order-12345` becomes `order-:n`); a percent-encoded segment (`%31%32%33%34%35`) becomes `:n` as a whole |
| hex/base64url token of 16+ characters that is not a readable slug, or a 12+ character run mixing letters and digits | `:token` |

Every rule judges the percent-decoded segment, so encoding a value does not hide it. The mapper runs on the response path, so its cost is bounded: every check is linear in the segment length, and
mapping stops once the output passes the 256-character `page_key` limit. The tests require a 16 KB adversarial path to
map in under 20 ms (it takes well under 1 ms on a development machine).

Readable slugs (`pricing`, `case-studies`, `2026-11-03-product-update`) are kept. This is a heuristic, not a guarantee.
Where you know your routes, add your own mapper. The default still runs after it, so a path your mapper does not match
is never sent raw:

```ts
import { compileRouteTemplates } from "@salescrusader/idr-tanstack";

createIdrServerMiddleware({
  // ...
  pageKeyMapper: compileRouteTemplates(["/blog/:slug", "/products/:id"]),
});
// /blog/my-post            -> /blog/:slug       (template; placeholders such as :slug pass the default unchanged)
// /orders/12345            -> /orders/:n        (no template matched: the default applies to the path)
// /reset/<hex token>       -> /reset/:token
```

How the two combine:

* Your mapper returns a string: the default runs on that string. Template output such as `/blog/:slug` comes through
  unchanged. Literal segments of a template that look like identifiers (a 4+ digit run, a long token) are rewritten too.
* Your mapper returns `null`/`undefined` (no match) or throws: the default runs on the path.
* The result is cut to 256 characters on a segment boundary. A result that is still not a valid `page_key` (no leading
  `/`, a `?`, `#`, whitespace or control character) is sent as `/`. The unmapped path is never sent in its place.

`pageKeyDefaultMapper: false` is an explicit opt-out for sites whose own mapper guarantees that no identifier (token,
e-mail, order number, user name) can reach the resolver. Your mapper then alone decides, and a path it returns `null` for
is sent as is (still capped and validated). It requires `pageKeyMapper`; on its own it is a configuration error.

**Upgrade note.** Earlier versions applied a site's `pageKeyMapper` *instead of* the default, so with
`pageKeyMapper: compileRouteTemplates([...])` every path that matched no template was sent raw. Such integrations now
also get the default for those paths, with no code change. The previously documented composition
`(path) => templates(path) ?? defaultPageKeyMapper(path)` keeps working but is now redundant. Set
`pageKeyDefaultMapper: false` only if you need the old replace-the-default behaviour.

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
`no_background_context`, `config_invalid`, `eligibility:<rule>` (for example `eligibility:bot_or_monitor`, or
`eligibility:collector_path` for a request to the collector path), `ip:<reason>` (for example `ip:ip_non_public`,
`ip:header_missing`), `collector:<check>` (the collector route, see below, including `collector:path_mismatch`)
(skipped). A thrown or rejected hook is ignored.

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

## Bot and crawler visits: `createBotVisitMiddleware` (optional)

Records visits from known bots and crawlers for reporting, without changing anything for human visitors. Register
it **before** the entrance middleware, with the same resolver URL, token and website id:

```ts
import { createStart, createMiddleware } from "@tanstack/react-start";
import { createBotVisitMiddleware, createIdrServerMiddleware } from "@salescrusader/idr-tanstack";

const resolver = () => ({
  resolverUrl: process.env.IDR_RESOLVER_URL ?? "",
  token: process.env.IDR_RESOLVER_TOKEN ?? "",
  websiteId: process.env.IDR_WEBSITE_ID ?? "",
});
const bots = createMiddleware().server(createBotVisitMiddleware(resolver));
const idr = createMiddleware().server(createIdrServerMiddleware(() => ({ ...resolver(), trustPolicy: { mode: "cloudflare" } })));

export const startInstance = createStart(() => ({ requestMiddleware: [bots, idr] }));
```

**The bot list.** One list, `KNOWN_BOTS` in `src/known-bots.ts`; each entry has a name and a category. To add a bot,
add one entry there (the resolver needs no change).

| category | names |
|---|---|
| `ai_crawler` | GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent, Amazonbot |
| `search_engine` | Googlebot, Bingbot, DuckDuckBot, YandexBot, Applebot |
| `seo_tool` | AhrefsBot, SemrushBot, MJ12bot, DotBot |
| `social_preview` | facebookexternalhit, LinkedInBot, Twitterbot, Slackbot, WhatsApp, Discordbot |
| `monitoring` | UptimeRobot, Pingdom |
| `other` | Generic bot, Generic crawler, Generic spider: any other product token ending in "bot", "crawler" or "spider" |

Names match case-insensitively on a token boundary, in list order (so `Applebot-Extended` is tried before `Applebot`).
`Google-Extended` and `Applebot-Extended` are robots.txt control tokens: Google and Apple crawl as `Googlebot` and
`Applebot`, so those two entries normally match nothing. `matchBot(userAgent)` is exported for tests and tooling.

**What is recorded.** A known bot's GET or HEAD request answered with 2xx or 304, as one `bot-visit.v1` row:
`occurred_at`, `page_key` (path only, mapped exactly like entrances), `bot_name`, `bot_category` and
`user_agent_family` (the one product token that identified the bot, without its version, e.g. `Googlebot-Image`).
Never the IP, the full user agent, cookies or any other header. Not recorded: other methods, redirects and errors,
server functions, framework paths, page resources (scripts, styles, images, fonts, media) and the collector route.
robots.txt, sitemaps and llms.txt are recorded.

**Human traffic is untouched.** For a request that is not a known bot the middleware only calls `next()` and returns
its result: nothing is sent, no hook is called, and the entrance middleware after it sees exactly the same request.
A bot request still reaches the entrance middleware, whose own bot rule (`tsa-1`) keeps known bots out of entrances.

**Never slower.** The send is scheduled after `next()` returns, exactly like entrance reports: `waitUntil` where one
exists (one retry), detached on Node, dropped on an edge isolate with neither. It never blocks: there is no
`onUnsupportedBackground: "await"` for bot visits. At most `maxInFlight` (default 50) sends per instance; more are
dropped. At the resolver, bot visits have their own rate-limit bucket and write slots, so a crawler burst cannot
slow entrance resolution; an excess visit is dropped.

`onDeliveryResult` receives a result for every bot request (never for other requests). Skips use the reasons
`bot:method`, `bot:not_served`, `bot:internal_path`, `bot:resource`, `bot:collector_path` and `bot:bad_url`, plus the
shared `config_invalid`, `no_background_context` and `overload`.

## Browser events: `createCollectorRoute` (optional)

The optional browser collector (`@salescrusader/idr-collector`) sends a closed set of page events to a
**first-party route on your own site**. `createCollectorRoute` is that route. It checks each event and forwards it
to the resolver's `POST /v1/events` (contract `event.v1`, `docs/contracts/event.v1.md`) with the server-held token,
on the same non-blocking path as the entrance middleware. Browser events are stored with `origin=browser` and are
never joined to companies (owner decision D4).

The resolver serves `/v1/events` only when `EVENTS_ENABLED=true`; otherwise it answers 404, and the hook shows
`dropped/http_4xx`.

**Browser events are forgeable telemetry** (`event.v1.md`, clarification CHR-66 G4-I1; no wire change). The
`Origin` and `Sec-Fetch-Site` checks below stop browsers on other sites, not scripts: anyone can post plausible
allowlisted events through this route, within its rate budget, the vocabulary, your allowlist and the consent policy.
That is inherent to D4 (there is no visitor identity to authenticate). Never use browser events for security or
billing decisions.

### TanStack Start server route

```ts
// src/routes/idr.e.ts  ->  POST /idr/e   (the same path as the collector's `endpoint` and `collectorPath`)
import { createFileRoute } from "@tanstack/react-router";
import { createCollectorRoute } from "@salescrusader/idr-tanstack";

export const Route = createFileRoute("/idr/e")({
  server: {
    handlers: {
      // Call createCollectorRoute inline here, inside `server.handlers`, so the client build strips it with the rest
      // of the server code. A function: read at the first request, when Workers bindings exist.
      POST: createCollectorRoute(() => ({
        resolverUrl: process.env.IDR_RESOLVER_URL ?? "",
        token: process.env.IDR_RESOLVER_TOKEN ?? "",
        websiteId: process.env.IDR_WEBSITE_ID ?? "",
        allow: ["page_view", "scroll_50", "scroll_90", "engaged_30s", "cta_click", "form_start", "form_submit"],
        consent: "required", // match the resolver's EVENT_CONSENT_MODE
      })),
    },
  },
});
```

Keep the call **inside `server.handlers`**, as above. A route file is also part of the client build, and the
TanStack compiler strips `server.handlers` from it. The bundle-safety test builds the probe app with exactly this
pattern and checks that neither the route code nor the token reaches client assets.

* A module-level constant used only by `server.handlers` was also stripped in the verified TanStack Start 1.168
  build.
* A reference from any client code would ship the route to the browser. There it throws at creation, because a
  `window` exists.

It uses the same server-only variables as the middleware, and the same resolver options: `resolverUrl`, `token`,
`websiteId`, `timeoutMs`, `retry`, `retryDelayMs`, `maxInFlight`, `onUnsupportedBackground`, `blockingBudgetMs`,
`pageKeyMapper`, `pageKeyDefaultMapper`, `allowInsecureHttp`, `collectorPath` and `onDeliveryResult`. One shared
object can therefore be spread into both. The route has **no trust policy** and ignores one if given: it never reads a
client IP.

| option | default | meaning |
|---|---|---|
| `allow` | required | the site allowlist, a subset of `event-vocabulary.v1` (an unknown name throws) |
| `consent` | `"required"` | `required`: only `consent: "granted"` is accepted. `not_required`: `granted` and `not_required` are accepted and forwarded as given. `off`: every event is refused. Use the resolver's `EVENT_CONSENT_MODE` |
| `hasConsent(request)` | none | `required` mode only: your server-side consent check, for example reading your consent platform's cookie. `false`, a throw or a rejection refuses the event, and so does a hook that has not settled within `consentTimeoutMs` (fail closed: treated as no consent, `403`) |
| `consentTimeoutMs` | 1000 (10 to 10000) | how long `hasConsent` may take. The route stops waiting and refuses; it cannot stop a hook that blocks synchronously, so keep the hook fast (a cookie read, not a network call) |
| `bodyTimeoutMs` | 5000 (100 to 60000) | how long reading the request body may take. A slower body is refused with `408` and the stream is cancelled, so a slow-dripping client cannot hold the request open |
| `origins` | origin of the request URL | accepted `Origin` values. Set this when a proxy in front of the app changes the scheme or host of `request.url` |
| `maxClockSkewMs` | 120000 (5000 to 240000) | accepted distance of `occurred_at` from server time, in either direction |
| `replayCacheSize` | 10000 (100 to 100000) | accepted `event_id`s remembered per route instance |
| `rateLimit` | `{ events: 600, windowMs: 60000 }` | accepted events per window, per route instance. It is **not** keyed by IP or by any other client property |

### What the route checks, in order

| # | check | refusal |
|---|---|---|
| 1 | method is `POST` | `405` (`Allow: POST`), only for a request the route sees: see the note below |
| 2 | `Origin` is one of the site origins (missing, `null` or foreign: refused); `Sec-Fetch-Site`, when present, is `same-origin` | `403` |
| 3 | content type is `application/json` or `text/plain` (the beacon's type) | `415` |
| 4 | body at most 1 KiB: a larger `Content-Length` is refused without reading, and a streamed body is cancelled as soon as it passes 1 KiB; the whole body must arrive within `bodyTimeoutMs`, or the stream is cancelled | `413` / `408` |
| 5 | strict schema: exactly `v`, `event_id`, `occurred_at`, `type`, `name`, `path`, `consent`. Unknown fields (an `ip`, a session id, text) are refused. `path` must be a path with no query string and no fragment | `400` (malformed JSON or invalid UTF-8 too) |
| 6 | `type` and `name` in the vocabulary (`400`); `name` in your `allow` list (`403`) | `400` / `403` |
| 7 | consent policy: the mode, `Sec-GPC: 1`, then `hasConsent`, which must answer `true` within `consentTimeoutMs` | `403` |
| 8 | `occurred_at` within `maxClockSkewMs` of server time | `400` |
| 9 | `event_id` not already accepted (replay cache, kept for twice the skew window; the resolver also stores one row per `event_id`) | `409` |
| 10 | per-instance rate budget | `429` |

**Check 1 and `GET`.** The route handles only the methods you register it for. With only `POST` registered, as
above, a `GET` or `HEAD` to `/idr/e` never reaches `createCollectorRoute`: TanStack Start's router serves it as the
empty route page (`200 text/html`, verified with TanStack Start 1.168 under local workerd). That is not an event:
nothing is accepted or forwarded, and the middleware does not report it as an entrance (see "What is sent, and
when"). A client therefore sees `405` only for methods the framework hands to the route. If you prefer `GET` and
`HEAD` to answer `405` as well, register them yourself with a bare answer, for example
`GET: () => new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } })` and the
same for `HEAD`. This is optional; the entrance exclusion does not depend on it.

An accepted event is answered `204` immediately, and then forwarded in the background. Every answer is bare: no
body, no `Set-Cookie`, `Cache-Control: no-store`. A refusal is reported to `onDeliveryResult` as
`skipped/collector:<check>`, where `<check>` is one of `origin`, `sec_fetch_site`, `content_type`, `too_large`,
`body_timeout`, `malformed`, `schema`, `path`, `vocabulary`, `not_allowed`, `consent_off`, `gpc`, `consent`,
`consent_timeout`, `occurred_at`, `replay` or `rate`. One more `collector:` reason is a signal, not a refusal:
`path_mismatch`, reported once per route instance when a `POST` arrives on a path other than `collectorPath` (the
event is still handled as usual; see "`collectorPath` is the request path").

### What it forwards, and what it never reads

The forwarded body is exactly the `event.v1` resolver body, built from the validated fields only:

```json
{ "contract": "event.v1", "website_id": "<websiteId>", "event_id": "...", "occurred_at": "2026-11-03T10:00:00Z",
  "type": "conversion_intent", "name": "cta_click", "page_key": "/pricing", "consent": "granted" }
```

* `page_key` comes from the browser's `path`, mapped with **the same composed mapper as the middleware**: your
  `pageKeyMapper`, then the default mapper. The browser's value is never forwarded as is.
* `occurred_at` is re-serialised as whole-second UTC.
* The forwarded request carries only `Authorization: Bearer <token>`, `Content-Type` and `Accept`, as set by the
  adapter (see "Outbound headers" below for what the platform may add).
* The route reads only the `Origin`, `Sec-Fetch-Site`, `Content-Type`, `Content-Length` and `Sec-GPC` request
  headers. It never reads or forwards `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, the user
  agent, cookies, the referrer or any other header. Your own `hasConsent` hook may read your consent cookie; its
  result is used only to decide.

### Delivery

Delivery uses the same machinery and lifecycle as the entrance middleware (see "Latency and failure behaviour"):

* `waitUntil` where available, with one retry for a transient failure; the same `event_id` makes the retry
  idempotent.
* Detached on long-lived runtimes.
* On an edge isolate without `waitUntil`, the event is dropped (`skipped/no_background_context`). With
  `onUnsupportedBackground: "await"`, the `204` is instead held for at most `blockingBudgetMs`.
* A resolver error, timeout or outage never changes the browser's `204`. The outcome (`delivered`, or
  `dropped/http_4xx|http_5xx|http_429|timeout|network|overload`) goes to `onDeliveryResult`.

With an options function, a configuration error found at the first request disables the route: every POST gets
`204` and is dropped, and `skipped/config_invalid` is reported once. An invalid options object throws at creation.

## Outbound headers (G4-I8)

Every request the adapter sends (entrances, events and `checkConnectivity`) is built from scratch: a URL string and
exactly three headers, `Authorization: Bearer <token>`, `Content-Type: application/json` and
`Accept: application/json`. The incoming request, its headers and its body are never copied, cloned or forwarded:
not `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`, `Forwarded`, `True-Client-IP`, `CF-IPCountry`, cookies, the
user agent, the referrer, `Origin`, `Sec-GPC` or any other header. `test/outbound-headers.test.ts` asserts the exact
header set on both paths for a request that carries the visitor's IP in all of those headers.

**What the local tests cannot show.** These tests, the probe app under local workerd (`wrangler dev --local`,
miniflare) and the Node runs show only what the adapter sets. They cannot show what the Cloudflare platform adds
to a Worker's subrequest after it leaves the adapter. According to Cloudflare's header reference (as found by
search; the versions found disagree, see the staging plan), such a subrequest can carry `CF-Connecting-IP` and
`X-Real-IP`, and for some destinations these may hold the visitor's IP. No D4 transport
isolation (no visitor IP reaching the resolver's host) is claimed from local tests. The staging test T5, run on
the real Cloudflare edge, decides (`docs/staging/CLOUDFLARE_TEST_SITE.md`, section 4).

## Lower-level primitives

`buildEntrance(request, options)` (eligibility, trust policy and payload, nothing sent), `selectClientIp(request,
trustPolicy)`, `isEligible(request, rules, collectorPath?)` (`collectorPath` defaults to `DEFAULT_COLLECTOR_PATH`,
`/idr/e`; an invalid value throws), `classifyAcquisition({ referrer, siteHosts, utmMedium })`,
`normalisePageKey(pathOrUrl, mapper?)` (applies exactly the mapper it is given; pass
`composePageKeyMapper(yourMapper)` to get the adapter's composition with the default), `compileRouteTemplates(templates)`,
`defaultPageKeyMapper`, `parsePublicIp(text)`, `checkConnectivity(options)`.

## Development

```bash
npm install --ignore-scripts                     # at the repository root (registers the workspace)
npm run verify -w @salescrusader/idr-tanstack    # typecheck + tests
```

The bundle-safety test builds `verification/cf-lifecycle` (its own lockfile; install it with
`npm ci --ignore-scripts` there). Without it that one test is **skipped**, not passed.

Residual risks are listed in the cell report; this package has not had an independent security review.
