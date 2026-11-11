# Legal review requirements: every field the system stores or processes

> **No legal review has been performed. Nothing here is legal advice. Live
> client use is blocked until counsel signs off (CHR-59).**
>
> This is a technical inventory written by the engineering side, to give
> counsel the facts and the questions. Where it says what the code does, that
> is checked against this repository. Where it says what a law requires, or
> whether something is personal data, it is deliberately left as a question.

## 1. The data flow and the parties

```
Visitor's browser
  │  (1) page request: the network address (IP) reaches the website's host/CDN as for any web page
  │  (2) optional: browser events (@id-resolver/collector), same-origin, consent-gated
  ▼
Client website (TanStack Start), hosted by the client or its host (for example Cloudflare)
  │  server adapter: picks the trusted client IP, builds an entrance (entrance.v1)
  │  collector route: checks and forwards browser events (event.v1)
  ▼ HTTPS, server-held token
Resolver (one per client, Railway: service + PostgreSQL)
  │  IP → HMAC fingerprint → cache; on a miss, IP → enrichment provider
  ├──▶ Enrichment provider (Enrich v3 `ip-to-company`, configured by ENRICH_API_BASE_URL): receives the IP
  ▼ HTTPS, read-only reporting token, pulled by the client
Client Insights (the client's Supabase project): projection of company observations
```

Parties counsel needs to place (section 4, question 6): **the agency** that
builds and operates this; **the client** (owner of the website and of the
Insights environment); **Railway** (hosts the resolver and its database);
**Supabase** (hosts Insights); **the enrichment provider**; the website's
**host/CDN**; and the **visitor**.

## 2. Inventory

Columns: **purpose**; **where stored** (or "transient"); **retention**; **who
can access**; **identifiability considerations** (facts and open questions,
not conclusions).

Access shorthands used below:

* *resolver DB access*: the Railway project's members and anyone holding the
  resolver's `DATABASE_URL`;
* *reporting token*: the read-only feed credential held by the Insights
  function;
* *Insights readers*: staff whose Supabase login carries the
  `app_metadata.idr_reader` claim, plus holders of the Supabase service-role
  key and members of the client's Supabase project (dashboard).

### 2.1 The transient IP

| field | purpose | where | retention | who can access | identifiability |
|---|---|---|---|---|---|
| `ip` (entrance.v1) | find the visitor's organisation | **transient**: website server memory, TLS to the resolver, resolver memory, and the enrichment provider on a cache miss. Never written to the resolver database or its logs (allowlisted logging plus redaction), never returned, never given to the site's delivery hook | resolver: the duration of the request. Provider: **unknown** (the provider's terms) | the website's host and server code; the resolver process; the enrichment provider | An IP address can relate to one household or person (for example a home connection or a sole trader's office). The website, its host or CDN, and the platform in front of the resolver may log addresses independently of this code (see G4-I8 in the Gate 4 review for one Cloudflare case). |

### 2.2 Entrance fields (website server → resolver, `entrance.v1`)

| field | purpose | where | retention | who can access | identifiability |
|---|---|---|---|---|---|
| `website_id`, installation id | scope: which client and site | resolver tables, logs, feed scope | as the rows they scope | resolver DB access; logs | configuration ids, not about a visitor |
| `entrance_id` | idempotency key (128-bit random per entrance) | `company_observation_refs.observation_ref`, `company_observations.observation_ref`, `company_scope_stats.first_observation_ref` | refs and stats: **until the company is erased** (not pruned by retention); observations: the retention window | resolver DB access | random, not derived from the visitor; links rows of one entrance together |
| `occurred_at` | replay window (±300 s) | not stored; the resolver stores its own `observed_at` | — | — | — |
| `page_key` | which (normalised) page was entered | `company_observations`, the feed, the Insights projection | resolver: retention window; Insights: the client's | resolver DB access; reporting token; Insights readers | The default mapper replaces identifier-like path segments (e-mail addresses, UUIDs, digit runs, tokens) but is **a heuristic, not a guarantee**: a user name or short id in a path can pass. A site can switch the default off. |
| `acquisition` | how the visitor arrived, as one of 8 classes | as `page_key` | as `page_key` | as `page_key` | derived from the referrer **host** and `utm_medium`; the raw values are never sent |
| `eligibility` | which adapter rule set admitted the request (`tsa-1`) | `company_observations` (not in the feed) | retention window | resolver DB access | a rule-set id |

### 2.3 Observation and company fields (resolver, feed, Insights)

| field | purpose | where | retention | who can access | identifiability |
|---|---|---|---|---|---|
| `company_id` | the resolved organisation | resolver tables, feed, Insights, **resolver logs** (`activity_recorded`) | resolver: until erasure; logs: platform log retention; Insights: the client's | resolver DB access; log access; reporting token; Insights readers | numeric, but joins to the domain |
| `domain`, `organisation_name` | who the organisation is | `companies`; feed; `idr_companies` | resolver: **until erasure** (not pruned by retention); Insights: the client's | resolver DB access; reporting token; Insights readers | **Key question:** a sole trader's, a partnership's or a one-person company's domain or name may identify a person. Combined with page, time and the client's CRM or outreach records, a small organisation's visit may be attributable to one individual. |
| `observed_at`, `method` (`cache`/`provider`) | when the entrance was seen, and how it was resolved | `company_observations`; feed; `idr_observations` | as above | as above | timestamps of individual entrances |
| `companies.first_seen_at`, `last_seen_at`; `company_scope_stats` (first and last observed, count, first entrance reference); `company_observation_refs` (entrance id, company, time, previously-seen flag) | de-duplication, "newly observed" | resolver | **until the company is erased**; never pruned by `OBSERVATION_RETENTION_DAYS` (docs/RETENTION.md, section 4) | resolver DB access; the reporting token: `/v1/reporting/companies` serves each company's domain, name, first and last observed time and count from these statistics, and `/v1/reporting/summary` serves totals | a per-entrance timeline per company that outlives the retention window |
| `qualification_category` (provider usage type) | qualify the result (business, not ISP or mobile) | `ip_resolution_cache` | the cache TTL | resolver DB access | category only |
| provider response | resolve the IP | transient; only domain, organisation, usage type and a credit count are kept, plus whether the ISP field names the same organisation (yes/no). The ISP name, IP range and geolocation are discarded, never stored or logged | — | the resolver process | — |
| `feed_tombstones` (company id, erasure time) | tell consumers about an erasure | resolver; `idr_tombstones` in Insights | never pruned | resolver DB access; reporting token; Insights readers | the erased company's id only, no domain or name |

### 2.4 The HMAC fingerprint cache

| field | purpose | where | retention | who can access | identifiability |
|---|---|---|---|---|---|
| `ip_fingerprint` (HMAC-SHA-256 of installation, website and canonical IP, keyed with `IP_HMAC_SECRET`), `key_version`, status, linked `company_id`, timestamps | avoid a paid lookup for a network seen recently | `ip_resolution_cache` | TTL per outcome: qualified 7 days by default (at most 90), no match 1 day (at most 30), and so on (docs/RETENTION.md, section 5) | resolver DB access; the secret is held in the resolver's environment | The code treats it as **pseudonymous, not anonymous**. Whoever holds the secret and the table can test any candidate IP, and the whole IPv4 space is small enough to enumerate. Without the secret it cannot be reversed. A row links a network to a company for the TTL. |

### 2.5 Browser events (`event.v1`, optional collector)

| field | purpose | where | retention | who can access | identifiability |
|---|---|---|---|---|---|
| `event_id` | idempotency (random per event, never stored in the browser) | `browser_events` | retention window, by `received_at` | resolver DB access | random |
| `type`, `name` | which approved semantic event (closed vocabulary `event-vocabulary.v1`) | `browser_events` | as above | as above | no values, text, form fields or link URLs are captured |
| `page_key` (from the browser's path) | which page | `browser_events` | as above | as above | same mapper as entrances; same heuristic caveat |
| `consent` (`granted`/`not_required`), `occurred_at`, `received_at`, `origin = browser` | consent record and timing | `browser_events` | as above | as above | the consent value is the site's claim, checked by the server's policy |
| what the collector reads in the browser | — | not stored: `location.pathname` (sent, as `path`); `location.href` and `location.origin`, read once at start-up only to check that the configured endpoint is same-origin, never sent or stored; `navigator.globalPrivacyControl`, `navigator.sendBeacon`; no cookies, storage, user agent, screen, referrer or fingerprinting surfaces | — | — | **Not joined to any company or person** (owner decision D4): no IP, session or visitor id is stored, so one visitor's events cannot be found or linked. |
| what the route reads | — | not stored: `Origin`, `Sec-Fetch-Site`, `Content-Type`, `Content-Length`, `Sec-GPC`; the site's own `hasConsent` hook may read its consent cookie | — | the website server | nothing read here is forwarded |

Browser events are forgeable telemetry (anyone can post plausible events to
the route, within its rate, vocabulary and consent rules; `event.v1.md`). They
are not used for any decision about a person.

### 2.6 Insights projection (client's Supabase)

`idr_companies` (domain, organisation name), `idr_observations` (observation
id, company id, `observed_at`, `method`, `page_key`, `acquisition`,
`entrance_contract`), `idr_tombstones`, `idr_sync_state` (an opaque cursor,
run status) and `idr_sync_gaps` (continuity incidents). Retention: **the
client's**, as owner of commercial history; nothing here prunes it. Access:
Insights readers only (row level security; `anon` none). Writes only through
the sync functions (`integrations/supabase-edge/SETUP.md`).

### 2.7 Logs and operational records

| record | contents | retention | who can access |
|---|---|---|---|
| resolver logs | allowlisted event names and scalar fields: installation and website ids, numeric `company_id`, statuses, counts, durations; never an IP, domain, `page_key`, body or header (redaction of anything IP- or token-like as a last line) | the hosting platform's log retention (not configured here) | Railway project members |
| Insights function logs | status and counts only | Supabase's log retention | Supabase project members |
| website adapter results (`onDeliveryResult`) | outcome and reason codes only, never the IP | whatever the site does with them | the site |
| `usage_periods` | aggregate counts per period (requests, cache hits, provider attempts) | not pruned | resolver DB access |
| `deployment_controls` | kill switch with an operator-written reason | not pruned | resolver DB access |
| backups / point-in-time recovery | copies of the resolver database | the hosting provider's, **not configured or verified** here | the provider; project members |

## 3. Technical measures already in place (for context, not as a legal assessment)

* No company data goes back to the website (D2); the website call is for
  identification only.
* No browser-to-company matching, not even switched-off code (D4).
* The IP is transient; the cache keys on an HMAC of it; logging is
  allowlisted.
* Retention is bounded and required (D3, `docs/RETENTION.md`); company
  erasure with tombstones that propagate to Insights.
* Insights access requires an explicit admin-set claim; exact database
  privileges; writes only through checked functions.
* The collector honours Global Privacy Control and has a server-enforced
  consent mode (`required` by default).

## 4. Questions counsel must answer

1. **Lawful basis** for each step: looking up a visitor's IP to identify an
   organisation; sending the IP to the enrichment provider; storing company
   observations in the resolver; the client's use of them in Insights and in
   sales outreach; and the optional browser events.
2. **Consent requirements, per jurisdiction where the client's visitors
   are**: whether the server-side IP lookup needs consent or another basis;
   whether the collector needs consent in each jurisdiction (and whether the
   `not_required` mode may ever be used, and where); how Global Privacy
   Control and other opt-out signals must be honoured.
3. **Is company-level data personal data in context?** In particular sole
   traders, partnerships, one-person companies, personal domains and
   organisation names that are a person's name; and the combination of
   company, page, time and the client's CRM records. If yes, for which rows,
   and what follows for everything below.
4. **Retention**: is the D3 window acceptable, and is a specific maximum
   needed; the tables kept until erasure (`companies`,
   `company_scope_stats`, `company_observation_refs`, `feed_tombstones`);
   the cache TTLs; logs; backups; and the client's own retention in Insights.
5. **Data-subject rights**: how to answer access, erasure and objection
   requests when no person identifier is stored. Should a visitor be able to
   ask by IP (the fingerprint could be recomputed to find cache rows), and
   is company erasure (`ops:erase-company`) the right tool for a request
   about a company?
6. **Roles**: who is controller and who is processor (or joint controller)
   between the agency, the client, Railway, Supabase, the enrichment
   provider and the website's host; which data processing agreements are
   needed.
7. **International transfers**: where the resolver (Railway region), Insights
   (Supabase region) and the enrichment provider process data, and what
   transfer mechanism each needs.
8. **Cookie consent and the collector**: the collector sets no cookie and
   uses no storage, but it runs in the visitor's browser and sends events.
   Does that fall under the same consent rules as cookies (for example
   ePrivacy or PECR style rules) in each jurisdiction? How must it interact
   with the site's consent platform? Is the route's server-side check
   (`hasConsent`) sufficient evidence of consent?
9. **DPIA**: is a data protection impact assessment required (systematic
   identification of visiting organisations for sales outreach, a new
   technology, scale)? If so, before which gate.
10. **Transparency**: what the website's privacy notice must say about the IP
    lookup, the enrichment provider and Insights, and what the client must
    tell its staff who use Insights (an entrance is not a person or a
    session; post-outreach activity is association, not causation).
11. **The enrichment provider**: is its use and retention of submitted IPs
    acceptable, and what must the contract with it say?

## 5. Sign-off

| item | status |
|---|---|
| Legal review of this inventory and the questions above | **not started** |
| Owner confirmation of retention values (docs/RETENTION.md) | **open** (CHR-59) |
| Live client use | **blocked until counsel signs off (CHR-59)** |

No legal review has been performed. Nothing here is legal advice.
