import { PROJECTION_SCHEMA_VERSION } from "../../src/core/index.ts";
import type { ApplyPageArgs, ApplyPageResult, GapKind, LocalCounts, RecordGapArgs, RecordGapResult, RecordStatusArgs, Store, SyncState } from "../../src/core/index.ts";

export interface MemoryGap {
  id: number;
  kind: GapKind;
  detectedAt: number;
  detectedGeneration: number;
  expiredCursor: string | null;
  resolvedAt: number | null;
  resolution: "full_resync" | null;
}

/**
 * In-memory Store with the semantics of sql/0001_idr_projection.sql: cursor
 * compare-and-set, needs_resync, reset_from_cursor, and an append-only gap log
 * with at most one open gap per kind, resolved only for gaps detected before
 * the resync whose replay has drained (generations, and the drain recorded by
 * the final page), while no new resync is pending. Gaps are never removed.
 */
export class MemoryStore implements Store {
  cursor: string | null = null;
  resetFromCursor: string | null = null;
  resetFromGeneration: number | null = null;
  needsResync = false;
  status = "never_run";
  resyncRequestedAt: number | null = null;
  resyncGeneration = 0;
  replayGeneration = 0;
  /** replayGeneration when that replay's final page was applied (null: none yet). */
  drainedGeneration: number | null = null;
  readonly observations = new Map<string, unknown>();
  readonly statuses: string[] = [];
  readonly gaps: MemoryGap[] = [];
  resets = 0;
  private tick = 0;
  /** Monotonic logical clock (the SQL uses now()). */
  private now(): number {
    return ++this.tick;
  }

  async getState(): Promise<SyncState> {
    return { schemaVersion: PROJECTION_SCHEMA_VERSION, cursor: this.cursor, needsResync: this.needsResync, gapOpen: this.gaps.some((g) => g.resolvedAt === null), resetFromCursor: this.resetFromCursor };
  }
  async applyPage(a: ApplyPageArgs): Promise<ApplyPageResult> {
    if (a.expectedCursor !== this.cursor || a.expectedResetFrom !== this.resetFromCursor) return { applied: false, observations: 0, tombstones: 0 };
    this.resetFromCursor = null;
    this.resetFromGeneration = null;
    if (a.expectedCursor === null) this.replayGeneration = this.resyncGeneration;
    if (a.drained) this.drainedGeneration = this.replayGeneration;
    let n = 0;
    for (const it of a.items) {
      if (it.type === "observation" && !this.observations.has(it.observation_id)) {
        this.observations.set(it.observation_id, it);
        n += 1;
      }
    }
    this.cursor = a.nextCursor;
    return { applied: true, observations: n, tombstones: 0 };
  }
  async recordStatus(a: RecordStatusArgs): Promise<void> {
    this.status = a.status;
    this.statuses.push(a.status);
    if (a.needsResync === true) this.needsResync = true;
  }
  async localCounts(): Promise<LocalCounts> {
    return { observations: this.observations.size, observedCompanies: 0 };
  }
  async resetCursor(expected: string): Promise<boolean> {
    if (this.cursor !== expected || this.needsResync) return false;
    this.cursor = null;
    this.resetFromCursor = expected;
    this.resetFromGeneration = this.resyncGeneration;
    this.resets += 1;
    return true;
  }
  async recordGap({ kind, expectedCursor }: RecordGapArgs): Promise<RecordGapResult> {
    if ((this.cursor ?? this.resetFromCursor) !== expectedCursor) return { recorded: false, newGap: false, superseded: true, needsResync: false };
    const detected = this.cursor === null && this.resetFromCursor !== null ? (this.resetFromGeneration ?? this.resyncGeneration) : this.resyncGeneration;
    const halt = this.needsResync || detected >= this.resyncGeneration;
    this.resetFromCursor = null;
    this.resetFromGeneration = null;
    if (halt) {
      this.status = "needs_resync";
      this.statuses.push("needs_resync");
      this.needsResync = true;
    }
    if (this.gaps.some((g) => g.kind === kind && g.resolvedAt === null)) return { recorded: true, newGap: false, superseded: false, needsResync: halt };
    this.gaps.push({ id: this.gaps.length + 1, kind, detectedAt: this.now(), detectedGeneration: detected, expiredCursor: expectedCursor, resolvedAt: null, resolution: null });
    return { recorded: true, newGap: true, superseded: false, needsResync: halt };
  }
  async resolveGaps(drainedCursor: string): Promise<number> {
    if (this.needsResync || this.cursor !== drainedCursor || this.drainedGeneration !== this.replayGeneration) return 0;
    let n = 0;
    for (const g of this.gaps) {
      if (g.resolvedAt === null && g.detectedGeneration < this.replayGeneration) {
        g.resolvedAt = this.now();
        g.resolution = "full_resync";
        n += 1;
      }
    }
    return n;
  }
  /** The operator action (idr_begin_resync): records a missing gap first, like the SQL. */
  beginResync(): void {
    if (this.needsResync && !this.gaps.some((g) => g.resolvedAt === null)) {
      this.gaps.push({
        id: this.gaps.length + 1,
        kind: "cursor_expired",
        detectedAt: this.now(),
        detectedGeneration: this.resyncGeneration,
        expiredCursor: this.cursor ?? this.resetFromCursor,
        resolvedAt: null,
        resolution: null,
      });
    }
    if (this.needsResync) {
      this.resetFromCursor = null;
      this.resetFromGeneration = null;
    } else if (this.cursor !== null) {
      // A voluntary resync keeps the old position for the next run's re-check.
      this.resetFromCursor = this.cursor;
      this.resetFromGeneration = this.resyncGeneration;
    }
    this.cursor = null;
    this.needsResync = false;
    this.status = "resync_requested";
    this.resyncGeneration += 1;
    this.resyncRequestedAt = this.now();
  }
}
