# Retention in the resolver (owner decision D3)

> **Status: operational justification. Not legal advice. Pending owner/legal
> confirmation (CHR-59).** No legal review has been performed. This document
> explains how retention works and how to choose its one setting on
> operational grounds. Whether a value, or this design, meets any legal
> obligation is for counsel to decide: see
> [LEGAL_REVIEW_REQUIREMENTS.md](LEGAL_REVIEW_REQUIREMENTS.md).

## 1. Purpose: a bounded synchronisation buffer

The resolver is **not a system of record**. It keeps company observations
(one per eligible page entrance attributed to a company) and browser events
only long enough for the client's Insights environment to pull them:

* the Insights side (the client's Supabase projection, pulled through
  `reporting-feed.v1`) **owns commercial history** and its retention;
* the resolver's copy is a **buffer** that lets the consumer catch up after an
  outage. It does not need to be longer than that.

Owner decision D3 (3 Nov 2026) fixes the shape: retention is configurable and
bounded, and there is no fixed long default without a documented operational
and privacy justification. This document is that justification for the
operational side. The privacy side is not settled until the owner and counsel
confirm it.

## 2. The setting

`OBSERVATION_RETENTION_DAYS` (resolver environment):

* **required**: there is no default, and the service refuses to start without
  it (the error names the variable, never a value);
* **whole days, 1 to 365**: anything else is refused at startup;
* one value for both kinds of row:
  * `company_observations`: rows whose `observed_at` (resolver clock) is older
    than the window;
  * `browser_events`: rows whose `received_at` (resolver clock) is older than
    the window.

Nothing else in the resolver uses it. The fingerprint cache has its own TTLs
(section 5).

## 3. Choosing a value

### The lower bound: the consumer's longest outage, plus a margin

Observations older than the window are pruned **whether or not Insights has
pulled them**. A consumer whose position falls behind the buffer gets
`410 cursor_expired`. The reference adapter then records a continuity gap,
alerts, and needs a resync, and the pruned observations are lost for good.
So the window must be longer than the longest time the consumer can
realistically stop pulling:

```
OBSERVATION_RETENTION_DAYS >= longest expected sync outage
                              + time to notice it (alerting)
                              + time to fix it (people, access, a redeploy)
                              + a safety margin
```

Typical causes of a sync outage: the Supabase project paused or unreachable,
a rotated reporting token not yet set on the function (`auth_failed`), a
`needs_resync` nobody has handled, the cron job unscheduled by mistake, or a
resolver outage. Each of these is loud in the reference adapter (status,
HTTP code, `idr_sync_gaps`; see `integrations/supabase-edge/SETUP.md`), but
only if someone watches.

### The upper bound: what is exposed, and what must be handled

Each extra day in the window keeps one more day of entrance history in the
resolver:

* per company: which normalised pages (`page_key`) were entered, when, and how
  the visitor arrived (`acquisition`), for every day retained;
* if the resolver database is compromised, that is what is exposed, on top of
  what is never pruned (section 4);
* every request about that data (access, erasure) has more to cover.

Shorter is better for privacy. Longer is safer for sync. The value should be
the smallest one that the lower bound allows.

### Recommended range: 7 to 14 days

**Recommendation, pending owner confirmation: 7 to 14 days.**

* **7 days** where sync alerts are watched every working day: a sync that
  breaks on a Friday evening is noticed on Monday and fixed within a working
  day, with several days of margin.
* **14 days** where nobody is on call: it covers a week away plus the time to
  get access and redeploy.
* **More than 30 days** only with a written reason for that deployment (for
  example a consumer that knowingly pulls in rare batches). The setting
  allows up to 365 days, but nothing in this design needs it.
* **Fewer than 3 days** risks a silent weekend outage becoming a gap.

The function itself runs every few minutes (`schedule.example.sql` uses five)
and catches up in pages of up to 500, so the window is about outages, not
throughput.

This is an operational judgement, not a legal one: no retention period has
been confirmed as adequate or required by counsel (CHR-59).

## 4. What pruning does, and what it does not do

### Does

* Deletes due rows in bounded batches: the maintenance run at startup and
  every `CACHE_PRUNE_INTERVAL_S` (default 600 s), or `npm run ops:prune` by
  hand. Each batch is one statement, so a stop between batches leaves nothing
  half-done.
* Advances the feed's **retention watermark** in the same statement as each
  observation batch (migration 0006), so a consumer behind it gets `410`
  rather than silently missing rows.
* Deletes browser events with the same window. This never moves the
  watermark and never writes a tombstone.

### Does not

* **It is not erasure, and writes no tombstones.** Consumers keep their copies:
  the Insights projection keeps every observation it has pulled, under the
  client's own retention.
* **It does not touch rows that are kept for as long as the company row
  exists** (until a company erasure, section 6):
  * `companies`: domain, organisation name, first and last seen;
  * `company_scope_stats`: per website, first and last observed time, the
    count, and the reference (entrance id) of the first observation;
  * `company_observation_refs`: one row per recorded entrance (the random
    entrance id, the company id, its time and the "previously seen" answer).
    It is the durable de-duplication record that stops a replayed entrance id
    from ever recording twice.
* It does not prune `feed_tombstones` (company id and erasure time, kept so a
  late consumer still learns of the erasure), `feed_retention_watermarks`,
  `usage_periods` (aggregate counts per period) or `deployment_controls`.
* It does not touch logs (section 7), the hosting provider's backups or
  point-in-time recovery (their retention is the provider's and is not
  configured or verified here), or the client's Supabase projection.

**Open item for the owner:** `company_observation_refs` grows with every
recorded entrance and is never pruned by this setting. It holds no IP,
fingerprint, page or person field, but it is a per-entrance timeline per
company. Whether to bound it too (for example by pruning references older
than the replay window an entrance id can arrive in) is not decided.

## 5. The fingerprint cache (separate TTLs)

`ip_resolution_cache` holds an HMAC-SHA-256 fingerprint of the
(installation, website, canonical IP) triple, the lookup outcome, the
company it resolved to, if any, and timestamps. It never holds the IP. Each
row expires by outcome (`TTL_QUALIFIED_S`, default 7 days, at most 90;
`TTL_NO_MATCH_S` and `TTL_UNKNOWN_S`, default 1 day, at most 30;
`TTL_EXCLUDED_S`, default 7 days, at most 90; shorter for errors), and the
maintenance run deletes expired rows within half of each run's budget. The
TTL decides how long one visitor's network can be recognised without a new
paid lookup. Its privacy assessment is part of the legal review.

## 6. Erasure

* **A company:** `npm run ops:erase-company -- --company-id <id>` (or
  `-- --domain <domain>`) deletes, in
  one transaction, the company's observations, de-duplication references,
  scope statistics, the cache rows linked to it and the company row. It
  writes one `company_erased` tombstone per website scope. The Insights
  adapter applies the tombstone: the company and its observations leave the
  projection, and only `idr_tombstones` (company id, erasure time) remains.
  The next qualified resolution of the same domain creates a **new** company
  id; add the domain to `DENIED_DOMAINS` first to prevent that.
* **Browser events** have no company or person link (owner decision D4), so a
  company erasure does not touch them, and there is no key to erase one
  visitor's events by. They leave with the retention window.
* **Not covered by erasure:** log lines that name a company id (section 7),
  and the hosting provider's backups.
* **People:** the resolver stores no person identifier by design, so it has no
  per-person erasure tool. Whether some company-level rows are personal data
  in context (for example a sole trader's domain) is a question for counsel.

## 7. Logs

The resolver's logs are allowlisted: a fixed event name and scalar fields
only, never an IP, domain, `page_key`, body or header; a final redaction pass
replaces anything that looks like an IP or bearer token. They do include
numeric `company_id`s (for example `activity_recorded`), installation and
website ids, and counts. Their retention is the hosting platform's log
retention, which this repository does not configure. The Supabase function
logs status and counts only.

## 8. Monitoring

* **Resolver:** `maintenance_run{cache_rows, observation_rows, event_rows,
  backlog}` after every run; alert on repeated
  `maintenance_backlog{reason, category}`, which means rows are due faster
  than they are pruned (raise `CACHE_PRUNE_BATCH` or `CACHE_PRUNE_BUDGET_MS`).
* **Consumer lag, before it becomes a gap:** alert when the projection has
  not applied a page for a large part of the window, for example
  `select installation_id from public.idr_sync_state where last_applied_at < now() - interval '<half the window> days';`
  (a quiet site legitimately applies few pages, so use the function's
  `last_run_at` and status as well).
* **Gaps:** alert on any row in `idr_sync_gaps`, keep alerting while one is
  unresolved, and alert on status `needs_resync` and HTTP `409` from the
  function (`integrations/supabase-edge/SETUP.md`, "Monitoring").

## 9. Open before production

* Owner confirmation of the value per deployment, and of the recommended
  range (CHR-59).
* Counsel's view on the retention period, the never-pruned tables (section 4)
  and the cache TTLs (section 5): see
  [LEGAL_REVIEW_REQUIREMENTS.md](LEGAL_REVIEW_REQUIREMENTS.md).
* Backups and log retention of the hosting providers: to be set and
  documented per deployment.
