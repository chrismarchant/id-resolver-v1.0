# ID Resolver V1 — architecture

Status: Gate 2 (development baseline). Owner-approved reduction of the V0.1
resolver (see [PROVENANCE.md](PROVENANCE.md)). Items marked *(in progress)* are
not implemented yet.

## Deployment model

**One client website → one dedicated Railway project → one client
Insights/Supabase environment.** There is no shared multi-tenant resolver.
Each client's Insights app and Supabase project are provisioned separately, on
demand. This repository ships a *reference* integration for them and never
contains client-specific project ids, URLs or credentials.

```
Browser ─document request─▶ CDN ─▶ TanStack Start site (Lovable; Nitro, Cloudflare target)
                                    │ server request middleware  [packages: server adapter]
                                    │  eligibility · trusted client IP · page key · acquisition class
                                    │  non-blocking forward; the page never waits or fails on the resolver
                                    ▼ HTTPS + resolver bearer token (server-only)
                         Railway: resolver service + PostgreSQL (one per client)
                                    │ canonicalise IP → HMAC fingerprint → cache (lease/fence)
                                    │ → kill switch → atomic period cap → provider (timeout) → qualify
                                    │ → company observation (also on cache hits)
                                    ▲ HTTPS + read-only reporting token (held by the Edge Function)
                         Client Supabase: reference Edge Function pulls the observation feed
```

## Fixed boundaries

* **Raw IP is transient.** It exists in memory only (site middleware → TLS →
  resolver → provider). It is never stored, logged or returned.
* **Two separate stores.** The fingerprint cache (TTL, keyed by an HMAC of the
  IP) is separate from the company activity register (durable,
  company-level).
* **One observation per eligible, company-associated page entrance**,
  including cache hits; cache hits make no paid call. An entrance is not a
  visitor, a person or a session. A fingerprint is not a person or a company.
* **No company data goes back to the website** (owner decision D2). The
  website call is for identification only.
* **The prospect journey lives in Insights**, not in the resolver. Activity
  after outreach is a temporal association, not proof of causation.

## Owner decisions (Gate 1, 3 Nov 2026)

| | Decision |
|---|---|
| D1 | Replace fork-per-request child processes with a single-process runner, preserving deadline, concurrency, crash-containment and IP-hygiene controls, with independent review *(in progress, CHR-70)* |
| D2 | Identification only: non-blocking `POST /v1/entrances`; status/ack response with no company data *(in progress)* |
| D3 | Observation retention in the resolver is a **configurable, bounded synchronisation buffer**. There is no fixed long default without a documented operational and privacy justification. The client Insights environment owns commercial-history retention. |
| D4 | **No browser-to-company matching in V1**, not even flagged-off code. The optional collector records approved, consent-gated semantic events only. |
| D5 | Server adapter and collector are published to public npm under an owner-controlled scope |
| D6 | V0.1 migrations are squashed into one V1 baseline, with a schema-equivalence test *(in progress)* |
| D7 | Isolated Railway development project, mock provider only |
| D8 | Public-repository hygiene verified by evidence (see [PUBLIC_REPO_SECURITY.md](PUBLIC_REPO_SECURITY.md)) |
| D9 | The separate Signals Gateway work is out of scope |

## Interfaces

**Website → resolver** *(in progress)*: `POST /v1/entrances`
`{contract:"entrance.v1", website_id, ip, entrance_id, occurred_at, page_key, acquisition, eligibility}`
→ `{version, status, source, recorded}`.

* `page_key` is the normalised path only (no query string or fragment).
* `acquisition` is a closed enum derived on the website server; raw referrer and UTM values are never sent.
* `entrance_id` is the idempotency key.
* The inherited V0.1 `POST /v1/resolve` remains until it is replaced.

**Insights → resolver** (read-only, separate credential):
* existing: `GET /v1/reporting/companies`, `/companies/:id`, `/summary`
* *(in progress, CHR-71)*: `GET /v1/reporting/observations?after=<cursor>`, a scope-wide feed with commit-safe ordering and company-erasure tombstones. Its correctness must be demonstrated under out-of-order commits, retries, duplicate delivery, pagination, tombstones and interruption recovery before it is relied on.

**Browser collector → website** *(Gate 4)*: first-party route on the website;
consent-gated closed event vocabulary; no IP forwarded and no company
association.

## Operations

* **Migrations never run on application start.** Railway runs
  `node dist/db/migrate.js` as the `preDeployCommand` (advisory-locked,
  forward-only); a failed migration fails the deployment.
* **Paid enrichment is off unless** `PROVIDER_MODE=live` and
  `ENRICHMENT_ENABLED=true`.
* **Spend controls:** an atomic period cap and a runtime kill switch
  (`ops:kill-switch`).
* **Extension seam for V2:** licensed IP intelligence would be added as a
  `ProviderAdapter` (`src/contracts/provider.ts`) between the cache and the
  paid provider. Nothing for V2 is implemented in V1.
