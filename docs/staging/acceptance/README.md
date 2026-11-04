# Staging acceptance scripts

Scripts for the owner or MAIN to run **after** the owner has provisioned the disposable staging resources
([../CLOUDFLARE_TEST_SITE.md](../CLOUDFLARE_TEST_SITE.md), [../SUPABASE_HOSTED_TEST.md](../SUPABASE_HOSTED_TEST.md)).
Node 22, no dependencies beyond Node built-ins (the hosted Supabase catalog checks use the repository's `pg`).
They are not part of `npm run verify` or CI.

| file | what it is |
|---|---|
| `cf-site-check.mjs` | Cloudflare staging site: TTFB and delivery, resolver faults, trust policy, **G4-I8**, route CSRF/replay/rate checks, bundle safety, `waitUntil` ceiling, cold starts, the real-browser checklist |
| `lovable-provenance-check.mjs` | Lovable-hosted site (Cloudflare Workers, trust policy `cloudflare`): is the visitor IP the adapter selects set by the provider, or can a client forge it? (CHR-119 section 3; see [below](#lovable-provenance-checkmjs-chr-119)) |
| `canary-sink.mjs` | the stand-in resolver and header canary the owner runs next to the resolver (outside the site's zone) |
| `supabase-hosted-check.mjs` | hosted Supabase project: function auth through the gateway, sync, concurrency, RLS with real Auth, catalog and G4-L4, pg_cron/pg_net/Vault, projection = feed, optional seeding |
| `lib/common.mjs` | shared: target validation, redaction, results, raw HTTP |
| `self-test.mjs` | `node --test docs/staging/acceptance/self-test.mjs`: refusals, redaction, canary behaviour; 127.0.0.1 only |

## Safety rules (all scripts)

* **No defaults that point anywhere.** Every URL, key and token comes from environment variables at run time.
  A script refuses (exit 2, nothing sent) when a required variable is missing, a URL is not https (http only for a
  loopback host with `--local-probe` / `--local-stack`), a value still contains a `<placeholder>`, or the operator
  did not repeat the target on the command line with `--confirm-target <site host | project ref>`.
* **No secrets in output.** Output lines and result files (`--out`, written with mode 600) never contain a token,
  key, IP address, user id or e-mail address; hosts appear as `<site>`, `<canary>`, `<resolver>`, `<project>`.
  The canary stores no IP and no header value: it keeps booleans, counts and header **names**, and replaces any IP
  literal in the body strings it keeps (page key, event name, ids) with `[ip]`. Every output line and result file
  also passes a redactor that removes every IP literal in any spelling. A phase that stops on a network error
  reports the error's code, not its text, and a canary answer that is not JSON is reported by a fixed message.
* **The header canary (G4-I8, T5).** The canary inspects every request header, every repeated copy included, and
  recognises the tester's IP in any spelling (case, compressed or expanded IPv6, with a port or brackets, IPv4
  embedded in IPv6, also in hex). It compares with the tester's IP when the script has set one, with each entrance
  body's own `ip`, and with the visitor IPs of earlier entrances (in memory only), so the real browsers of phase
  `browser` are covered too. A match is a FAIL in every mode, and so is a request the canary could not compare: it
  is never a PASS. With `--local-probe` a clean, fully compared result is only INFO: local workerd is not the edge,
  and no D4 claim is made from it.
* **Enter secrets without echo**, for example `read -rs ACCEPT_CANARY_TOKEN && export ACCEPT_CANARY_TOKEN`; never on
  the command line and never in a file in the repository.
* `--dry-run` validates the configuration and prints the plan without sending anything.
* Result files are private. A summary for the repository is written separately and checked with
  `node scripts/check-public-safety.mjs` before it is committed.

## Environment variables (names only)

`cf-site-check.mjs`: `ACCEPT_SITE_URL`, `ACCEPT_SITE_ZONE`, `ACCEPT_RESOLVER_URL` (required);
`ACCEPT_CANARY_URL`, `ACCEPT_CANARY_TOKEN` (phases `ttfb`, `faults`, `route`, `ceiling`, `cold`);
`ACCEPT_PROBE_TOKEN` (`ceiling`); `ACCEPT_COLLECTOR_ALLOW`, `ACCEPT_COLLECTOR_CONSENT`, `ACCEPT_RATE_EVENTS`,
optional `ACCEPT_CONSENT_COOKIE` (`route`); optional `ACCEPT_TESTER_IP`, `ACCEPT_BUNDLE_SCAN_TOKEN`,
`ACCEPT_REPORTED_PREFIX`, `ACCEPT_CONTROL_PREFIX`, `ACCEPT_COLLECTOR_PATH`, `ACCEPT_EXPECT_COLLECTOR`.

`canary-sink.mjs`: `CANARY_TOKEN`, `CANARY_BIND`, `PORT` (required); optional `CANARY_DEFAULT_MODE`,
`CANARY_FORGED_IP`.

`lovable-provenance-check.mjs`: `PROV_SITE_URLS`, `PROV_PAGE_PATH`, `PROV_CANARY_URL`, `PROV_CANARY_TOKEN`,
`PROV_ECHO_URLS` and, for `--family 4`, `PROV_FORGED_IP` + `PROV_FORGED_IP2` or, for `--family 6`, `PROV_FORGED_IP6` +
`PROV_FORGED_IP6B` (required); optional `PROV_TESTER_IP`.

`supabase-hosted-check.mjs`: `SBH_URL`, `SBH_PUBLISHABLE_KEY`, `SBH_SERVICE_ROLE_KEY`, `SBH_SYNC_SECRET`,
`SBH_INSTALLATION_ID` (required); optional `SBH_DB_URL` with `SBH_DB_CA_FILE` (or the explicit opt-out
`SBH_DB_TLS_NOVERIFY=1`), `SBH_RESOLVER_URL` + `SBH_REPORTING_TOKEN` (oracle), `SBH_SEED_RESOLVER_URL` +
`SBH_SEED_RESOLVER_TOKEN` + `SBH_SEED_WEBSITE_ID` (with `--seed N`), `SBH_TEST_EMAIL_DOMAIN`, `SBH_EXPECT_SCHEMA`,
`SBH_EXPECT_RECONCILE`, `SBH_FUNCTION`.

## Examples

```bash
cd docs/staging/acceptance
node --test self-test.mjs

# Cloudflare staging site (after provisioning; values typed, not echoed)
export ACCEPT_SITE_URL=https://idr-staging.<STAGING_ZONE> ACCEPT_SITE_ZONE=<STAGING_ZONE> \
       ACCEPT_RESOLVER_URL=https://<canary-host> ACCEPT_CANARY_URL=https://<canary-host> \
       ACCEPT_COLLECTOR_ALLOW=page_view,scroll_50,scroll_90,engaged_30s,cta_click,form_start,form_submit \
       ACCEPT_COLLECTOR_CONSENT=required ACCEPT_CONSENT_COOKIE=staging_consent=granted ACCEPT_RATE_EVENTS=60
read -rs ACCEPT_CANARY_TOKEN && export ACCEPT_CANARY_TOKEN
read -rs ACCEPT_PROBE_TOKEN && export ACCEPT_PROBE_TOKEN
node cf-site-check.mjs --dry-run --phase all --confirm-target idr-staging.<STAGING_ZONE>
node cf-site-check.mjs --phase all --confirm-target idr-staging.<STAGING_ZONE> --out <private dir>/cf-all.json

# The same script against the repository's local workerd probe (no credentials; what was run on 3 Nov 2026)
#   cd packages/tanstack/verification/cf-lifecycle && npm ci --ignore-scripts && npm run build
#   npx wrangler dev -c .output/server/wrangler.json --port 8799 --ip 127.0.0.1 --local
#   export both CANARY_TOKEN and ACCEPT_CANARY_TOKEN as the probe's own synthetic token (src/start.ts), then:
#   CANARY_BIND=127.0.0.1 PORT=4599 node canary-sink.mjs
#   ACCEPT_SITE_URL=http://127.0.0.1:8799 ACCEPT_SITE_ZONE=probe.invalid ACCEPT_RESOLVER_URL=http://127.0.0.1:4599 \
#   ACCEPT_CANARY_URL=http://127.0.0.1:4599 ACCEPT_COLLECTOR_ALLOW=page_view,cta_click,scroll_50,scroll_90 \
#   ACCEPT_COLLECTOR_CONSENT=not_required ACCEPT_RATE_EVENTS=600 \
#   node cf-site-check.mjs --local-probe --phase all --confirm-target 127.0.0.1:8799

# Hosted Supabase project
export SBH_URL=https://<PROJECT_REF>.supabase.co SBH_INSTALLATION_ID=<installation-id>
read -rs SBH_PUBLISHABLE_KEY && export SBH_PUBLISHABLE_KEY
read -rs SBH_SERVICE_ROLE_KEY && export SBH_SERVICE_ROLE_KEY
read -rs SBH_SYNC_SECRET && export SBH_SYNC_SECRET
node supabase-hosted-check.mjs --confirm-target <PROJECT_REF> --checks auth,sync,concurrency,rls --out <private dir>/sb.json

# Lovable-hosted site: visitor-IP provenance (once per network and per family; values typed, not echoed)
export PROV_SITE_URLS=https://<project>.lovable.app,https://<custom-domain> PROV_PAGE_PATH=/ \
       PROV_CANARY_URL=https://<canary-host> PROV_ECHO_URLS=https://<echo-host-a>/<path>,https://<echo-host-b>/<path> \
       PROV_FORGED_IP=<public-v4-F> PROV_FORGED_IP2=<public-v4-F2>
read -rs PROV_CANARY_TOKEN && export PROV_CANARY_TOKEN
node lovable-provenance-check.mjs --dry-run --family 4 --network-label home-fibre --confirm-target <project>.lovable.app,<custom-domain>
node lovable-provenance-check.mjs --family 4 --network-label home-fibre --confirm-target <project>.lovable.app,<custom-domain> \
     --out <private dir>/prov-home-v4.json
export PROV_FORGED_IP6=<public-v6-F6> PROV_FORGED_IP6B=<public-v6-F6b>   # and CANARY_FORGED_IP=<public-v6-F6> on the canary
node lovable-provenance-check.mjs --family 6 --network-label home-fibre --confirm-target <project>.lovable.app,<custom-domain> \
     --out <private dir>/prov-home-v6.json
```

## `lovable-provenance-check.mjs` (CHR-119)

Question: on a Lovable-hosted TanStack Start site (Lovable builds for Cloudflare Workers), is the visitor IP that the
adapter selects under trust policy `{ mode: "cloudflare" }` (it reads `CF-Connecting-IP`) controlled by the hosting
provider, or can a client forge it? `cf-site-check.mjs` cannot answer this: its forged value is an RFC 5737 address,
which the adapter silently refuses, so a forgery that got through would look the same as an edge rejection.

**Set-up.** The site's `IDR_RESOLVER_URL` points at the canary and `IDR_RESOLVER_TOKEN` is the canary token; the site
uses `trustPolicy: { mode: "cloudflare" }` without `allowDocumentationRanges`; the canary's `CANARY_FORGED_IP` is the
run's F (`PROV_FORGED_IP`; for an IPv6 run, `PROV_FORGED_IP6`). The script checks this first by posting one synthetic
entrance carrying F to the canary and reads its forged flag; when the canary has another value, the flag is reported as
not informative and the forged cases still FAIL on any address that is not R. Keep the site free of other traffic
during a run: every entrance the canary receives in a case's window counts for that case. `PROV_PAGE_PATH` must answer
200 with HTML (a redirect or 404 is never reported by the adapter); the script refuses paths the adapter never reports.

**Inputs.** F and F2 (F6, F6b) are public, non-personal addresses that differ from each other and from the tester's
own address, for example public DNS anycast addresses. The script **refuses** (exit 2, nothing sent) a documentation
range (RFC 5737, RFC 3849) outside `--local-probe` and any private or reserved address: the adapter drops those, so a
forgery could not be seen. The echo URLs (2 to 4, distinct hosts, ideally different operators) answer the caller's
address as plain text, an `ip=` line or JSON `{"ip": ...}`; at least one must answer without a `cf-ray` header, so the
ground truth is not taken solely through the trust path under test. Several entry points (the `lovable.app` subdomain,
a custom domain) are tested in one run, serially; `--confirm-target` must then name every entry-point host,
comma-separated, in any order, and nothing else. Run once per network (`--network-label`, letters, digits, space, `_`,
`-`, never an address) and per family (`--family 4|6`, required).

**Egress (R).** Every echo URL is asked at the start and at the end of the run, over the pinned family. All answers
must parse as addresses of that family and agree with each other at the start, at the end, and between start and end
(and with `PROV_TESTER_IP` when set); otherwise the run stops before contacting the site or the canary (start) or the
overall result cannot be PASS (end). R is held in memory only: it goes to the canary's `/_canary/expect` and is
compared; it is never printed or written. Every request (site, echo, canary) is pinned with the `family` lookup option
and no happy-eyeballs, and the connected socket's family is checked (`EFAMILY` otherwise). `--canary-any-family` lets
the canary be reached over either family when its host has no record for the run's family; its view of the tester
plays no part in any verdict.

**Per case.** `POST /_canary/reset`, `/_canary/mode {"mode":"ok"}`, `/_canary/expect {"client_ip": R}`; one GET of
`PROV_PAGE_PATH?idrprov=<nonce>` with browser document-navigation headers (`Accept: text/html...`,
`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, a browser `User-Agent`, `Cache-Control: no-cache`); then
`GET /_canary/results` every 300 ms until an entrance arrives or `--poll-timeout-s` (default 20) passes, and once more
after `--settle-ms` (default 2000) to catch a second entrance or a retry. `--delay-ms` (default 2000) between cases.

| case | request | provider-controlled (PASS) | attacker-controllable |
|---|---|---|---|
| P1 | the baseline navigation | one entrance, ip == R | ip != R is a HOLD (wrong provenance); no entrance is INCONCLUSIVE |
| P2 | + `CF-Connecting-IP: F` | ip == R, or an edge rejection when P1 passed on this entry point | ip != R: FAIL |
| P3a-d | + `X-Forwarded-For: F` / `X-Real-IP: F` / `True-Client-IP: F` / `Forwarded: for=F` (IPv6 `for="[F]"`), one per case | ip == R, or an edge rejection as P2 | ip != R: FAIL |
| P4 | + two raw `CF-Connecting-IP` lines, F and F2 | ip == R, an edge rejection as P2, or a 2xx page with no entrance when P1 passed (repeated values are refused) | ip != R: FAIL |
| P5 | + `CF-Connecting-IP: R` (control) | ip == R, or an edge rejection as P2 | n/a (ip != R is a HOLD) |
| P6 | P1 to P5 with `--family 6`, R6, F6, F6b (ids `P6-P1` ...) | as above | as above |
| P7 | the P1 response | INFO only: `cf-ray` present (value kept), `server: cloudflare`; never a provenance proof | n/a |

**Classification, in this order** (from the canary's records: `ip.present`, `ip.matchesExpected`, `ip.matchesForged`,
`compared`, `bodyContainsClientIp`, `headerNames`, `headersWithClientIp`, `headersWithForgedIp`, `expectationSet`,
`counts`):

| condition | verdict |
|---|---|
| any record names a header carrying a visitor IP (`headersWithClientIp`, G4-I8) | FAIL |
| forged case, an entrance whose ip is not R | FAIL (the reason quotes the canary's forged flag as corroboration; F2 and F6b cannot be told apart from other values, so any non-R value counts) |
| clean case, ip not R; an entrance without `ip`; more than one entrance; a non-entrance record; a header carrying the canary's forged value; a record not compared; a visitor IP elsewhere in the body; the canary lost its expectation; an entrance although the site answered non-2xx or did not answer | HOLD (reason lists each) |
| exactly one entrance (retries of the same `entrance_id` counted once), ip == R | PASS |
| no entrance: no answer from the site (error code) | INCONCLUSIVE |
| no entrance, 2xx, `cf-cache-status: HIT` | INCONCLUSIVE |
| no entrance, 2xx, P4 | PASS when P1 passed on this entry point, else INCONCLUSIVE |
| no entrance, 2xx, any other case | INCONCLUSIVE |
| no entrance, non-2xx with `cf-ray` and a numeric Cloudflare error code in the body (`error code: 1000`, `cf-error-code`, `<title>... Error 1020`) | edge rejection: PASS for P2 to P5 when P1 passed on this entry point in this run, else INCONCLUSIVE; only the status and the number are kept |
| no entrance, any other non-2xx | INCONCLUSIVE |

Overall: **PASS** only when every planned case on every entry point ran and passed, and both egress checks agreed;
any FAIL makes it **FAIL** and stops the run (the end egress check still runs; a FAIL stays a FAIL even if the egress
moved, with a note); otherwise **HOLD**. When an entrance is missing, the reason also names unauthenticated requests
the canary refused (a wrong `IDR_RESOLVER_TOKEN`) and requests to unknown canary paths. Exit 0 PASS, 1 FAIL or HOLD,
2 refusal or configuration error (a forged value equal to the echoed R, or a canary that refuses the token: nothing
is sent to the site in either case).

**Outbound header names.** Per entry point, the exact set of header names that arrived on the entrance
subrequest(s) is printed, and every name outside this allowlist is flagged INFO for human review. Nothing is
hidden: the flag only marks what to look at, and every header value is compared by the canary for visitor IPs.

| allowed | why |
|---|---|
| `authorization`, `content-type`, `accept` | exactly what the adapter sets (`packages/tanstack/src/delivery.ts`) |
| `host`, `content-length`, `transfer-encoding`, `connection`, `accept-encoding` | HTTP framing and transport compression added by the runtime's `fetch` |
| `user-agent` | a runtime `fetch` default; its value is not visible (names only), so a forwarded visitor User-Agent could not be told apart here |
| `cf-*`, `cdn-loop` | what Cloudflare may add to a Worker subrequest (for example `cf-worker`, `cf-ray`; not verified on Lovable, which is what this list reports); a value holding the visitor IP is still a G4-I8 FAIL |
| `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`, `x-forwarded-port`, `x-real-ip`, `x-request-start`, `x-request-id`, `x-railway-*` | what the canary's own hosting proxy (Railway) may add for the hop from Cloudflare to the canary, describing Cloudflare's egress, not the visitor; same value check |

Not allowed, so flagged when present: for example `accept-language` and `sec-fetch-mode` (undici defaults: a hint
that the runtime is Node, not workerd), `via`, `forwarded`, `cookie`, `referer`, `<nonstandard-name>` and anything else.

**Output.** One line per case: `<siteN> net=<label> IPv4|IPv6 <case> http=<status> cf-error=<code|-> entrances=<n> =>
<verdict>: <reason>`, plus the P7 and header-name INFO lines, the echo lines (`<echoN> via_cloudflare=<bool>`, never
the answers), the canary line and the overall line. Every line and the `--out` file (opened with mode 600 before
anything is sent) pass the redactor with R, F, F2, the token and every echo answer as explicit secrets. The `cf-ray`
value is kept as asked; it names the Cloudflare data centre that served the tester (a coarse location), so the raw
output stays private like the result file.

**Limits.** The canary knows one forged value, so F2 and F6b are only "not R". An entrance is tied to its request by
the reset window, not by a request id (the adapter's `page_key` drops the query nonce, and the canary has no other
per-request handle). The canary returns header names only, so a header value (for example a forwarded User-Agent)
cannot be judged except for visitor IPs. An edge rejection alone proves nothing; it counts only with a passing P1 on
the same entry point in the same run. A `--local-probe` result is no claim about any platform.

## Executed so far (3 Nov 2026)

* `self-test.mjs`: 9 of 9 pass (Gate 5 cell D); 14 of 14 since cell E, including end-to-end runs in which a stand-in
  site leaks the tester's IPv4 or IPv6 address in many headers and spellings: G4-I8 FAILs with the header names,
  and no output holds the IP. 18 of 18 after the review R2 fixes: a run with nothing to compare against cannot
  PASS, and a header carrying an entrance body's own IP is caught without an expected IP.
* `cf-site-check.mjs --local-probe --phase all` against the local workerd probe: 53 PASS, 0 FAIL, 1 SKIP (no
  ceiling route in the probe); `--phase down`: 2 PASS. Details and the finding G5-D-F1 in
  [../CLOUDFLARE_TEST_SITE.md](../CLOUDFLARE_TEST_SITE.md) section 7.
* Cell E, after the G5-D-F1 remediation and the canary changes, `--local-probe --phase all --samples 40`: 55 PASS,
  0 FAIL, 12 INFO, 2 SKIP (ceiling route; bundle token search without `ACCEPT_BUNDLE_SCAN_TOKEN`), including the new
  route-phase check that a navigation to the collector path produces no entrance. No IP literal in the output or the
  result file.
* `lovable-provenance-check.mjs` (4 Nov 2026, CHR-119 cell): self-test only, `--local-probe` against an in-process
  canary, two stand-in IP-echo servers and stand-in sites (honest, forged CF-Connecting-IP / duplicate lines /
  X-Forwarded-For, wrong IP, edge rejection with and without a passing P1, cache HIT, leaky header, silent; echo
  disagreement, a Cloudflare-only ground truth, a moved egress, F equal to R, a refused token, a pinned family the
  servers cannot answer) and refusals; no IP literal in any output. `self-test.mjs`: 29 pass, 1 skipped, 0 fail
  (30 tests, 12 of them new); the skipped one is the IPv6 end-to-end test, which skips where there is no IPv6 loopback,
  as in that session. **Not run** against Lovable, Cloudflare or Railway.
* `supabase-hosted-check.mjs`: refusals and `--dry-run` only (self-test). The hosted checks are **unexecuted**;
  the `--local-stack` mode was not run (no Docker daemon in that session).
* Nothing was run against Cloudflare, Supabase, Railway or npm.
