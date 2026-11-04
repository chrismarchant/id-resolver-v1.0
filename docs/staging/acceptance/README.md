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
`PROV_ECHO_URLS`, `PROV_FORGED_IP`, `PROV_FORGED_IP2` (required, both families); optional `PROV_FORGED_IP6` +
`PROV_FORGED_IP6B` (`--family 6`, used only when the canary holds F6), `PROV_EDGE_REJECT_CODES`, `PROV_TESTER_IP`.

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
# IPv6 run: forges the canary's F over an IPv6 connection (no canary change needed)
node lovable-provenance-check.mjs --family 6 --network-label home-fibre --confirm-target <project>.lovable.app,<custom-domain> \
     --out <private dir>/prov-home-v6.json
# Optional, after redeploying the canary with CANARY_FORGED_IP=<public-v6-F6>: forge an IPv6 literal instead
export PROV_FORGED_IP6=<public-v6-F6> PROV_FORGED_IP6B=<public-v6-F6b>
```

## `lovable-provenance-check.mjs` (CHR-119)

Question: on a Lovable-hosted TanStack Start site (Lovable builds for Cloudflare Workers), is the visitor IP that the
adapter selects under trust policy `{ mode: "cloudflare" }` (it reads `CF-Connecting-IP`) controlled by the hosting
provider, or can a client forge it? `cf-site-check.mjs` cannot answer this: its forged value is an RFC 5737 address,
which the adapter silently refuses, so a forgery that got through would look the same as an edge rejection.

**Set-up.**

* The site's `IDR_RESOLVER_URL` points at the canary and `IDR_RESOLVER_TOKEN` is the canary token; the site uses
  `trustPolicy: { mode: "cloudflare" }` without `allowDocumentationRanges`.
* The canary's `CANARY_FORGED_IP` **must** be the run's F (`PROV_FORGED_IP`). Before contacting the site, the script
  posts one synthetic entrance carrying F (in the body and in six forwarding headers, see G4-I8 coverage) and reads
  the canary's forged flag. A canary that holds another value is a configuration error (exit 2): only a forged value
  the canary can identify can give a FAIL.
* **One run at a time per canary, and a single canary replica**: its state is in memory and shared by every client,
  so a second run's reset or expectation changes what the first one reads. The script notices some of this (records
  at the canary right after its own reset; records gone, or the expectation lost, after a case was scored) but not all.
* Keep the site free of other traffic during a run. Only records for `PROV_PAGE_PATH` count for a case; any other
  record in a case's window makes it INCONCLUSIVE ("foreign traffic").
* `PROV_PAGE_PATH` is `/` or lowercase words (a-z joined by `-` or `_`) per segment: the adapter's default `page_key`
  mapper leaves those unchanged, so the canary's `page_key` equals the path (a site with its own `pageKeyMapper` must
  pick a path that mapper leaves alone; the Lovable set-up prompt sets none). The page must answer 200 with HTML and
  be **rendered by the Worker**: a prerendered static asset never runs the middleware, and every case would be
  INCONCLUSIVE. Paths the adapter never reports are refused; those lists are copied from `eligibility.ts` and
  `collector-path.ts`, and `self-test.mjs` pins them to the source. A site's own `includePaths` / `excludePaths` are
  not known to the script.

**Inputs.**

* F and F2 are public, non-personal IPv4 addresses (for example public DNS anycast addresses), different from each
  other and from the tester's own address, in both families. The script **refuses** (exit 2, nothing sent) a
  documentation range (RFC 5737, RFC 3849, RFC 9637) outside `--local-probe`, a private or reserved address (the
  adapter drops those, so a forgery could not be seen), and any value with a zone id (`%`) or brackets
  (`PROV_TESTER_IP` included).
* **IPv6 (P6).** By default an IPv6 run forges the canary's F, an IPv4 value, over an IPv6 connection: the adapter
  would select it from `CF-Connecting-IP` just the same, and it is the value the canary can identify. Testing an IPv6
  forged literal needs `CANARY_FORGED_IP` = F6, which means a canary redeploy; then give `PROV_FORGED_IP6` and
  `PROV_FORGED_IP6B` and the run forges F6 and F6b instead. When F6 is given but the canary holds F, the F6 cases are
  skipped with a printed note.
* `PROV_EDGE_REJECT_CODES` (default `1000`): the Cloudflare error codes that may count as an edge rejection. 1000 is
  the only code observed when Cloudflare refused a client-supplied `CF-Connecting-IP` in an earlier probe; every
  other code is INCONCLUSIVE unless the owner lists it. Listing a ban or firewall code (1006, 1007, 1008, 1009, 1010,
  1012, 1020), a rate limit (1015), a Worker error or quota (1027, 1101, 1102), a 5xx, or anything outside 1000-1999
  is refused (exit 2): those never show that the forged header was refused.
* The echo URLs (2 to 4, distinct hosts, ideally different operators) answer the caller's address as plain text, an
  `ip=` line or JSON `{"ip": ...}`; at least one must answer without a `cf-ray` header, so the ground truth is not
  taken solely through the trust path under test.
* Several entry points (the `lovable.app` subdomain, a custom domain) are tested in one run, serially;
  `--confirm-target` must then name every entry-point host, comma-separated, in any order, and nothing else. The
  canary and echo hosts are not confirmed this way.
* Run once per network (`--network-label`, letters, digits, space, `_`, `-`, never an address) and per family
  (`--family 4|6`, required). `--local-probe` accepts loopback http targets only (sites, canary and echo URLs).
* Numeric flags need a value (`--settle-ms` alone is refused). `--out` must name a new file: it is created with
  `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 600 before anything is sent, and an existing path or a symlink is refused, so
  earlier evidence is never overwritten.

**Egress (R).** Every echo URL is asked at the start and at the end of the run, over the pinned family. All answers
must parse as addresses of that family and agree with each other at the start, at the end, and between start and end
(and with `PROV_TESTER_IP` when set); otherwise the run stops before contacting the site or the canary (start) or the
overall result cannot be PASS (end). R is held in memory only: it goes to the canary's `/_canary/expect` and, in the
P5 control, to the site as `CF-Connecting-IP`; it is compared, never printed or written. The canary's shape is
checked (`GET /_canary/results`) before R is sent to it. Every request (site, echo, canary) is pinned with the
`family` lookup option and no happy-eyeballs, the connected socket's family is checked (`EFAMILY` otherwise), and the
whole request, slow bodies included, ends at `--request-deadline-s` (default 30; `EDEADLINE`). `--canary-any-family`
lets the canary be reached over either family when its host has no record for the run's family; its view of the
tester plays no part in any verdict.

**Per case.** Read back any record that reached the canary for the previous case after it was scored (a late
entrance); `POST /_canary/reset`, `/_canary/mode {"mode":"ok"}`, `/_canary/expect {"client_ip": R}`; then
`GET /_canary/results` must show no record and the expectation set, otherwise the case is INCONCLUSIVE ("foreign
traffic") and its request is not sent. Then one GET of `PROV_PAGE_PATH?idrprov=<nonce>` with browser
document-navigation headers (`Accept: text/html...`, `Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, a browser
`User-Agent`, `Cache-Control: no-cache`), then `GET /_canary/results` every 300 ms until an entrance arrives or
`--poll-timeout-s` (default 20) passes, and once more after `--settle-ms` (default 8000) to catch a second entrance or
a retry. The settle default comes from the adapter's retry schedule (`delivery.ts`, `schedule.ts`, `config.ts`): at
most two attempts, the second only under `waitUntil` after a timeout, a network error, 429, 502, 503 or 504, and
starting at most `timeoutMs` (default 5000) plus the wait (`retryDelayMs`, default 250, or a `Retry-After` of at most
2000 ms) after the first; 5000 + 2000 + a 1000 ms margin = 8000. A site with `timeoutMs` 10000 needs `--settle-ms
13000`. `--delay-ms` (default 2000) between cases.

| case | request | provider-controlled (PASS) | attacker-controllable |
|---|---|---|---|
| P1 | the baseline navigation | one entrance, ip == R | ip != R is a HOLD (wrong provenance); no entrance is INCONCLUSIVE |
| P2 | + `CF-Connecting-IP: F` | ip == R, or a qualifying edge rejection | the canary identifies F: FAIL |
| P3a-d | + `X-Forwarded-For: F` / `X-Real-IP: F` / `True-Client-IP: F` / `Forwarded: for=F` (IPv6 F: `for="[F]"`), one per case | ip == R (an edge rejection is INCONCLUSIVE) | the canary identifies F: FAIL |
| P4a, P4b | + two raw `CF-Connecting-IP` lines, (F, F2) and (F2, F), so a first-wins or last-wins selector picks F in one of them | ip == R, a qualifying edge rejection, or a 2xx page with no entrance (repeated values refused) under the same conditions | the canary identifies F: FAIL |
| P5 | + `CF-Connecting-IP: R` (control) | ip == R (an edge rejection is INCONCLUSIVE: the owner decides) | n/a (ip != R is a HOLD) |
| P6 | P1 to P5 with `--family 6` (ids `P6-P1` ...), forging F over IPv6, or F6 and F6b when the canary holds F6 | as above | as above |
| P7 | the P1 response | INFO only: `cf-ray` present (value kept), `server: cloudflare`; never a provenance proof | n/a |

**Classification, in this order** (from the canary's records: `route`, `pageKey`, `ip.present`, `ip.matchesExpected`,
`ip.matchesForged`, `compared`, `bodyContainsClientIp`, `headerNames`, `headersWithClientIp`, `headersWithForgedIp`,
`expectationSet`, `counts`). "Ours" means entrances whose `pageKey` is `PROV_PAGE_PATH`.

| condition | verdict |
|---|---|
| any record names a header carrying a visitor IP (`headersWithClientIp`, G4-I8) | FAIL |
| the canary held records (or no expectation) right after the reset | INCONCLUSIVE, foreign traffic; the request is not sent |
| forged case: an entrance of ours whose ip the canary identifies as F (`matchesForged`), or a header of ours carrying F (`headersWithForgedIp`) | FAIL |
| any record that is not ours in the case's window | INCONCLUSIVE, foreign traffic (other findings are added to the reason) |
| an address that is neither R nor F (forged case: "unexpected address in <case>"; clean case: "wrong provenance"); an entrance without `ip`; more than one entrance; a clean-case header carrying F; a record not compared; a visitor IP elsewhere in the body; the canary lost its expectation; an entrance although the site answered non-2xx or did not answer | HOLD (reason lists each) |
| exactly one entrance of ours (retries of the same `entrance_id` counted once), ip == R | PASS |
| no entrance: no answer from the site (error code) | INCONCLUSIVE |
| no entrance, 2xx, `cf-cache-status` present and not DYNAMIC, BYPASS or MISS | INCONCLUSIVE (possibly served without the Worker) |
| no entrance, 2xx, P4a or P4b, P1 passed on this entry point, and a fresh baseline right after it passes | PASS by adapter refusal; otherwise INCONCLUSIVE |
| no entrance, 2xx, any other case | INCONCLUSIVE |
| no entrance, non-2xx, P2, P4a or P4b, a qualifying edge rejection, P1 passed on this entry point, and a fresh baseline right after it passes | PASS by edge rejection; otherwise INCONCLUSIVE (only the status and the code are kept) |
| no entrance, non-2xx, P1, P3a-d or P5 | INCONCLUSIVE (the owner's matrix accepts edge rejections for P2 and P4 only) |
| a record for the case that arrives after it was scored | the case becomes a HOLD ("late entrance"), or a FAIL when that record identifies F or carries a visitor IP |

A qualifying edge rejection is a 4xx other than 429, with a `cf-ray` header and a numeric Cloudflare error code in the
body (`error code: 1000`, `cf-error-code`, `<title>... Error 1000`) that is in `PROV_EDGE_REJECT_CODES`. The fresh
baseline (printed in the case's reason as "the re-baseline right after it") is a P1-style request on the same entry
point immediately after the rejection: one entrance of ours, ip == R, 2xx. A FAIL in it makes the case a FAIL. A record
the canary could not compare is a HOLD here, never a PASS (`cf-site-check.mjs` counts it as a FAIL).

Overall: **PASS** only when every planned case on every entry point ran and passed, G4-I8 coverage at the canary is
complete and both egress checks agreed; any FAIL makes it **FAIL** and stops the run (the end egress check, a final
late-entrance check and a canary reset still run; a FAIL stays a FAIL even if the egress moved, with a note);
otherwise **HOLD**. The overall line and the `--out` file count passes by edge rejection and by adapter refusal
separately (`pass_by_edge_rejection`, `pass_by_adapter_refusal`), so that evidence is never mistaken for an entrance
with ip == R. When an entrance is missing, the reason also names unauthenticated requests the canary refused (a wrong
`IDR_RESOLVER_TOKEN`) and requests to unknown canary paths. Exit 0 PASS, 1 FAIL or HOLD, 2 refusal or configuration
error. A refusal sends nothing; three configuration errors are found after the echo checks and also exit 2 before any
request to the site: a forged value equal to the echoed R (nothing sent to the canary either), a canary that refuses
the token, and a canary whose `CANARY_FORGED_IP` is not F. The canary is reset on every exit path after it was first
contacted, so it does not keep R.

**G4-I8 coverage.** The pre-flight entrance carries F in `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`,
`True-Client-IP`, `Forwarded` and `X-Client-IP`. The canary's forged-value detection (`headersWithForgedIp`) shows
which of these names arrive at `canary-sink.mjs` still carrying F. A name that does not was stripped or overwritten by
the canary's hosting edge on the way: a visitor IP in that header on the site's subrequest could not be seen either.
Every such blind spot is printed, recorded in the `--out` file (`g4i8Coverage.blind`) and makes the overall result a
HOLD ("G4-I8 coverage incomplete: <names>"). On a host whose edge sets `X-Real-IP` itself (as many proxies do), expect
that blind spot: the owner decides whether to move the canary behind an edge that keeps these headers or to accept the
gap in writing.

**Outbound header names.** Per entry point, the exact set of header names that arrived on our entrance
subrequest(s) is printed, and every name outside this allowlist is flagged INFO for human review. Nothing is
hidden: the flag only marks what to look at, and every header value is compared by the canary for visitor IPs.

| allowed | why |
|---|---|
| `authorization`, `content-type`, `accept` | exactly what the adapter sets (`packages/tanstack/src/delivery.ts`) |
| `host`, `content-length`, `transfer-encoding`, `connection`, `accept-encoding` | HTTP framing and transport compression added by the runtime's `fetch` |
| `user-agent` | a runtime `fetch` default; its value is not visible (names only), so a forwarded visitor User-Agent could not be told apart here |
| `cf-*`, `cdn-loop` | what Cloudflare may add to a Worker subrequest (for example `cf-worker`, `cf-ray`; not verified on Lovable, which is what this list reports); a value holding the visitor IP is still a G4-I8 FAIL |
| `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host`, `x-forwarded-port`, `x-real-ip`, `x-request-start`, `x-request-id`, `x-railway-*` | what the canary's own hosting proxy (Railway) may add for the hop from Cloudflare to the canary, describing Cloudflare's egress, not the visitor; same value check, within the G4-I8 coverage above |

Not allowed, so flagged when present: for example `accept-language` and `sec-fetch-mode` (undici defaults: a hint
that the runtime is Node, not workerd), `via`, `forwarded`, `cookie`, `referer`, `<nonstandard-name>` and anything else.

**Output.** One line per case: `<siteN> net=<label> IPv4|IPv6 <case> http=<status> cf-error=<code|-> entrances=<n> =>
<verdict>[ (by edge rejection| by adapter refusal)]: <reason>`, a `<case> late => <verdict>` line when a late record
amends a case, the P7 and header-name INFO lines, the echo lines (`<echoN> via_cloudflare=<bool>`, never the
answers), the canary and G4-I8 coverage line, notes, problems, warnings and the overall line. Every line and the
`--out` file pass the redactor with R, F, F2, F6, F6b, the token and every echo answer as explicit secrets. The
`cf-ray` value is kept as asked. It names the Cloudflare data centre that served the tester (a coarse location), and
the zone owner and Cloudflare can join it to their logs, which hold the tester's address: the raw output stays
private like the result file.

**Limits.** The canary knows one forged value, so F2 (and F6b) can only be "not R and not F": a site that selects F2
gives a HOLD in P4a, and P4b then shows F if the selector is positional. An entrance is tied to its case by
`PROV_PAGE_PATH`, the reset window and the zero-record check, not by a request id (the adapter's `page_key` drops the
query nonce, and the canary has no per-request handle or run identity). The canary returns header names only, so a
header value (for example a forwarded User-Agent) cannot be judged except for visitor IPs and F. All requests use
HTTP/1.1; browsers reach Cloudflare over HTTP/2 or HTTP/3, where duplicate headers (P4) are handled differently, and
that is not covered. `CF-Connecting-IPv6`, `CF-Pseudo-IPv4` and `X-Client-IP` are not sent as forged cases. An edge
rejection alone proves nothing; it counts only as described above. A `--local-probe` result is no claim about any
platform.

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
* `lovable-provenance-check.mjs` (4 Nov 2026, CHR-119 cell, then the review fixes H1, M1-M3, L1-L7): self-test
  only, `--local-probe` against an in-process canary, two stand-in IP-echo servers, stand-in sites and a stand-in for
  the canary's hosting edge: honest; F selected through CF-Connecting-IP, X-Forwarded-For, either duplicate order, or
  a forwarded header; an address that is neither R nor F; edge rejections (allowed and disallowed codes, rate
  limiting, P3 and P5, a failing re-baseline, no passing P1); P4 refused with and without a cache-served status;
  foreign traffic before and during a case; a late entrance; a G4-I8 blind spot; a leaky header; no entrance; a
  trickling body; echo disagreement, a Cloudflare-only ground truth, a moved egress; F equal to R, a refused token, a
  canary without F, a pinned family the servers cannot answer; refusals (including `--out` over an existing file or a
  symlink); the page-path lists pinned to the adapter source; the canary left without R after every run. No IP
  literal in any output. `self-test.mjs`: 32 pass, 1 skipped, 0 fail (33 tests, 15 of them for this script); the
  skipped one is the IPv6 end-to-end test, which skips where there is no IPv6 loopback, as in that session, so the
  IPv6 path has not run. **Not run** against Lovable, Cloudflare or Railway.
* `supabase-hosted-check.mjs`: refusals and `--dry-run` only (self-test). The hosted checks are **unexecuted**;
  the `--local-stack` mode was not run (no Docker daemon in that session).
* Nothing was run against Cloudflare, Supabase, Railway or npm.
