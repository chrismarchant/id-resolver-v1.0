# Contract `reporting-feed.v1` — resolver → client Insights (pull)

Status: **frozen interface for Gate 3; implemented with a proof suite
(CHR-71, `apps/resolver/test/integration/feed-*.test.ts`), pending independent
review (CHR-66)**. The sections after "Reconciliation" are implementation
clarifications; they do not change the frozen interface above them.
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

## Clarifications (CHR-71 implementation)

### Positions and cursors

* A position is `(txid, kind, id)`: `txid` is the top-level `xid8` of the
  transaction that wrote the item (enforced by a database trigger for every
  insert, including inserts inside savepoints; positions are immutable),
  `kind` is 0 for an observation and 1 for a tombstone, `id` is the row's own
  id. This is the "stable tiebreaker" of guarantee 1: within one transaction,
  observations precede tombstones, each in id order.
* The feed reads in **one SQL statement** (one MVCC snapshot) and serves only
  items with `txid < pg_snapshot_xmin(pg_current_snapshot())` of that same
  snapshot. Every transaction below that horizon has finished, so no item can
  ever appear later below a position already handed out. The retention
  watermark is read in the same snapshot.
* `next_cursor` is the position of the last item returned (or the request
  position when there is none, or the start position when `after` was
  omitted). It never jumps ahead to the horizon.
* `has_more` is `true` when further finished items exist after the last
  returned item at the time of the read. `false` does not mean the stream is
  complete: poll again later.
* The cursor is 46 base64url characters: an 18-byte position and a 16-byte
  HMAC-SHA-256 tag bound to the deployment scope. The tag key is derived from
  the resolver's server-only `IP_HMAC_SECRET` with a dedicated label (the
  reporting token is not used because the consumer holds it). **Addition:**
  rotating that secret invalidates outstanding cursors (`400`); the consumer
  then resynchronises from the start of the buffer, which is safe because it
  applies idempotently.

### Erasure and re-observation

* `ops:erase-company --domain <d>` or `--company-id <n>` erases a company in
  one transaction: observations, deduplication records, scope stats, the cache
  rows that link a visitor fingerprint to it, and the company row. It writes
  one `company_erased` tombstone in **each scope** that knew the company.
  Tombstones carry no domain or name.
* Every observation of the erased company that a consumer can ever be served
  precedes its tombstone in the stream (guarantee 4); an observation committed
  concurrently with the erasure is either deleted before it can be served or
  served before the tombstone.
* **Re-observation:** company ids are never reused. If the same domain is
  resolved again after the erasure, it becomes a **new `company_id`**. Its
  observations are ordinary items and may sort **before or after** the old
  id's tombstone (a writer that obtained its transaction id before the erasure
  sorts before it). A tombstone applies only to its own `company_id`.
  Consumers must key their projection on `company_id` and must never erase by
  domain. **Recommended (addition):** persist erased company ids and ignore
  any later observation that carries one, so that even a re-applied stale page
  cannot resurrect an erased company. To stop re-identification entirely, the
  operator adds the domain to `DENIED_DOMAINS` before erasing.
* Erasure removes the deduplication records too, so replaying an erased
  `entrance_id` would be accepted as new; `entrance.v1` already rejects
  requests more than 300 s from resolver time.

### Retention watermark

* Each scope has a monotonic **retention watermark**: the highest position
  ever deleted other than by an erasure. It is advanced by a database trigger
  in the same statement as the delete, whatever the deletion path (retention,
  the inherited prune, a cascade or a manual delete), so no item can leave the
  feed silently. A cursor **strictly before** the watermark gets `410
  cursor_expired`; a cursor at or after it continues normally. Omitting
  `after` always works and starts from the oldest retained item.
* **Addition:** tombstones are never pruned by retention, so a consumer that
  resynchronises from the start still receives every erasure.

### Bounds and deployment assumptions

* The horizon is **cluster-wide**: any open transaction that holds a
  transaction id (in any database of the PostgreSQL cluster) holds the feed
  back until it ends. A resolver write transaction of `k` statements is
  bounded by `k × statement_timeout` (3 s per statement by default) plus, for
  a stalled client between statements, `(k + 1) ×
  idle_in_transaction_session_timeout`, which must therefore be set on the
  resolver's connections. Ops transactions (erasure: 30 s per statement)
  hold the feed back for their duration. Prepared (two-phase) transactions are
  not bounded and must not be used on this database.
* The feed must read from the **primary**. With `synchronous_commit = off`, a
  crash could lose a transaction that was already served; keep the default
  (`on`).

