# Contract `reporting-feed.v1` — resolver → client Insights (pull)

Status: **frozen interface for Gate 3; correctness to be proven (CHR-71)**.
The consumer is a client-owned Supabase Edge Function (reference adapter in
`integrations/supabase-edge`). The resolver never pushes and holds no client
credentials.

`GET /v1/reporting/observations?after=<cursor>&limit=<1..500>` ·
`Authorization: Bearer <REPORTING_AUTH_TOKEN>` (the read-only reporting
credential; the website token is rejected). `limit` defaults to 200. Omit
`after` to start from the beginning of the retained buffer.

## Response `200`

```json
{
  "version": "1",
  "contract": "reporting-feed.v1",
  "scope": { "installation_id": "…", "website_id": "…" },
  "items": [
    { "type": "observation", "observation_id": "1042", "company_id": 7,
      "domain": "example.com", "organisation_name": "Example Ltd",
      "observed_at": "2026-11-03T12:00:00.000Z", "method": "cache",
      "page_key": "/pricing", "acquisition": "search", "entrance_contract": "entrance.v1" },
    { "type": "company_erased", "tombstone_id": "3", "company_id": 7,
      "erased_at": "2026-11-03T12:05:00.000Z" }
  ],
  "next_cursor": "<opaque>",
  "has_more": false
}
```

* Ids are decimal **strings** (64-bit safe).
* `page_key`, `acquisition` and `entrance_contract` may be `null` for
  observations recorded through an older contract.
* No IP, fingerprint, provider payload, header or person data appears in any
  item.

## Ordering and cursor semantics (the guarantees CHR-71 must prove)

1. Items form **one totally ordered stream** of observations and tombstones,
   keyed by the writing transaction's `xid8` and then a stable tiebreaker.
2. The feed serves only items written by transactions that are **finished**
   (below the current snapshot `xmin`). A transaction that commits late is
   therefore never skipped by a consumer's cursor. An open transaction holds
   the feed back; this is bounded by `statement_timeout`.
3. `next_cursor` is opaque, integrity-protected (a tampered cursor gives
   `400 invalid_request`) and always present: with no new items it encodes
   the same position.
4. Re-requesting the same cursor returns the same items in the same order,
   plus possibly more at the end. **Exception:** observations of a company
   erased in the meantime may be absent; the `company_erased` tombstone always
   follows them in the stream.
5. Delivery is **at least once**. Consumers must apply idempotently, keyed by
   `(installation_id, observation_id)` and `(installation_id, tombstone_id)`,
   and must persist `next_cursor` only after the page is applied (atomically
   with it where possible).
6. A cursor older than the resolver's retention buffer gives `410` with
   `{ "version": "1", "error": "cursor_expired" }`. The consumer has missed
   data and must alert and resynchronise from the start of the buffer. It
   must never silently skip.

## Retention (owner decision D3)

The resolver keeps observations only as a **configurable, bounded
synchronisation buffer**. Retention pruning is **not** an erasure and
produces **no** tombstones: the client Insights environment owns
commercial-history retention. Only an explicit company erasure
(`ops:erase-company`) produces a `company_erased` tombstone.

## Reconciliation

`GET /v1/reporting/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` (existing) returns
per-range counts. A consumer compares them with its projection for the same
UTC days inside the retained window.
