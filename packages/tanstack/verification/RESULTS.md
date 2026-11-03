# Task 1 results: TanStack Start / Nitro request lifecycle and `waitUntil`

Owner condition (binding): *verify the actual TanStack/Nitro request lifecycle and availability of waitUntil
before relying on non-blocking delivery; define explicit latency and delivery-failure behaviour.*

Run date: 3 Nov 2026, sandbox Linux, Node v22.23.4, local workerd. Probe app:
`packages/tanstack/verification/cf-lifecycle/` (own `package.json` and `package-lock.json`, **not** an npm
workspace: it sits below `packages/tanstack/`, so the root `packages/*` glob does not match it).

## Versions (from the probe lockfile)

| component | version |
|---|---|
| `@tanstack/react-start` | 1.168.60 (resolves `@tanstack/start-server-core` 1.169.39, `@tanstack/start-plugin-core` 1.171.49) |
| `@tanstack/react-router` | 1.170.41 |
| `@lovable.dev/vite-tanstack-config` | 2.26.5 (same wrapper as Lovable sites; Nitro builds for the default `cloudflare-module` preset) |
| `nitro` | 3.0.260603-beta (srvx 0.11.22, h3 2.0.8) |
| `vite` | 8.1.5 |
| React | 19.2.0 |
| `wrangler` / workerd | 4.157.0 / 1.20261103.1 (`wrangler dev --local`) |

Peer dependencies of the Lovable config (`@vitejs/plugin-react` 6.2.1, `@tailwindcss/vite` 4.3.4,
`vite-tsconfig-paths` 6.0.0) were chosen to satisfy its peer ranges with Vite 8; they are not on the
request path.

## Commands

```bash
cd packages/tanstack/verification/cf-lifecycle
npm install --ignore-scripts --no-audit --no-fund      # or: npm ci --ignore-scripts
npm run build                                            # vite build -> Nitro preset cloudflare-module (default)
node harness.mjs                                         # starts sink :4599 + `wrangler dev --local` :8799 on .output/server/wrangler.json
SINK_MODE=500  node harness.mjs                          # also: hang | down
NITRO_PRESET=node-server npm run build && PROBE_TARGET=node node harness.mjs   # same probe on the Node target
```

Build output (excerpt): `[nitro] Building [Nitro] (preset: cloudflare-module, compatibility: 2026-11-03)`,
`Generated .output/server/wrangler.json` (`compatibility_flags: ["nodejs_compat"]`, `no_bundle: true`).

The probe registers `createMiddleware().server(...)` request middleware in `src/start.ts`, exactly the Lovable
hook point. Per request it starts a delivery that sleeps 300 ms and then POSTs to the local sink, in one of the modes
below. TTFB is "time until response headers" measured by the harness over loopback for a tiny page, after warm-up.
Raw JSON: `raw/cf-ok.json`, `raw/node-ok.json`, `raw/{cf,node}-{500,hang}.json`, `raw/cf-down.json`.

## Findings

### F1. What `next()` returns (this differs from the brief's sketch)

In TanStack Start 1.169 request middleware, `next()` does **not** resolve to a `Response`. It resolves to the
middleware context object (`keys: request|pathname|handlerType|context|response`) whose `.response` is the
`Response`. The handler accepts a returned context or a returned `Response`. My first probe wrapped the result in
`new Response(res.body, res)`, which produced an empty 200 page; the adapter therefore must `return` exactly what
`next()` returned and never reconstruct it. `createIdrServerMiddleware` does this, and the tests assert object
identity (`expect(out).toBe(ctx)`).

Also: TanStack answers a request whose `Accept` lacks `text/html` with 200 and an empty body ("Only HTML requests
are supported here"), which is one more reason the `Accept` rule in `tsa-1` is not a loss of real traffic.

### F2. (a) How `waitUntil` can be obtained, (b) un-awaited, (c) awaited: Cloudflare build under workerd

| probe mode | HTTP | TTFB ms | sink received | sink arrival after response complete | notes |
|---|---|---|---|---|---|
| none | 200 | 13 | **no** | never | control (no delivery) |
| unawaited | 200 | 11 | **no** | never | `void deliver()` (300 ms delay, then POST) |
| awaited | 200 | 325 | yes | -14 ms (before response completed) | `await deliver()` before returning; `sink:200` |
| cfworkers | 200 | 9 | yes | +298 ms | `import("cloudflare:workers").waitUntil`; `cloudflare:workers ok` |
| request | 200 | 8 | yes | +302 ms | `request.waitUntil` (Nitro `augmentReq`); `waitUntil=function runtime.cf.ctx.waitUntil=function` |
| event | 200 | 10 | **no** | never | `getEvent()` from `nitro/context`; `ev=false keys= wu=undefined` |

* **(a) `request.waitUntil` works.** Nitro's `augmentReq` sets `req.waitUntil = ctx.context.waitUntil.bind(...)` on the
  incoming `Request`, and that same object is what middleware sees. `import("cloudflare:workers").waitUntil` also works
  (via a computed specifier; see F4). `getEvent()` from `nitro/context` returns `undefined` inside TanStack request
  middleware (the SSR service has no Nitro event), so it is **not** usable.
* **(b) An un-awaited promise is silently lost.** The 300 ms timer and the POST never ran after the response
  completed; the sink received nothing and no error was raised. Fire-and-forget is unsafe on Workers.
* **(c) Awaiting is safe but adds the whole delay to TTFB** (about 320 ms = 300 ms + fetch). It is the only way to
  deliver without `waitUntil`, and it blocks the page.
* With `waitUntil`, the response was unchanged in TTFB (control 13 ms vs 9/8 ms)
  and the sink received the request about 300 ms after the response had completed.
* `process.env.IDR_ENV_PROBE` (set with `wrangler dev --var`) is readable under `nodejs_compat` at request time;
  `navigator.userAgent === "Cloudflare-Workers"` is true (used for runtime detection).

### F3. Same probe on the Node target (`NITRO_PRESET=node-server`)

| probe mode | HTTP | TTFB ms | sink received | sink arrival after response complete | notes |
|---|---|---|---|---|---|
| none | 200 | 7 | **no** | never | control (no delivery) |
| unawaited | 200 | 5 | yes | +311 ms | `void deliver()` (300 ms delay, then POST) |
| awaited | 200 | 314 | yes | -8 ms (before response completed) | `await deliver()` before returning; `sink:200` |
| cfworkers | 200 | 5 | **no** | never | `import("cloudflare:workers").waitUntil`; `cloudflare:workers threw Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'cloudflare:'` |
| request | 200 | 5 | yes | +298 ms | `request.waitUntil` (Nitro `augmentReq`); `waitUntil=function runtime.cf.ctx.waitUntil=undefined` |
| event | 200 | 5 | **no** | never | `getEvent()` from `nitro/context`; `ev=false keys= wu=undefined` |

* `request.waitUntil` exists on Node too (srvx), and also delivered after the response.
* An un-awaited promise **does** complete on Node (long-lived process): fire-and-forget works there.
* `import("cloudflare:workers")` throws (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); it must be inside try/catch.

### F4. A static `import { waitUntil } from "cloudflare:workers"` breaks the build

`vite build` fails: `Rolldown failed to resolve import "cloudflare:workers" ... If you do want to externalize this
module explicitly add it to build.rolldownOptions.external`. A library cannot require the app to add that, and the
import would break Node targets. The package therefore uses a **computed-specifier dynamic import**, only as a
fallback when `request.waitUntil` is absent and the runtime is Workers (verified working above).

### F5. The real package under the verified lifecycle (probe `src/start.ts` registers `createIdrServerMiddleware`)

| scenario (workerd, `waitUntil` mode) | page TTFB | outcome seen by `onDeliveryResult` |
|---|---|---|
| resolver OK (sink answers 200 `ineligible`) | 15 ms | `{"outcome": "delivered", "reason": "ok", "mode": "wait_until", "attempts": 1, "httpStatus": 200, "resolverStatus": "ineligible", "recorded": false, "durationMs": 3}` |
| resolver answers 500 | 21 ms | `{"outcome": "dropped", "reason": "http_5xx", "mode": "wait_until", "attempts": 1, "httpStatus": 500, "durationMs": 6}` |
| resolver never answers | 13 ms | `{"outcome": "dropped", "reason": "timeout", "mode": "wait_until", "attempts": 2, "durationMs": 10255}` (two 5 s attempts survive after the response; workerd keeps `waitUntil` work alive) |
| resolver down (connection refused) | 23 ms | `{"outcome": "dropped", "reason": "network", "mode": "wait_until", "attempts": 2, "durationMs": 260}` |
| Node target, resolver 500 / hang | 40 / 42 ms | `http_5xx` after 1 attempt / `timeout` after 2 attempts |

The first run of this scenario failed with reason `network` after 2 attempts in 253 ms. Cause: `fetch(..., { redirect:
"error" })` is rejected by workerd (`Invalid redirect value, must be one of "follow" or "manual"`), which the
raw-lifecycle probe did not exercise because it used a bare `fetch`. The package now uses `redirect: "manual"`
(never follows a redirect on any runtime). This is the kind of defect only the real-runtime check finds.

The sink also confirmed the wire shape: `POST /v1/entrances`, `Authorization: Bearer <32+ chars>`, body keys exactly
`contract, website_id, ip, entrance_id, occurred_at, page_key, acquisition, eligibility`.

## Decisions that follow (implemented and tested)

1. **Scheduling order.** `next()` first; its result is returned as the identical object; reporting is scheduled after
   it returns. Only successful (2xx), HTML (or unknown-shape) responses are reported (no 404/500/redirect/JSON).
2. **Background context, in order:** `request.waitUntil` (Nitro/srvx) then `cloudflare:workers` `waitUntil` (Workers
   only) then **detached** promise on a long-lived runtime (Node, Bun, Deno) then **none** on an edge isolate.
3. **Latency budget (max added TTFB).** With `waitUntil` or detached: about 0 ms (measured 0 to 3 ms, inside the noise)
   because nothing is awaited. Without any background context on an edge isolate: **0 ms by default (drop)**, or, only
   with the explicit `onUnsupportedBackground: "await"`, at most `blockingBudgetMs` (default 250, range 50 to 1000;
   the attempt is aborted at the budget).
4. **Retry.** At most **one** retry, only when `waitUntil` guarantees the work outlives the response, after
   `retryDelayMs` (250 ms), only for transient failures: timeout, network error, 429, 502, 503, 504. Never for other
   4xx (400, 401, 403, 413 mean config or contract errors) or 500. A `Retry-After` above 2 s is a drop. The retry reuses
   the same `entrance_id`, which the contract makes idempotent at the resolver.
5. **Drop policy.** Every other outcome is dropped without queueing or persistence: timeout (per-attempt 5000 ms
   default, range 250 to 10000, above the resolver's 4000 ms request deadline), network error, 4xx, 5xx, redirect,
   overload (more than `maxInFlight` reports in flight, default 50, are dropped immediately), no background context.
   Nothing is ever thrown into the page; the optional `onDeliveryResult` hook receives only a closed status.

## Not verified here (honest limits)

* Run under local workerd via `wrangler dev --local`, not the Cloudflare production edge. Production-only behaviour
  (for example the documented ceiling on how long `waitUntil` work may continue after the response, understood to be
  about 30 s) was **not** measured; the default worst case here is 2 x 5 s + 0.25 s, well inside it.
* TTFB figures are loopback measurements of a trivial page; they show the added cost of the adapter, not real-world
  TTFB.
* The Lovable site's exact lockfile was not available; versions are the ones stated in the task. The resolved
  transitive `@tanstack/start-server-core` is 1.169.39.
* Outbound `fetch` from a real Lovable/Cloudflare deployment to the Railway resolver was not exercised (no resolver
  here); the sink stands in for it.

## Gate 4 (CHR-64): the collector route and the browser collector on the same lifecycle

Run date: 3 Nov 2026, same sandbox, probe and versions as above (local workerd via `wrangler dev --local`, and the
`node-server` build), plus Google Chrome for Testing 153.0.8010.12 headless.

The probe now also registers:

* `createCollectorRoute` inline in `src/routes/idr.e.ts` `server.handlers.POST`, as the README documents;
* the browser collector in `src/routes/__root.tsx`, started in `useEffect` with `endpoint: "/idr/e"` and
  `spa: true`.

Section C of `harness.mjs` sends:

* a browser-shaped POST, with hostile headers added: `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, a cookie,
  a user agent and a referrer;
* the same `event_id` again;
* a cross-site POST;
* a path with a query string.

It then starts headless Chrome on `/landing/browser-check`, so that the page's own collector bundle sends a real
beacon to the route. Raw JSON: `raw/g4-collector-cf-ok.json`, `raw/g4-collector-cf-500.json`,
`raw/g4-collector-node-ok.json`.

| scenario | route answer to the browser | what the resolver stand-in received | `onDeliveryResult` |
|---|---|---|---|
| workerd, browser-shaped POST plus hostile headers | `204`, empty body, no `Set-Cookie`, `Cache-Control: no-store`, TTFB 10 ms | `POST /v1/events`, bearer token, body keys exactly `consent, contract, event_id, name, occurred_at, page_key, type, website_id`; `page_key` `/orders/:n` from path `/orders/12345`; none of the header values | `delivered`, `mode: wait_until`, 1 attempt |
| workerd, the same `event_id` again | `409` | nothing | `skipped/collector:replay` |
| workerd, `Origin` foreign and `Sec-Fetch-Site: cross-site` | `403` | nothing | `skipped/collector:origin` |
| workerd, path with `?email=` | `400` | nothing | `skipped/collector:path` |
| workerd, **real Chrome** loading a page | (beacon) | one `page_view` with `page_key` `/landing/browser-check` | `delivered`, `mode: wait_until` |
| workerd, resolver answers 500 (`SINK_MODE=500`) | still `204`, TTFB 10 ms | the POST (answered 500) | `dropped/http_5xx`, `mode: wait_until` |
| Node target (`node-server`), same steps | `204` / `409` / `403` / `400`, TTFB 6 ms | same as workerd | `delivered`, `mode: wait_until` (srvx sets `request.waitUntil` for server routes too) |

Findings:

* **G4-F1. `request.waitUntil` reaches server routes.** In TanStack Start server-route handlers (not only request
  middleware), the `request` carries the Nitro `waitUntil` on both workerd and Node. The route therefore uses the
  same verified background path as the middleware: the `204` is not held for the resolver, and the delivery
  survives the response.
* **G4-F2. Nothing of the route reaches client assets.** The client build strips `server.handlers`. The extended
  bundle-safety test scans the client assets for `createCollectorRoute`, `/v1/events`, `event.v1`, `sec-gpc`,
  `replayCacheSize` and the token. As a positive control it also requires the collector itself (`data-idr-event`)
  to be in the client bundle.
  * A deliberate mutation that references `createCollectorRoute` from client code makes that test fail.
  * A module-level constant used only by `server.handlers` was also stripped by TanStack's dead-code elimination
    in this version. The README still recommends the inline form.
* **G4-F3. The origin check needs no configuration here.** `wrangler dev` and the Node server keep the request
  URL's origin (`http://127.0.0.1:8799`), so the default origin check accepted Chrome's real beacon as it was. A
  proxy that rewrites the scheme or host needs the `origins` option. That case was not exercised here.

Not verified here:

* the Cloudflare production edge;
* other browsers than Chrome;
* a real consent platform;
* a real resolver `POST /v1/events`: the stand-in sink answers 200 for any body. The resolver side of `event.v1` is
  another cell's work.
