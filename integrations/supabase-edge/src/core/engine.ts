import { PROJECTION_SCHEMA_VERSION, type FeedPage, type ReconcileOutcome, type SyncConfig, type SyncDeps, type SyncResult, type SyncStatus } from "./types.ts";
import { parseFeedPage, parseSummary } from "./validate.ts";

const MAX_BODY_CHARS = 8 * 1024 * 1024;
const DAY_MS = 86_400_000;

type Fetched =
  | { kind: "ok"; body: unknown }
  | { kind: "stop"; status: SyncStatus };

/** Retry-After as delay in ms (delta-seconds or HTTP-date), or null if absent/invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^[0-9]{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Complete UTC days ending yesterday: [from, to] inclusive. */
export function reconcileWindow(nowMs: number, days: number): { from: string; to: string } {
  const startOfToday = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { to: utcDay(startOfToday - DAY_MS), from: utcDay(startOfToday - days * DAY_MS) };
}

/**
 * Runs one bounded sync invocation: pull pages from the stored cursor until
 * drained, the page cap, or the time budget. The cursor only ever advances
 * through Store.applyPage (atomic compare-and-set), so a crash, a duplicate
 * invocation or a concurrent one cannot skip or double-advance it.
 *
 * 410 cursor_expired is a POTENTIAL SYNCHRONISATION CONTINUITY GAP, never a
 * recovery: observations may have been pruned by the resolver before they
 * were pulled. The engine records it durably (Store.recordGap: needs_resync
 * plus an append-only gap record, in one transaction, never duplicated while
 * open), stops, and does nothing more until an operator calls
 * idr_begin_resync(). The first run after that which drains the resolver's
 * buffer marks the gap resolved (Store.resolveGaps): the projection was
 * rebuilt from what is still retained; the pruned observations stay missing
 * and the gap record stays.
 *
 * A 400 to a stored cursor resets it, but the store keeps the rejected cursor
 * (resetFromCursor) until the first page of the replay is applied; a later
 * run re-presents it first, so retention passing it in between becomes a 410
 * and a recorded gap, never a silent loss.
 */
export async function runSync(cfg: SyncConfig, deps: SyncDeps): Promise<SyncResult> {
  const deadline = deps.now() + cfg.budgetMs;
  const result: SyncResult = { status: "ok", pages: 0, observations: 0, tombstones: 0, reconcile: null, gap: null, gapsResolved: 0 };

  async function finish(status: SyncStatus, needsResync: boolean | null = null): Promise<SyncResult> {
    result.status = status;
    try {
      await deps.store.recordStatus({ status, needsResync });
    } catch {
      // Status recording is best effort; never mask the run result.
    }
    return result;
  }

  /**
   * needs_resync: record the gap durably (idempotent while open), as a
   * compare-and-set on `expectedCursor`, the cursor that got the 410. If the
   * stored position has moved on, an overlapping run already applied pages
   * past it: nothing is written and this run ends cas_conflict (no false gap,
   * no halt). If an operator requested a resync after that position (a run
   * that overlapped a voluntary idr_begin_resync), the gap is recorded but the
   * requested replay already covers the rebuild: no halt, cas_conflict for
   * this stale run. If the record fails, still mark needs_resync and report
   * gap.recorded=false; the next run finds needs_resync set and retries.
   */
  async function finishGap(expectedCursor: string | null): Promise<SyncResult> {
    result.status = "needs_resync";
    try {
      const g = await deps.store.recordGap({ kind: "cursor_expired", expectedCursor });
      if (g.superseded) {
        result.status = "cas_conflict";
        return result; // the stale run touches nothing
      }
      result.gap = g;
      if (!g.needsResync) result.status = "cas_conflict";
    } catch {
      result.gap = { recorded: false, newGap: false, superseded: false, needsResync: true };
      try {
        await deps.store.recordStatus({ status: "needs_resync", needsResync: true });
      } catch {
        // best effort; the run result still says needs_resync
      }
    }
    return result;
  }

  async function getJson(pathAndQuery: string, allow410: boolean, carriedCursor = false): Promise<Fetched> {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}${pathAndQuery}`;
    let attempt = 0;
    for (;;) {
      const remaining = deadline - deps.now();
      if (remaining <= 0) return { kind: "stop", status: attempt === 0 ? "partial" : "upstream_error" };

      let status: number | null = null;
      let retryAfter: string | null = null;
      let text = "";
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.min(cfg.requestTimeoutMs, remaining));
      try {
        const res = await deps.fetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
          redirect: "manual",
          signal: ac.signal,
        });
        status = res.status;
        retryAfter = res.headers.get("retry-after");
        if (status === 200 || status === 410) text = (await res.text()).slice(0, MAX_BODY_CHARS);
        else await res.body?.cancel().catch(() => undefined);
      } catch {
        status = null; // network error or timeout
      } finally {
        clearTimeout(timer);
      }

      if (status === 200) {
        try {
          return { kind: "ok", body: JSON.parse(text) as unknown };
        } catch {
          return { kind: "stop", status: "contract_error" };
        }
      }
      if (status === 401 || status === 403) return { kind: "stop", status: "auth_failed" };
      if (status === 410) {
        if (allow410) {
          try {
            const b = JSON.parse(text) as { error?: unknown };
            if (b.error === "cursor_expired") return { kind: "stop", status: "needs_resync" };
          } catch {
            // fall through
          }
        }
        return { kind: "stop", status: "contract_error" };
      }
      // 400 to a request that carried a cursor: the resolver no longer accepts it
      // (its cursor key rotated). Recoverable by restarting from the buffer start:
      // a stale cursor already behind the retention watermark gets 410 instead,
      // which is a potential continuity gap (finishGap), not this reset.
      if (status === 400 && carriedCursor) return { kind: "stop", status: "cursor_rejected" };
      if (status !== null && status !== 429 && status < 500) return { kind: "stop", status: "contract_error" };

      // 429 / 5xx / network failure: bounded retry within the budget.
      const rateLimited = status === 429;
      const failStatus: SyncStatus = rateLimited ? "rate_limited" : "upstream_error";
      if (attempt >= cfg.maxRetries) return { kind: "stop", status: failStatus };
      const backoff = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempt);
      const jittered = Math.round(backoff / 2 + (deps.random() * backoff) / 2);
      const wait = rateLimited ? (parseRetryAfter(retryAfter, deps.now()) ?? jittered) : jittered;
      // Never sleep past the deadline: give up cleanly instead.
      if (wait >= deadline - deps.now()) return { kind: "stop", status: failStatus };
      await deps.sleep(wait);
      attempt++;
    }
  }

  let state;
  try {
    state = await deps.store.getState();
  } catch {
    return finish("store_error");
  }
  // Code/SQL version skew (CHR-66 R2-6): a projection without the gap
  // functions this code relies on could lose gap evidence. Refuse loudly,
  // before any fetch, and write nothing (the old schema may not even accept
  // this status).
  if (state.schemaVersion !== PROJECTION_SCHEMA_VERSION) {
    result.status = "schema_mismatch";
    return result;
  }
  // A pending resync is an operator decision; never fetch, advance or skip.
  // Re-recording is idempotent and covers a gap whose record failed earlier.
  if (state.needsResync) return finishGap(state.cursor ?? state.resetFromCursor ?? null);

  let cursor = state.cursor;
  /** What the store holds as reset_from_cursor (compare-and-set on every apply). */
  let resetFrom: string | null = state.resetFromCursor ?? null;
  let gapOpen = state.gapOpen;
  let drained = false;
  let cursorReset = false;

  // The cursor was reset to null without the replay having applied its first
  // page yet: after a 400 (rejected cursor), or by an operator's voluntary
  // idr_begin_resync. Retention may have passed that old position, and a null
  // cursor can never get a 410, so present it again first:
  //  - 410: a continuity gap, recorded (compare-and-set on reset_from_cursor).
  //    If a resync was requested after that position, the replay it asked for
  //    continues in this run and the gap resolves once it drains; otherwise
  //    halt with needs_resync.
  //  - 400 or 200: nothing after it was pruned; replay from the start now.
  // Any failure, including a failed record, leaves it set, so the next run
  // checks again.
  if (cursor === null && resetFrom !== null) {
    const check = await getJson(`/v1/reporting/observations?limit=1&after=${encodeURIComponent(resetFrom)}`, true, true);
    if (check.kind === "stop") {
      if (check.status === "needs_resync") {
        let g;
        try {
          g = await deps.store.recordGap({ kind: "cursor_expired", expectedCursor: resetFrom });
        } catch {
          return finish("store_error");
        }
        if (g.superseded) {
          result.status = "cas_conflict";
          return result;
        }
        result.gap = g;
        if (g.needsResync) {
          result.status = "needs_resync";
          return result;
        }
        resetFrom = null; // the record ended the re-check, in its transaction
        gapOpen = true;
      } else if (check.status === "cursor_rejected") {
        cursorReset = true;
      } else {
        return finish(check.status);
      }
    }
  }

  while (result.pages < cfg.maxPages) {
    if (deps.now() >= deadline) break;
    const q = `limit=${cfg.pageLimit}${cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`}`;
    const fetched = await getJson(`/v1/reporting/observations?${q}`, true, cursor !== null);
    if (fetched.kind === "stop") {
      if (fetched.status === "partial") break;
      if (fetched.status === "cursor_rejected" && cursor !== null && !cursorReset) {
        // Reset through the same compare-and-set as every other cursor change,
        // once per run, then replay from the start of the buffer (idempotent).
        let reset = false;
        try {
          reset = await deps.store.resetCursor(cursor);
        } catch {
          return finish("store_error");
        }
        if (!reset) return finish("cas_conflict");
        cursorReset = true;
        resetFrom = cursor;
        cursor = null;
        try {
          await deps.store.recordStatus({ status: "cursor_rejected", needsResync: null });
        } catch {
          // best effort
        }
        continue;
      }
      if (fetched.status === "cursor_rejected") return finish("contract_error");
      if (fetched.status === "needs_resync") return finishGap(cursor ?? resetFrom);
      return finish(fetched.status);
    }
    const page: FeedPage | null = parseFeedPage(fetched.body, cfg.installationId);
    if (page === null) return finish("contract_error");
    if (page.hasMore && page.nextCursor === cursor && page.items.length === 0) return finish("contract_error");

    let applied;
    try {
      applied = await deps.store.applyPage({ expectedCursor: cursor, expectedResetFrom: resetFrom, nextCursor: page.nextCursor, items: page.items });
    } catch {
      return finish("store_error");
    }
    // Lost the compare-and-set: another invocation advanced the cursor.
    if (!applied.applied) return finish("cas_conflict");
    cursor = page.nextCursor;
    resetFrom = null; // cleared in the same transaction as the page
    result.pages++;
    result.observations += applied.observations;
    result.tombstones += applied.tombstones;
    if (!page.hasMore) {
      drained = true;
      break;
    }
  }

  if (!drained) return finish(cursorReset ? "cursor_rejected" : "partial");

  // Drained: if a gap is open, the projection may now have been rebuilt from
  // the start of the retained buffer after idr_begin_resync(); the store
  // resolves only gaps detected before the resync whose replay this drain
  // completed, and only if no newer replay has started since (cursor CAS).
  if (gapOpen && cursor !== null) {
    try {
      result.gapsResolved = await deps.store.resolveGaps(cursor);
    } catch {
      return finish("store_error");
    }
  }

  if (cfg.reconcileDays > 0) {
    result.reconcile = await reconcile();
    if (result.reconcile.checked && result.reconcile.matched === false) return finish("reconcile_mismatch");
  }
  // A run that recovered from a rejected cursor reports it (the projection is complete).
  return finish(cursorReset ? "cursor_rejected" : "ok");

  async function reconcile(): Promise<ReconcileOutcome> {
    const w = reconcileWindow(deps.now(), cfg.reconcileDays);
    const skipped = (reason: string): ReconcileOutcome => ({ checked: false, matched: null, from: w.from, to: w.to, reason });
    const fetched = await getJson(`/v1/reporting/summary?from=${w.from}&to=${w.to}`, false);
    if (fetched.kind === "stop") return skipped(fetched.status);
    const remote = parseSummary(fetched.body, cfg.installationId);
    if (remote === null) return skipped("contract_error");
    try {
      const local = await deps.store.localCounts(w.from, w.to);
      const matched = local.observations === remote.observations && local.observedCompanies === remote.observedCompanies;
      return { checked: true, matched, from: w.from, to: w.to, reason: null };
    } catch {
      return skipped("store_error");
    }
  }
}
