# Contract `reporting-feed.v1` — resolver → client Insights (pull)

Status: **frozen interface for Gate 3; implemented with a proof suite
(CHR-71, `apps/resolver/test/integration/feed-*.test.ts`), pending independent
review (CHR-66)**. The sections after "Reconciliation" are implementation
clarifications; they do not change the frozen interface above them, except
where an **owner clarification** says so explicitly (guarantees 3 and 6:
"Owner clarification (3 Nov 2026, CHR-66 N1) of guarantee 3" below).
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
   the same position. *Refined by the owner clarification of 3 Nov 2026
   (CHR-66 N1, below): a structurally valid cursor whose tag does not verify
   and that claims a position strictly before the retention watermark gets
   `410 cursor_expired`.*
4. Re-requesting the same cursor returns the same items in the same order,
   plus possibly more at the end. **Exception:** observations of a company
   erased in the meantime may be absent; the `company_erased` tombstone always
   follows them in the stream.
5. Delivery is **at least once**. Consumers must apply idempotently, keyed by
   `(installation_id, observation_id)` and `(installation_id, tombstone_id)`,
   and must persist `next_cursor` only after the page is applied (atomically
   with it where possible).
6. A cursor older than the resolver's retention buffer gives `410` with
   `{ "version": "1", "error": "cursor_expired" }` and no items. *(Wording
   clarified by the owner, 3 Nov 2026, CHR-66 N1:)* this signals a
   **potential synchronisation continuity gap**, never a recovery. The
   consumer must record the gap durably, alert, and resynchronise from the
   start of the buffer; the resynchronisation rebuilds the projection from
   what is still retained and does not recover items pruned before it. It
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
  rotating that secret invalidates every outstanding cursor: its tag no longer
  verifies.
* **Owner clarification (3 Nov 2026, CHR-66 N1) of guarantee 3.** A
  structurally valid cursor that claims a position strictly before the
  retention watermark receives `410 cursor_expired` even when its integrity
  tag cannot be verified. A failed signature does not establish that the
  cursor was ever authentic, and such a cursor cannot be told apart from one
  signed with a rotated key. Malformed cursors, and cursors with an invalid
  tag whose claimed position is within retention, still receive `400
  invalid_request`. This error path returns no items. The claimed position is
  only compared in memory with the scope's watermark; it never parameterises a
  database query and triggers no other processing. A 410 signals a
  **potential synchronisation continuity gap**, never a successful recovery.
  The consumer must record it durably and alert, even if it later performs a
  full resynchronisation (the reference adapter records it in
  `idr_sync_gaps`). A separate cursor-signing secret with a key ring is
  deferred beyond V1.

  Precise behaviour for a cursor whose tag does not verify:
  * structurally valid (46 canonical base64url characters, known format,
    valid kind and id) and the claimed position lies **strictly before** the
    scope's retention watermark: `410` with exactly
    `{ "version": "1", "error": "cursor_expired" }`, which is what the same
    cursor received before a rotation of `IP_HMAC_SECRET`;
  * structurally valid and claiming a position at or after the watermark, or
    the scope has no watermark yet: `400 invalid_request`;
  * malformed: `400 invalid_request`, with no database access at all;
  * the watermark cannot be read: `500 internal`, never a `400`.

  The only database access on this path is the read of the scope's
  watermark, parameterised by the server-configured scope alone; the feed
  query is never run. A consumer that receives `400` to a request **that
  carried a cursor** must automatically restart from the start of the buffer
  (reset its stored cursor, using the same compare-and-set as any cursor
  change, and request without `after`). That replay is safe: the resolver has
  pruned nothing after the cursor's position (otherwise the answer would have
  been `410`), and the consumer applies idempotently. A `400` to a request
  **without** a cursor is a contract error and must not trigger a reset. The
  reference engine records the status `cursor_rejected` for a run that
  restarted after a `400`, and `needs_resync` plus an `idr_sync_gaps` row
  after a `410`.

  **Clarification (CHR-66 R2-5), consumer obligation, no wire change:** the
  `400` only proves that nothing after the rejected cursor was pruned *at
  that moment*, and a cursorless position can never receive a `410`. So the
  consumer must keep the rejected cursor until the first page of the replay
  is applied (atomically with that page), and every later attempt must first
  present it again (`after=<rejected cursor>`): a `410` then means retention
  passed it in the meantime (a potential gap: record it); a `400` means it is
  still within retention and the replay starts at once. The reference adapter
  keeps it in `idr_sync_state.reset_from_cursor`, written by
  `idr_reset_cursor` and cleared by `idr_apply_feed_page` with the first page
  from the start (or by the gap record). A failure anywhere between the reset
  and that first page therefore leaves it set and the next run checks again.

  The same obligation holds for **any** restart from the start of the buffer
  that discards a stored cursor, in particular a voluntary resynchronisation
  that no `410` asked for: the old position may already lie behind the
  watermark, and the replay never delivers, or reports, what was pruned after
  it. The consumer must present the old position first: a `410` is a
  potential continuity gap to record (the requested rebuild may then
  continue, since it was already asked for), a `400` or `200` means nothing
  after it was pruned. The reference adapter's `idr_begin_resync` keeps the
  stored cursor in `reset_from_cursor` for exactly this re-check when
  `needs_resync` is not set; when it is set, the gap is already on record and
  the old position is not re-checked.

  In short: rotating `IP_HMAC_SECRET` gives `410` to a consumer whose cursor
  is behind the retention watermark, and otherwise `400` followed by a safe
  replay. Known limit (precise, CHR-66 R3-A): the last check of the old
  position (the `400`, or the re-check) and the first page from the start
  are two requests, so a retention run that passes the position between the
  resolver's watermark read for the check and its snapshot for that page is
  not reported. The consumer must keep that interval to one request: the
  reference engine sends the first page immediately and **once** (no retry, no
  backoff; any failure ends the run with the position still kept, and the next
  run checks again), and after an in-loop `400` the only other step in between
  is the single store write that keeps the position. The interval is thus
  bounded by that write and one request, each limited by its timeout
  (`IDR_REQUEST_TIMEOUT_MS` for the request); normal retries resume only after
  the first page is applied. A second run that reads the state inside the
  interval sees the same window (R3-C): its `410` on the kept position is
  superseded once the first page has been applied, and two runs holding the
  same cursor across a prune can make the later one halt spuriously
  (conservative). Positions are not secret, so answering from the claimed
  position leaks nothing.

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
  cursor_expired` (a potential continuity gap; guarantee 6); a cursor at or
  after it continues normally. This holds for a structurally valid cursor
  whose tag does not verify as well (see "Positions and cursors").
  Omitting `after` always works and starts from the oldest retained item.
* **Addition:** tombstones are never pruned by retention, so a consumer that
  resynchronises from the start still receives every erasure.

### Immutability of served items (migration 0007)

* The database rejects (SQLSTATE `23514`) any `UPDATE` of a served
  observation column, any `UPDATE` or `DELETE` of a tombstone, a `TRUNCATE` of
  either table (including through `TRUNCATE companies CASCADE`), and any
  backward move, `DELETE` or `TRUNCATE` of a retention watermark. Items can
  leave the feed only through retention (which advances the watermark) or an
  erasure (which writes a tombstone).
* Limit: these are triggers. A table owner or superuser can still disable
  them, for example with `session_replication_role = replica`. They protect
  against application defects and unprivileged changes, not against a
  compromised owner credential. Running the service under a non-owner
  database role, distinct from the migration role, is a production hardening
  step tracked for Gate 6.

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

