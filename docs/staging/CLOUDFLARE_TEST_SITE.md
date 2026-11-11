# Disposable Cloudflare test site: plan (Gate 5, staging preparation)

Status: **plan only**. Nothing in this document has been provisioned, and no credential was created or used to
write it. Every provisioning and credential step below is an **owner action** and needs the owner's separate
approval (see [README.md](README.md)). Placeholders such as `<STAGING_ZONE>` are filled in privately, never in
this public repository.

Purpose: run the server adapter (`@id-resolver/tanstack`) and the browser collector
(`@id-resolver/collector`) on the **Cloudflare production edge**, which the Gate 2 and Gate 4 work could only
emulate with local workerd (`packages/tanstack/verification/RESULTS.md`, "Not verified here"). The test site is
disposable: it exists for the test runs and is torn down afterwards (section 9).

## 1. Sources and how far they were verified

The documentation hosts (`developers.cloudflare.com`, `www.cloudflare.com`) could **not be opened** from the
session that wrote this plan: its network policy refused them. The facts below were therefore taken from web
search results that quote those pages. They are marked **SEARCH-ONLY**: the owner (or MAIN, from a session that
can open the pages) must confirm each one against the live page before relying on it. Facts that could not be
found at all are marked **UNVERIFIED**.

| fact used by this plan | source (official page) | read | status |
|---|---|---|---|
| `waitUntil` extends a Worker for up to 30 s after the response is sent or the client disconnects; tasks still pending then are cancelled | https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/workers/runtime-apis/context/ | 3 Nov 2026 | SEARCH-ONLY |
| Free plan: 100,000 requests/day, 10 ms CPU per request, 128 MB memory, 50 subrequests per request | https://developers.cloudflare.com/workers/platform/limits/ | 3 Nov 2026 | SEARCH-ONLY |
| Paid plan: no request limit, CPU up to 5 min (default 30 s), 128 MB memory, 10,000 subrequests per request | https://developers.cloudflare.com/workers/platform/limits/ | 3 Nov 2026 | SEARCH-ONLY |
| Workers Standard pricing: 10 million requests/month included, then USD 0.30 per million; 30 million CPU ms/month included, then USD 0.02 per million CPU ms; USD 5/month minimum | https://developers.cloudflare.com/workers/platform/pricing/ | 3 Nov 2026 | SEARCH-ONLY |
| Workers Logs: included on Paid (20 million events/month, then USD 0.60 per million, 7-day retention) and Free (200,000/day, 3 days) | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ | 3 Nov 2026 | SEARCH-ONLY; a third-party headline mentions new log and trace pricing from 1 Dec 2026: UNVERIFIED |
| `CF-Connecting-IP` on Worker subrequests: **same zone** = the client's IP (it reflects `X-Real-IP`); **cross-zone between Cloudflare customer zones** = a fixed Worker address; **to a non-Cloudflare destination**, one version of the page says `CF-Connecting-IP` and `X-Real-IP` **both carry the client's IP** | https://developers.cloudflare.com/fundamentals/reference/http-headers/ | 3 Nov 2026 | SEARCH-ONLY, and the versions found disagree: see section 4 |
| `CF-Worker` header names the zone that owns the calling Worker on every Worker subrequest | same page | 3 Nov 2026 | SEARCH-ONLY |
| Wrangler: `workers_dev` (default true), `preview_urls` (default follows `workers_dev`), `routes = [{ pattern, custom_domain = true }]`, `observability` | https://developers.cloudflare.com/workers/wrangler/configuration/ | 3 Nov 2026 | SEARCH-ONLY |
| `/cdn-cgi/trace` is answered by Cloudflare on a Worker Custom Domain and shows the client IP Cloudflare saw | none found | — | UNVERIFIED (the acceptance script falls back to `ACCEPT_TESTER_IP`) |
| A response-header Transform Rule applies to responses produced by a Worker on a Custom Domain | none found | — | UNVERIFIED (the `preflight` phase reports whether a CSP arrived) |
| Where and under which zone Lovable's own hosting runs a published TanStack Start site | none found | — | UNVERIFIED |

Repository evidence this plan builds on (verified in earlier gates, local only): the lifecycle findings F1 to F5 and
G4-F1 to G4-F3 in `packages/tanstack/verification/RESULTS.md`; the route checks in `packages/tanstack/README.md`;
the collector's CSP and privacy properties in `packages/collector/README.md`; finding **G4-I8** of the Gate 4
review.

## 2. What this closes

| open item (where it is recorded) | closed by |
|---|---|
| `waitUntil` behaviour on the production edge, not local workerd (RESULTS.md "Not verified here"; blueprint "deployed test site") | T2, T3, T9 |
| the documented ~30 s ceiling on `waitUntil` work, never measured | T9 |
| outbound `fetch` from a real Cloudflare deployment to the Railway resolver (RESULTS.md) | T2, T11 |
| trust policy `cloudflare` with a real, platform-set `CF-Connecting-IP` | T4 |
| **G4-I8**: a platform-added client-IP header on the subrequest to the resolver | T5 (hard gate) |
| the bundle-safety check on a deployed client bundle (so far: a local build) | T6 |
| the first-party route checks on the edge (per-instance replay cache and rate budget across isolates) | T7 |
| the collector in Firefox, Safari and mobile browsers, under a real site CSP, with consent and GPC (collector README "Not verified") | T8 |
| cold starts | T10 |

Not in scope: load or soak tests, the Lovable editor workflow, a real consent platform (a test stand-in is used),
paid enrichment (the development resolver uses the mock provider only, owner decision D7).

## 3. Infrastructure specification

### 3.1 The site

* **Code.** A copy of the repository's probe app, `packages/tanstack/verification/cf-lifecycle`, with its own
  lockfile and the same pinned versions: TanStack Start 1.168.60, `@lovable.dev/vite-tanstack-config` 2.26.5
  (the wrapper Lovable sites use), Nitro 3.0.260603-beta with the default **`cloudflare-module`** preset, Vite
  8.1.5, React 19.2.0, Wrangler 4.157.0. The probe's hard-wired local sink and diagnostics are replaced by the
  environment-driven files in Appendix A. It lives outside this repository (a private scratch directory or a
  private repository of the owner), because it holds deployment configuration.
* **Packages under test.** Until D5 publication, the tarballs of the commit under test:
  `npm pack -w @id-resolver/tanstack` and `npm pack -w @id-resolver/collector`, installed with
  `npm install ./<tarball>`. Record the commit and the SHA-256 of each tarball with the results.
* **Build.** `npm ci --ignore-scripts && npm run build` produces `.output/` and
  `.output/server/wrangler.json` (`compatibility_flags: ["nodejs_compat"]`, `no_bundle: true`). Before deploying,
  the owner merges in the settings of 3.2 (Wrangler configuration of the generated output).
* **Variant A (primary): the owner's own Cloudflare account**, deployed with `wrangler deploy` from the build
  output. Full control of bindings, secrets, logs and zone settings.
* **Variant B (optional, after A passes): a Lovable project** built from the same files and published on Lovable's
  hosting. Closer to a client's reality, but secrets go through Lovable's UI, Worker logs and zone settings are not
  under the owner's control, and the hosting zone is UNVERIFIED. **G4-I8 (T5) must be re-run on Variant B**: the
  zone topology differs.

### 3.2 Worker, zone and route

| item | value |
|---|---|
| Worker name | `idr-stg-<YYYYMMDD>-site` (the date of creation; one Worker per test campaign) |
| zone | `<STAGING_ZONE>`: a zone in the owner's Cloudflare account that serves **nothing in production** (a spare test domain the owner already holds, or a dedicated new one). Zone plan: Free |
| hostname | `idr-staging.<STAGING_ZONE>` as a **Workers Custom Domain** (`routes = [{ pattern = "idr-staging.<STAGING_ZONE>", custom_domain = true }]`) |
| other entry points | **off**: `workers_dev = false`, `preview_urls = false`. The only way in is the custom domain, so `CF-Connecting-IP` is always set by Cloudflare (the README's precondition for trust policy `cloudflare`) |
| zone settings for the staging hostname | Bot Fight Mode off, or a WAF skip rule for the tester (otherwise scripted browser-like requests can be challenged); no cache rule on HTML; Pseudo IPv4 off (default) |
| compatibility | as generated by Nitro (`nodejs_compat`), compatibility date of the build |
| observability | `observability.enabled = true` (Workers Logs), to read the adapter's `onDeliveryResult` lines (outcome, reason, mode, attempts only; Appendix A) |
| Workers plan | **Paid (Standard)** for the campaign month: the Free plan's 10 ms CPU limit per request could fail SSR requests and confound the latency results (section 10) |
| bindings | none: no KV, D1, R2, Durable Object, Queue or service binding. Only the variables and secrets below |

### 3.3 Variables and secrets (names only)

Workers **variables** (not secret, visible in the dashboard):

| name | value |
|---|---|
| `IDR_RESOLVER_URL` | the phase's resolver base URL: the canary `https://<canary-host>` (T2 to T9), the development resolver `https://<resolver-dev-host>` (T11), or `https://resolver.invalid` (T3 "down") |
| `IDR_WEBSITE_ID` | the development resolver's `WEBSITE_ID` (for T11; any valid id while pointing at the canary) |
| `STAGING_CANARY_URL` | `https://<canary-host>`, used only by the ceiling probe route |

Workers **secrets** (set by the owner; never in `wrangler.json`, the repository, a chat, a shell history or a log):

| name | value |
|---|---|
| `IDR_RESOLVER_TOKEN` | while `IDR_RESOLVER_URL` points at the canary: the canary's `CANARY_TOKEN`. For T11: a **staging-only** website token of the development resolver (see 3.4) |
| `STAGING_PROBE_TOKEN` | a random value (`openssl rand -hex 32`) that the ceiling probe route requires in `x-staging-probe-token` |
| `STAGING_CANARY_TOKEN` | the canary's `CANARY_TOKEN` (the ceiling probe route posts its pings with it) |

Secrets handling:

* The owner generates each value locally (`openssl rand -hex 32`) and sets it with `wrangler secret put <NAME>`,
  which **prompts** for the value (so it never appears on a command line or in shell history), or in the
  dashboard. Values are kept in the owner's password manager only.
* No `VITE_` prefix on any of them: Vite inlines `VITE_*` values into client JavaScript. T6 checks the deployed
  client bundle for the token.
* The canary token and the probe token exist only for this campaign and are destroyed at teardown. If the
  development resolver's website token is used on the staging site (T11), it is a **separate, staging-only**
  value that the owner rotates at teardown.

### 3.4 The resolver endpoint

* **Real resolver (T11 only):** the isolated Railway development project (D7, mock provider), at its public
  domain `https://<resolver-dev-host>` (a `<service>.up.railway.app` name; placeholder only). For the event route
  phase against the real resolver the owner sets `EVENTS_ENABLED=true` and keeps `EVENT_CONSENT_MODE=required` on
  the development resolver for the duration, and switches it back at teardown if it was off before.
* **Canary (T2 to T9):** `docs/staging/acceptance/canary-sink.mjs`, run by the owner as a **second, temporary
  service in the same Railway development project**, with its own public domain `https://<canary-host>`. It is
  placed exactly where the resolver is (same platform, same kind of domain, outside the staging zone), so that what
  it observes on arrival is what the resolver would observe. Its environment: `CANARY_TOKEN` (secret, random, at
  least 32 characters), `CANARY_BIND=0.0.0.0`, `PORT` (set by Railway). It keeps records in memory only and stores
  no IP address and no header value; its results endpoint needs the token.

## 4. G4-I8: no visitor IP in headers towards the resolver (hard requirement)

**The finding.** On Cloudflare, a Worker subrequest can carry the original visitor's IP in headers that the
**platform** adds, not the adapter. The adapter's own request carries only `Authorization`, `Content-Type` and
`Accept` (verified, RESULTS.md F5 and G4, and asserted on both paths by `packages/tanstack/test/outbound-headers.test.ts`),
and the resolver never reads or logs request headers (`trustProxy: false`; its log lines hold route, status and
error code only). But a proxy or an access log in front of the resolver could record such a header.

**Owner decision (3 Nov 2026): T5 is a mandatory staging gate.** These six points are **requirements** of the
plan, not options:

| # | requirement | how the plan meets it |
|---|---|---|
| R1 | Inspect the actual outbound Worker → Railway request **at the receiving boundary, on the real edge** | the canary (`acceptance/canary-sink.mjs`) runs where the resolver runs (a temporary service in the Railway development project, outside the site's zone) and receives the site's real subrequests from the Cloudflare production edge, on `/v1/entrances` (phase `ttfb`) and `/v1/events` (phases `route` and `browser`), from at least two client networks |
| R2 | Check whether `CF-Connecting-IP`, `X-Real-IP` **or any other header** contains the visitor's IP | the canary inspects **every** request header, every repeated copy included (raw headers), and recognises the IP in any spelling: upper or lower case, compressed or expanded IPv6, with a port or brackets, and an IPv4 address embedded in IPv6 (also in hex). It reports every header name that arrived, and the names of those that carried the IP. It also checks event bodies for a copy of the IP. It compares with the tester's IP (when the script sets it), with each entrance body's own `ip` (so every entrance is compared, whatever the client and address family), and with the visitor IPs of earlier entrances (for events); a request with nothing to compare against is never counted as a PASS (G5R2-L5), which matters for the real browsers of phase `browser` |
| R3 | Explicit outbound header construction; never clone incoming browser request headers | code-side evidence: the adapter builds `Authorization`, `Content-Type` and `Accept` from scratch for entrances, events and `checkConnectivity`, and never copies, clones or forwards the incoming request. `packages/tanstack/test/outbound-headers.test.ts` asserts the exact header set on both paths for a request carrying the visitor's IP in `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`, `Forwarded`, `True-Client-IP`, `CF-IPCountry`, `Cookie`, `User-Agent`, `Referer`, `Origin`, `Sec-GPC` and `X-Custom`. The test-only ceiling route of Appendix A also builds its headers explicitly. This shows what the adapter sets; only R1 shows what the platform adds |
| R4 | Canary evidence must not expose real visitor IPs in retained logs | the canary compares in memory and keeps only booleans, counts and header **names**; strings it keeps from bodies have IP literals replaced by `[ip]`; it logs nothing per request. `cf-site-check.mjs` passes every output line and the `--out` file through a redactor that removes the tester's IP and every other IP literal in any spelling; a non-JSON answer or a network error is reported by a fixed message or its error code, never by its text. `acceptance/self-test.mjs` proves it (IPv4 and IPv6 leaks: FAIL with the header names, no IP in stdout, stderr or the result file). Railway's own HTTP logs of the canary service are outside these scripts: the owner checks their fields during T5 (layer 3 below); a visitor IP found there counts as observed propagation (R5). Workers Logs hold only the adapter's outcome lines (Appendix A) |
| R5 | If visitor-IP propagation is observed: **stop staging acceptance** and present the mitigation options for owner decision | see "If T5 observes propagation: stop" below. No cell or operator chooses an option |
| R6 | Do not claim D4 transport isolation from local workerd tests alone | local runs (section 7, the adapter's tests, the probe app under `wrangler dev --local`) show only what the adapter and the local runtime send. In `--local-probe` mode a header leak is still a FAIL, but a clean result is printed as INFO "no claim". Only T5 on the real edge, from two networks, can support the claim |

**Why "outside the zone" alone may not be enough.** G4-I8 suggested hosting the resolver outside the site's zone.
Cloudflare's header reference, as found by search (section 1), describes three cases, and its versions disagree:

| destination of the subrequest | `CF-Connecting-IP` on the subrequest |
|---|---|
| a hostname in the **same** zone | the visitor's IP (it reflects `X-Real-IP`) |
| a hostname in **another Cloudflare customer zone** | a fixed Worker address, "for security reasons" |
| a **non-Cloudflare** destination (for example Railway, if its domains are not a Cloudflare customer zone) | one version of the page: **both `CF-Connecting-IP` and `X-Real-IP` carry the visitor's IP** |

If the third row holds, a resolver on Railway receives the visitor's IP in headers on **every** subrequest:

* on `/v1/entrances` this duplicates, in headers, the IP that the body already carries by design (transient, never
  stored), and exposes it to any edge or access log on the way;
* on `/v1/events` it would deliver the visitor's IP to the resolver's host with each browser event. Owner decision
  D4 says no IP is forwarded for browser events. The adapter forwards none, but the platform would.

**How the plan checks the requirement.** Three layers; the second one is the gate.

1. **Placement rule (necessary).** The resolver's hostname, and the canary's, must not be the staging zone or any
   name below it, neither proxied nor DNS-only, and must not be served by a Worker or route of the site's own zone.
   The `preflight` phase checks `ACCEPT_RESOLVER_URL` and `ACCEPT_CANARY_URL` against `ACCEPT_SITE_ZONE` and fails
   otherwise.
2. **Evidence rule (the gate).** On the **production edge**, the canary, placed where the resolver is, must show
   that **no request header** of the site's subrequests contains the tester's IP, in any spelling: on
   `/v1/entrances` (phase `ttfb`) **and** on `/v1/events` (phase `route`), and for the real browsers of T8 (phase
   `browser`). The canary compares every header value (every copy) with the tester's IP in memory and keeps only
   the header **names** that matched. Any match is a FAIL.
3. **Resolver side (already true).** The resolver neither reads nor logs headers. Whether Railway's edge or its
   HTTP logs record `CF-Connecting-IP`, `X-Real-IP` or `X-Forwarded-For` values is **UNVERIFIED**; the owner checks
   the development project's HTTP log fields during T5 and records the answer.

**If T5 observes propagation: stop.** Any header carrying the visitor's IP (a FAIL in `ttfb`, `route` or
`browser`), or a visitor IP found in the canary service's Railway HTTP logs, **stops staging acceptance**: no further
phase is run as acceptance evidence, nothing is pointed at a production site, and the observation (header names and
counts only) goes to the owner with the options below for a **decision**. Each option needs that decision (and for
code, a new cell and an independent review):

* **(a)** Front the resolver with a **separate Cloudflare zone owned by the operator** (not the site's), so the
  subrequest is cross-zone between Cloudflare customer zones (fixed Worker address per the header reference), and
  re-run T5 against a canary behind that zone. Check there too that no `X-Real-IP` or `X-Forwarded-For` carries the
  visitor IP.
* **(b)** An adapter change that sets `X-Real-IP` on its outbound request to a fixed, non-identifying value, **only
  if** Cloudflare documents that this governs the platform's value for that destination. Unverified; T5 is the
  test.
* **(c)** Accept the residual, documented, only after verifying that neither Railway's edge nor its logs persist
  those headers. The weakest option; for the event path it is a D4 decision for the owner.

**How to verify (commands).** With the site pointing at the canary (`IDR_RESOLVER_URL=https://<canary-host>`,
`IDR_RESOLVER_TOKEN` = the canary token):

```bash
cd docs/staging/acceptance
# names only below; the values come from the owner's password manager at run time
export ACCEPT_SITE_URL=https://idr-staging.<STAGING_ZONE> ACCEPT_SITE_ZONE=<STAGING_ZONE> \
       ACCEPT_RESOLVER_URL=https://<canary-host> ACCEPT_CANARY_URL=https://<canary-host>
read -rs ACCEPT_CANARY_TOKEN && export ACCEPT_CANARY_TOKEN        # typed, not echoed
node cf-site-check.mjs --phase preflight,ttfb --confirm-target idr-staging.<STAGING_ZONE> --out <private dir>/t5.json
```

Expected: `PASS ... G4-I8: the resolver host is outside the site's zone` and
`PASS ... G4-I8, no request header at the resolver's hosting position carries the visitor's IP`, plus the INFO lines
with the header presence counts (`cf-connecting-ip n/N, x-real-ip n/N, cf-worker n/N`) and every header name that
arrived. Run it from two networks (IPv4 and IPv6 if available), and repeat it in phase `route` and after T8. Before
filing the result, check that the `--out` file and the terminal output contain no IP address (the scripts print
`[ip]` or `[redacted]` in its place). **T5 has not been run**: nothing is provisioned yet.

## 5. Test plan

Each test names the acceptance-script phase that performs it (`docs/staging/acceptance/cf-site-check.mjs`, see
[acceptance/README.md](acceptance/README.md)). The script prints PASS / FAIL / INFO / SKIP lines and writes a JSON
result with no host, IP, token or user data. Thresholds can be changed on the command line; the defaults are the
acceptance criteria.

| # | test | phase | procedure | acceptance criterion |
|---|---|---|---|---|
| T1 | preflight | `preflight` | site 200 over https, served by Cloudflare (`cf-ray`); G4-I8 placement rule; tester IP known; CSP and `Set-Cookie` recorded | all PASS |
| T2 | non-blocking delivery on the production edge, resolver healthy | `ttfb` | canary mode `ok`; 100 interleaved pairs: a reported page (`/landing/...`) and an excluded control page (`/control/...`) of the same Worker, random order within each pair | median paired TTFB difference **<= 10 ms** and p95 **<= 50 ms**; **>= 99%** of reported pages deliver exactly one entrance, with one attempt; no control page reported; body keys exactly the `entrance.v1` keys |
| T3 | delivery under resolver faults | `faults`, then `down` | the canary answers 500, 503, 429 (Retry-After 1), 401, hangs, or resets the connection (behind Railway's edge a reset may arrive as a 502); then the owner sets `IDR_RESOLVER_URL=https://resolver.invalid` and redeploys for `down` | the T2 TTFB criteria hold **in every mode**; attempts per entrance: 500 and 401 → 1; 503, 429, hang, reset → 2 (one retry); hang: about 5.25 s between the attempts; `down`: nothing reaches the canary |
| T4 | trust policy `cloudflare` with the real `CF-Connecting-IP` | `ttfb` | the canary compares the entrance's `ip` with the tester's IP from `/cdn-cgi/trace` (or `ACCEPT_TESTER_IP`); one request forges `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` and `True-Client-IP` | every entrance carries the tester's real IP; the forged request's entrance carries the real IP, not the forged one (Cloudflare overwrote it). If Cloudflare refuses the forged request instead, record it: that is also safe |
| T5 | **G4-I8** (owner requirements R1 to R6, section 4) | `ttfb`, `route`, `browser` | section 4: the canary at the receiving boundary inspects every header of every subrequest, in any spelling of the IP; the owner checks the canary service's Railway HTTP log fields | no header containing the tester's IP, on entrances and events, from at least two client networks; no event body containing it; no IP in the retained output or result files; no visitor IP in the canary's Railway HTTP logs. **Hard gate**: any observed propagation stops staging acceptance for an owner decision (section 4). Not run yet |
| T6 | bundle safety of the deployed client bundle | `bundle` | fetch the HTML of two pages and every same-origin script and module preload they reference (recursively), scan them | none of: `createIdrServerMiddleware`, `createCollectorRoute`, `idr-tanstack`, `/v1/entrances`, `/v1/events`, `entrance.v1`, `event.v1`, `cf-connecting-ip`, `x-forwarded-for`, `sec-gpc`, `resolverUrl`, `allowInsecureHttp`, `replayCacheSize`, `maxClockSkewMs`, the `IDR_*` names, the resolver and canary hosts, the token (with `ACCEPT_BUNDLE_SCAN_TOKEN`); positive control: `data-idr-event` present |
| T7 | first-party route on the edge | `route` | a valid event with hostile headers; replay; GET; foreign or missing `Origin`; `Sec-Fetch-Site: cross-site`; wrong content type; `Content-Length` and a chunked body above 1 KiB; malformed JSON; an `ip` field; a path with a query; an unknown and a non-allowlisted name; `Sec-GPC: 1`; consent `not_required` under `required`; a failing server-side consent check; `occurred_at` 10 min old; a burst of `rateLimit.events + 20` | each answer as in the README's table: 204 accepted; 409 replay; 403 for `Origin`, `Sec-Fetch-Site`, a non-allowlisted name, GPC and consent; 415 type; 413 size; 400 for JSON, schema, path, vocabulary and `occurred_at`; 429 rate; GET is never a 204, and a navigation (GET, HEAD, upper case, a trailing `%20`) to the collector path produces no entrance at the canary (G5-D-F1 below); the 204 is bare with `Cache-Control: no-store`; the resolver side receives exactly one `event.v1` body per accepted event, exactly the 8 keys, `page_key` mapped, no `ip`; T5 holds. **Replay and rate are per route instance**: a replay may reach another isolate and get 204 (the resolver's unique `event_id` still stores one row), and a burst may spread over isolates; both outcomes are recorded, not failed |
| T8 | collector in real browsers under the site CSP | `browser` (manual) | Chrome, Firefox and Safari (macOS), plus iOS Safari and Android Chrome if available; the checklist the phase prints: consent (test banner), withdrawal, GPC, SPA navigation, marked click, marked form with values typed in | per browser: no CSP violation and no exception from the collector in the console; no POST before consent or with GPC on; one `page_view` per path change; nothing but the 7 contract fields in any POST; the canary receives the expected names and no form value; T5 holds |
| T9 | the `waitUntil` ceiling, measured | `ceiling` | the test-only probe route (Appendix A) schedules pings at +1, 5, 10, 15, 20, 25, 28, 29, 30, 31, 32, 35, 45 and 60 s with `waitUntil`; three runs, one of them with the client disconnecting right after the headers | every ping up to **+25 s** arrives in all runs (the adapter's worst case is 2 x 5 s + 0.25 s = 10.25 s by default, 20.25 s at the maximum `timeoutMs` of 10000); the observed ceiling (last ping received) is recorded |
| T10 | cold starts | `cold` | the owner deploys a new version immediately before the phase (new isolates), and again after 30 min idle | the first request answers 200 and its entrance is delivered; first-request TTFB and the warm median are recorded (no threshold: Cloudflare does not promise a number) |
| T11 | the real development resolver end to end | manual + `ttfb` without canary checks | point the site at `https://<resolver-dev-host>` with the staging-only token; run `checkConnectivity` (README "Confirm connectivity"); load pages in a browser; with `EVENTS_ENABLED=true`, accept consent | `checkConnectivity` → `ok`, `ineligible`; Workers Logs show `delivered` for browser page loads; the resolver's usage counters move; browser events are stored (`recorded`); page TTFB as in T2 |
| T12 | fail-open with a wrong token on the real resolver | manual | set a wrong `IDR_RESOLVER_TOKEN`, load pages | pages unchanged; Workers Logs show `dropped/http_4xx`, one attempt; restore afterwards |

**Finding G5-D-F1 (from running the script against the local probe, section 7). Status: remediated in the adapter
(Gate 5 cell E), pending independent review.** With only `POST` registered on the collector route, as the README
documents, a `GET /idr/e` never reaches `createCollectorRoute`: TanStack Start renders an empty route page with
**200**. The README's check 1 (`405`, `Allow: POST`) was therefore not what a client sees. Nothing is forwarded, so
this was not a security issue; but a browser navigation to that path was an eligible document request and was
reported as an entrance with `page_key` `/idr/e`. The remediation (owner approval of 3 Nov 2026): the entrance
middleware now never reports the collector path (`collectorPath`, default `/idr/e`), for every method, without any
site configuration; the hook shows `skipped/eligibility:collector_path`. Which spellings count is decided by
repeating TanStack Start's own path canonicalisation (decoding, the second URL parse with its whitespace trimming and
dot segments, trailing slashes, case). Review R2 found one family the first version missed (`/idr/e%20`, G5R2-L1,
since fixed); the fix is tested against the router code pinned by the probe app (a differential test with no
spelling that the router dispatches to the route left eligible) and through the probe under local workerd. Not
covered, and documented in the README: a router `basepath` (the un-prefixed path also reaches the route) and input
rewrites such as locale prefixes; such sites list those spellings in `excludePaths` (G5R2-L6). Application routing is unchanged (the framework still serves its page), and
the README now says what a client sees for `GET`. Regression tests include the probe app under local workerd: a
`GET /idr/e` navigation through the real router no longer reaches the sink, while an ordinary page still does
(`packages/tanstack/verification/RESULTS.md`, Gate 5). `excludePaths: ["/idr/e"]` is no longer required. The phase
`route` now checks on the edge that a navigation to the collector path produces no entrance.

### 5.1 Order of a run

1. Owner provisions (section 8, steps 1 to 6). Site points at the canary.
2. `preflight` → `ttfb` (T1, T2, T4, T5). **Stop staging acceptance here if T5 observes propagation** (section 4):
   the owner decides between the options there before anything else runs.
3. `faults` (T3), `route` (T7), `bundle` (T6), `ceiling` (T9), `browser` (T8, manual).
4. Owner switches `IDR_RESOLVER_URL` to `https://resolver.invalid`, redeploys → `down` (T3).
5. Owner redeploys → `cold` (T10); again after 30 min idle.
6. Owner switches to the development resolver and its staging-only token → T11, T12.
7. Optional: Variant B (Lovable hosting) → `preflight`, `ttfb`, `route`, `bundle`, `browser` again.
8. Teardown (section 9).

The result files go to a private directory. A summary for the repository (counts, medians, PASS/FAIL, no host
names) is written later as `docs/staging/results/` by MAIN and checked with the public-safety gate before commit.

## 6. Acceptance criteria (summary)

The staging site **passes** when, on Variant A (and on Variant B if it is run):

1. T1 to T7, T9 and T10 have no FAIL line, from at least two client networks;
2. **T5 (G4-I8) passes** in `ttfb`, `route` and `browser`, from at least two client networks, with no IP in the
   retained evidence; any observed propagation stops staging acceptance and blocks any production use until the
   owner has decided one of the options in section 4 and T5 has been re-run;
3. T8 is completed for Chrome, Firefox and Safari with no CSP violation, no exception, consent and GPC respected,
   and the results are written down per browser;
4. T11 and T12 behave as stated, and the Workers Logs show only non-identifying outcome lines;
5. the observed `waitUntil` ceiling (T9) is at least 25 s; if it is lower than the adapter's worst case, the
   defaults (`timeoutMs`, `retry`) must be revisited before production.

## 7. What was executed while writing this plan

No Cloudflare resource exists. The acceptance script was run **locally**, against the repository's probe app under
local workerd (`wrangler dev --local`, `cf-lifecycle` built for `cloudflare-module`) with the canary on
127.0.0.1, using the probe's own synthetic token. `--local-probe` skips the edge-only checks (cf-ray, the forged
header overwrite, the ceiling route). The G4-I8 header canary still runs there: since Gate 5 cell E a header carrying
the tester's IP is a FAIL in this mode too, and a clean result is INFO, because local workerd is not the edge (no D4
claim, R6). Result on 3 Nov 2026 (cell D, before the G5-D-F1 remediation):

| run | result |
|---|---|
| first run, `faults`, `route`, `bundle`, `cold` | 1 FAIL: `GET /idr/e` answered 200 instead of the README's 405. This is finding G5-D-F1 (section 5, since remediated in the adapter); the check now asserts what matters ("GET is never accepted as an event") and reports where the answer came from |
| final run, `--phase all` (`preflight`, `ttfb` 40 pairs, `faults` 30 pairs per mode, `route`, `bundle`, `ceiling`) | **53 PASS, 0 FAIL, 10 INFO, 1 SKIP** (ceiling: the probe has no probe route). TTFB paired difference median 0 ms, p95 3.3 ms (`ok`); medians 0.3 to 0.7 ms and p95 at most 3.8 ms under 500, 503, 429, 401, hang and reset. 40 of 40 entrances delivered with one attempt, the injected IP delivered 40 of 40. Attempts: 500 and 401 one, the others two; hang retry after a median 5252 ms. Route: every refusal as documented; 600 of 620 burst events accepted, then 429 (one instance, budget 600); 600 distinct `event_id`s forwarded with exactly the 8 keys and no `ip`. Bundle: 4 files, no marker, collector present |
| `down` (nothing listening on the resolver port) | 2 PASS (TTFB unchanged) |
| `cold` | 2 PASS (a local restart is not an edge cold start) |
| cell E (after the G5-D-F1 remediation and the canary changes), `--phase all`, 40 pairs | **55 PASS, 0 FAIL, 12 INFO, 2 SKIP** (ceiling: no probe route; bundle token search: `ACCEPT_BUNDLE_SCAN_TOKEN` not set). New: `G5-D-F1: a browser navigation to the collector path (GET, HEAD, upper case) produced no entrance` PASS (the framework answered 200 to each, 0 entrances at the canary); event bodies carry no copy of the tester's IP; header names at the canary: `accept`, `authorization`, `cf-worker`, `content-length`, `content-type`, `host` (40 entrances, 600 events), none with the test IP (INFO: local, no claim). The terminal output and the result file contain no IP literal |

Local workerd is not the production edge: these runs show that the script works, not that the edge behaves.

## 8. Provisioning steps (all owner actions, each needs approval)

1. Choose `<STAGING_ZONE>` and confirm it serves nothing in production. Enable Workers Paid for the campaign month.
2. Create the canary service in the Railway development project from `docs/staging/acceptance/canary-sink.mjs`
   (start command `node canary-sink.mjs`, Node 22), set `CANARY_TOKEN` (secret), `CANARY_BIND=0.0.0.0`, generate
   its public domain, check `GET /healthz`.
3. Build the site (Appendix A) with the tarballs of the commit under test; add the Wrangler settings of 3.2 to the
   generated configuration.
4. `npx wrangler deploy -c .output/server/wrangler.json` (Wrangler 4.157.0 from the site's lockfile); attach the
   Custom Domain; confirm `workers_dev` and preview URLs are off (a request to the workers.dev name must fail).
5. Set the variables (3.3) and the secrets with `wrangler secret put`.
6. Set the staging hostname's zone settings (3.2) and, if used, the CSP Transform Rule (Appendix A).
7. Hand MAIN (or run personally) the environment for the acceptance script; MAIN never receives the values in a
   chat or a file in the repository.

## 9. Teardown (owner)

1. `wrangler delete` the Worker (its secrets go with it); remove the Custom Domain and any DNS record, Transform
   Rule or WAF rule created for the staging hostname.
2. Delete the canary service and its public domain in Railway.
3. Destroy the canary token and the probe token; **rotate** the development resolver's website token if a
   staging-only token was issued for T11 (and remove it from the resolver).
4. Restore `EVENTS_ENABLED` on the development resolver to its earlier value.
5. If the zone was created for this test, remove it; if Workers Paid was enabled only for this campaign,
   downgrade it after the billing period.
6. Check the Cloudflare and Railway billing pages for leftovers one day later.
7. Delete the private result files once their summary is committed (they contain no secret, but they are not
   needed).

## 10. Cost estimate

Based on the SEARCH-ONLY figures of section 1 (Cloudflare Workers pricing page, read through search on
3 Nov 2026). Confirm on the live pages before approving.

| item | estimate |
|---|---|
| Workers Paid (Standard) | **USD 5** for the campaign month (minimum charge) |
| requests: one full run is about 3,000 (T2 200 + warm-up, T3 6 x 60 + 60, T7 about 700, T6 about 20, T9 3 + 42 subrequests, T10 11, browsers a few hundred); ten runs about 30,000 | inside the 10 million included: **USD 0** |
| CPU: SSR of a small page, assumed 5 to 20 ms each: under 1 million CPU ms for ten runs | inside the 30 million included: **USD 0** |
| Workers Logs | inside the 20 million events included: **USD 0** (pricing change from 1 Dec 2026 UNVERIFIED) |
| zone | Free plan: **USD 0** with a domain the owner already holds; a new domain costs a registration fee that depends on the TLD (UNVERIFIED) |
| canary on Railway (development project, a few days, tiny Node process) | **under USD 1**, usage-based (Railway pricing not checked: UNVERIFIED) |
| **total** | **about USD 5 to 6** for one campaign month, plus a domain if one is bought |

## 11. Unverified items and residual risk

* All Cloudflare facts in section 1 are SEARCH-ONLY; the CF-Connecting-IP behaviour for non-Cloudflare
  destinations is contradictory between versions of the page. T5 measures it instead of assuming it.
* `/cdn-cgi/trace` on a Custom Domain, Transform Rules on Worker responses, Lovable's hosting zone, Railway's HTTP
  log fields, Railway pricing: UNVERIFIED.
* The per-instance replay cache and rate budget of the collector route are weaker on the edge than in one
  process (many isolates). The resolver's unique `event_id` bounds replays; nothing bounds a scripted client that
  sets `Origin` (G4-I1: browser events are forgeable telemetry).
* The test site's consent banner is a stand-in, not a consent platform.
* The canary recognises the tester's IP as text (any spelling, embedded in IPv6). It cannot recognise a value
  derived from it in another way (a hash, an integer form, Cloudflare's Pseudo IPv4 for an IPv6 visitor, which is
  why Pseudo IPv4 stays off). The header-names INFO line lists every header that arrived, so an unexpected header
  can still be looked at by hand.
* Network conditions of the tester's location dominate absolute TTFB; the paired comparison measures only the
  added cost.

## Appendix A: test site files (deltas from the probe app)

Placeholders only. These files replace the probe's `src/start.ts`, `src/routes/idr.e.ts` and
`src/routes/__root.tsx`, and add three routes. The probe's `/m/...` and `/diag/...` paths are removed.

`src/start.ts`:

```ts
import { createStart, createMiddleware } from "@tanstack/react-start";
import { createIdrServerMiddleware } from "@id-resolver/tanstack";

const idr = createMiddleware().server(
  createIdrServerMiddleware(() => ({
    resolverUrl: process.env.IDR_RESOLVER_URL ?? "",
    token: process.env.IDR_RESOLVER_TOKEN ?? "",
    websiteId: process.env.IDR_WEBSITE_ID ?? "",
    trustPolicy: { mode: "cloudflare" },
    // control pages and the probe route are never reported. The collector route (/idr/e) needs no entry: the
    // adapter excludes collectorPath by default (G5-D-F1), and phase `route` checks exactly that on the edge.
    // A production site may still list "/idr/e" here as belt and braces; it is not required.
    eligibility: { excludePaths: ["/control/*", "/staging-probe/*"] },
    // non-identifying outcome only; visible in Workers Logs
    onDeliveryResult: (r) => { if (r.outcome !== "skipped") console.log("idr", r.outcome, r.reason, r.mode, r.attempts); },
  })),
);

export const startInstance = createStart(() => ({ requestMiddleware: [idr] }));
```

`src/routes/landing.$slug.tsx` and `src/routes/control.$slug.tsx` (identical page; only the path differs, so
`/control/...` is the same Worker and page without reporting):

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";

function Page() {
  return (
    <main>
      <h1>staging landing</h1>
      <button data-idr-event="cta_click">Book a demo (test)</button>
      <form data-idr-form onSubmit={(e) => e.preventDefault()}>
        <input name="company" /> <button type="submit">Send (test)</button>
      </form>
      <Link to="/landing/$slug" params={{ slug: "spa-two" }}>next page</Link>
      <div style={{ height: "300vh" }} />
    </main>
  );
}
export const Route = createFileRoute("/landing/$slug")({ component: Page }); // "/control/$slug" in the copy
```

`src/routes/idr.e.ts` (rate budget lowered so that T7 can reach it cheaply; consent required, with a test cookie as
the stand-in for a consent platform):

```ts
import { createFileRoute } from "@tanstack/react-router";
import { createCollectorRoute } from "@id-resolver/tanstack";

export const Route = createFileRoute("/idr/e")({
  server: {
    handlers: {
      POST: createCollectorRoute(() => ({
        resolverUrl: process.env.IDR_RESOLVER_URL ?? "",
        token: process.env.IDR_RESOLVER_TOKEN ?? "",
        websiteId: process.env.IDR_WEBSITE_ID ?? "",
        allow: ["page_view", "scroll_50", "scroll_90", "engaged_30s", "cta_click", "form_start", "form_submit"],
        consent: "required",
        hasConsent: (request) => /(?:^|;\s*)staging_consent=granted(?:;|$)/.test(request.headers.get("cookie") ?? ""),
        rateLimit: { events: 60, windowMs: 60_000 },
        onDeliveryResult: (r) => { if (r.outcome !== "skipped") console.log("idr-event", r.outcome, r.reason, r.attempts); },
      })),
    },
  },
});
```

`src/routes/__root.tsx` (collector with the test consent banner; the banner writes the site's own consent cookie,
which only the site's hooks read, never the collector):

```tsx
import { useEffect, useState } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { initCollector } from "@id-resolver/collector";

const listeners = new Set<(granted: boolean) => void>();
const granted = () => /(?:^|;\s*)staging_consent=granted(?:;|$)/.test(document.cookie);
function setConsent(on: boolean) {
  document.cookie = `staging_consent=${on ? "granted" : "denied"}; Path=/; Secure; SameSite=Lax`;
  for (const l of listeners) l(on);
}

function IdrCollector() {
  useEffect(() => {
    const c = initCollector({
      endpoint: "/idr/e",
      allow: ["page_view", "scroll_50", "scroll_90", "engaged_30s", "cta_click", "form_start", "form_submit"],
      consent: "required",
      hasConsent: granted,
      onConsentChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
      spa: true,
    });
    return () => c.stop();
  }, []);
  return null;
}

function TestConsentBanner() {
  const [, force] = useState(0);
  return (
    <aside>
      <button onClick={() => { setConsent(true); force((n) => n + 1); }}>Accept analytics (test)</button>
      <button onClick={() => { setConsent(false); force((n) => n + 1); }}>Withdraw (test)</button>
    </aside>
  );
}

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: "utf-8" }, { title: "idr staging" }] }),
  component: () => (
    <html lang="en">
      <head><HeadContent /></head>
      <body><TestConsentBanner /><IdrCollector /><Outlet /><Scripts /></body>
    </html>
  ),
});
```

`src/routes/staging-probe.ceiling.ts` (test-only; T9). It answers `202` at once and keeps pinging the canary from
`waitUntil` (G4-F1: `request.waitUntil` reaches server routes):

```ts
import { createFileRoute } from "@tanstack/react-router";

const OFFSETS_S = [1, 5, 10, 15, 20, 25, 28, 29, 30, 31, 32, 35, 45, 60];
async function same(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = a.length ^ b.length;
  for (let i = 0; i < u.length; i++) d |= u[i]! ^ v[i]!;
  return d === 0;
}

export const Route = createFileRoute("/staging-probe/ceiling")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.STAGING_PROBE_TOKEN ?? "";
        if (expected.length < 32 || !(await same(request.headers.get("x-staging-probe-token") ?? "", expected))) return new Response(null, { status: 404 });
        const body = (await request.json().catch(() => null)) as { probe_id?: unknown } | null;
        const id = typeof body?.probe_id === "string" && /^[a-z]{1,16}$/.test(body.probe_id) ? body.probe_id : null;
        const wait = (request as unknown as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil;
        if (!id || typeof wait !== "function") return new Response(null, { status: 400 });
        const base = process.env.STAGING_CANARY_URL ?? "";
        const token = process.env.STAGING_CANARY_TOKEN ?? "";
        for (const s of OFFSETS_S) {
          wait.call(request, new Promise((r) => setTimeout(r, s * 1000)).then(() =>
            fetch(`${base}/ceiling/${id}/${s}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }).catch(() => undefined),
          ));
        }
        return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
      },
    },
  },
});
```

**Content-Security-Policy for the staging hostname.** TanStack Start's server-rendered HTML contains inline
`<script>` elements (hydration and scroll restoration), so a policy without `'unsafe-inline'` or nonces breaks the
site itself, not the collector. The staging policy is therefore:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

The collector needs only `connect-src 'self'` and no `'unsafe-eval'`; its stricter-policy behaviour was already
verified in headless Chrome (collector README). Set it as a response-header Transform Rule on the staging hostname
(UNVERIFIED that it applies to Worker responses: `preflight` prints whether a CSP arrived), or through the
header-setting API of the pinned TanStack Start version. If the client's real Lovable site has its own CSP, run T8
a second time with that policy.
