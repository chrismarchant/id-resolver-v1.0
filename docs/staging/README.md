# Staging preparation (Gate 5)

Plans, specifications and acceptance scripts for testing ID Resolver V1 outside local emulation: on the Cloudflare
production edge, on hosted Supabase, and for publishing the two packages to npm. **Nothing here is provisioned.**
No credential was created, requested or used to write these documents; every placeholder (`<STAGING_ZONE>`,
`<PROJECT_REF>`, `<canary-host>`, `<resolver-dev-host>`, `<GITHUB_OWNER>/<REPO>`) is filled in privately, never in
this public repository.

| document | content |
|---|---|
| [CLOUDFLARE_TEST_SITE.md](CLOUDFLARE_TEST_SITE.md) | disposable Cloudflare (and optionally Lovable-hosted) test site: infrastructure, **G4-I8**, test plan T1 to T12, acceptance, teardown, cost |
| [SUPABASE_HOSTED_TEST.md](SUPABASE_HOSTED_TEST.md) | disposable hosted Supabase project: infrastructure, SQL apply method, test plan H0 to H15 mapped to the local limitations, acceptance, teardown, cost |
| [../NPM_PUBLISHING.md](../NPM_PUBLISHING.md) | npm publication requirements for `@salescrusader/idr-collector` and `@salescrusader/idr-tanstack` (D5), readiness checklist, `npm pack` contents |
| [release-npm.workflow.draft.yml](release-npm.workflow.draft.yml) | the proposed release workflow, a **draft** outside `.github/workflows/` (it cannot run) |
| [acceptance/](acceptance/README.md) | acceptance scripts: `cf-site-check.mjs`, `canary-sink.mjs`, `supabase-hosted-check.mjs`, `self-test.mjs` |

## Verification status of external facts

The official documentation hosts (Cloudflare, Supabase, npm, GitHub docs) could not be opened from the session that
wrote these plans. External facts are therefore marked **SEARCH-ONLY** (taken from search results that quote the
official page; the page itself was not read) or **UNVERIFIED**, with the URL and the date. Confirm them on the live
pages before approving costs or relying on a limit. The single most important one: Cloudflare's header reference is
inconsistent about whether a Worker subrequest to a **non-Cloudflare** host carries the visitor's IP in
`CF-Connecting-IP` / `X-Real-IP`. The Cloudflare plan therefore **measures** this (T5) and makes it a hard gate,
instead of relying on "the resolver is outside the site's zone" alone (G4-I8). The owner's decision of 3 Nov 2026
makes T5 a mandatory staging gate with six requirements (inspection at the receiving boundary on the real edge, all
headers, explicit outbound headers, no visitor IP in retained evidence, stop on propagation, no D4 claim from local
tests): section 4 of that plan. T5 has not been run.

## What needs separate owner approval

Every item below is an owner action. None of them may be done by a cell, and each is approved on its own.

**Cloudflare test site**

1. Choosing the staging zone; enabling Workers Paid for one month (about USD 5).
2. Creating the Worker, its Custom Domain, zone settings (Bot Fight Mode, Transform Rule for the CSP).
3. Generating and setting the Worker secrets (`IDR_RESOLVER_TOKEN`, `STAGING_PROBE_TOKEN`, `STAGING_CANARY_TOKEN`).
4. Creating the canary service in the Railway development project, its domain and its `CANARY_TOKEN`.
5. Issuing a staging-only website token on the development resolver (T11), and `EVENTS_ENABLED=true` there for the
   test.
6. Optional: a Lovable project for Variant B.
7. Teardown and rotation (CLOUDFLARE_TEST_SITE.md section 9).

**Hosted Supabase**

8. Choosing the organisation, plan (Pro or Free) and region (data residency); creating the project (USD 0 to 35).
9. The database password, the CLI login (personal access token), the function secrets, the Vault values.
10. Auth settings (sign-ups off) and the temporary users the script creates and deletes.
11. On the development resolver: a staging-only reporting token, `ALLOW_DOCUMENTATION_RANGES=true` for seeding,
    optionally `OBSERVATION_RETENTION_DAYS=1` for H10.
12. Optional E1 (`supabase db push` experiment) on a second throwaway project.
13. Teardown and rotation (SUPABASE_HOSTED_TEST.md section 8).

**npm (D5)**

14. The licence decision (blocking), the scope and npm organisation, 2FA with a security key.
15. The GitHub environment `npm-release` and the tag ruleset.
16. The release-preparation change to the manifests and READMEs, and activating the workflow.
17. The first version (bootstrap, NPM_PUBLISHING.md 2.4), the trusted publishers, "disallow tokens".

**Using the scripts**

18. Handing the run-time environment to MAIN (never through a chat or a repository file), or running the scripts
    personally.

## Order of operations

1. **Review and approve these plans** (this gate). Confirm the SEARCH-ONLY facts on the live pages.
2. **Cloudflare first, canary only** (CLOUDFLARE_TEST_SITE.md 5.1 steps 1 and 2): provision the site and the
   canary, run `preflight` and `ttfb`. **If T5 (G4-I8) observes visitor-IP propagation, stop staging acceptance**
   and the owner decides one of the options in section 4 of that plan before anything else runs.
3. The rest of the Cloudflare plan: T3, T6 to T10, the real browsers (T8), then T11 and T12 against the development
   resolver.
4. **Hosted Supabase** (independent of step 3, but it uses the same development resolver): HU, H0 to H8, H13 to H15;
   day 2: H11, H12; optional H10, E1.
5. Write the results summary (`docs/staging/results/`, no hosts or values) and update SETUP.md, the package READMEs
   and RESULTS.md where hosted behaviour differs from the local runs.
6. **Teardown** of both, with token rotation.
7. **npm**: the licence and scope decisions can happen at any time; the first publish (`0.1.0-rc.1`, dist-tag
   `next`) only after steps 2 and 3 passed, so that the published code is the code that was tested on the edge.
   `0.1.0` on `latest` after the owner accepts the staging results.

## Findings made while preparing

* **G5-D-F1** (low): with only `POST` registered on the collector route, as the README documents, a `GET` to the
  route path is served by TanStack Start (200, an empty route page), not by `createCollectorRoute` (whose check 1
  promised 405). Nothing is forwarded. A browser navigation to that path was reported as an entrance. Found by
  running `cf-site-check.mjs` against the local probe. **Status: remediated in the adapter (Gate 5 cell E), pending
  independent review.** The entrance middleware never reports the collector path (`collectorPath`, default
  `/idr/e`), for every method and every spelling the router routes there, with no site configuration; the README
  explains what a client sees for `GET`. `excludePaths: ["/idr/e"]` is no longer required. Phase `route` checks it on
  the edge.
* **G4-I8 strengthened**: "outside the site's zone" may not be sufficient for a non-Cloudflare resolver host
  (section 4 of the Cloudflare plan); the canary test decides. Gate 5 cell E added the code-side evidence (the
  adapter's exact outbound header set on both paths, `packages/tanstack/test/outbound-headers.test.ts`) and
  hardened the canary (every header and copy, any spelling of the IP, nothing retained). That is not T5: only the
  real edge can show what Cloudflare adds.
* **npm readiness**: no licence (`UNLICENSED`), no `repository` field, tanstack `engines` capped below Node 23, a
  stale vocabulary status in the collector README, repository-relative links in the tanstack README
  (NPM_PUBLISHING.md section 3).
