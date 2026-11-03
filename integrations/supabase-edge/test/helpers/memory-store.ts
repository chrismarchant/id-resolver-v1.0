import type { ApplyPageArgs, ApplyPageResult, GapKind, LocalCounts, RecordGapArgs, RecordGapResult, RecordStatusArgs, Store, SyncState } from "../../src/core/index.ts";

export interface MemoryGap {
  id: number;
  kind: GapKind;
  detectedAt: number;
  expiredCursor: string | null;
  resolvedAt: number | null;
  resolution: "full_resync" | null;
}

/**
 * In-memory Store with the semantics of sql/0001_idr_projection.sql: cursor
 * compare-and-set, needs_resync, and an append-only gap log with at most one
 * open gap per kind, resolved only for gaps detected before the latest resync
 * request while no new resync is pending. Gaps are never removed.
 */
export class MemoryStore implements Store {
  cursor: string | null = null;
  resetFromCursor: string | null = null;
  needsResync = false;
  status = "never_run";
  resyncRequestedAt: number | null = null;
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
    return { cursor: this.cursor, needsResync: this.needsResync, gapOpen: this.gaps.some((g) => g.resolvedAt === null), resetFromCursor: this.resetFromCursor };
  }
  async applyPage(a: ApplyPageArgs): Promise<ApplyPageResult> {
    if (a.expectedCursor !== this.cursor || a.expectedResetFrom !== this.resetFromCursor) return { applied: false, observations: 0, tombstones: 0 };
    this.resetFromCursor = null;
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
    this.resets += 1;
    return true;
  }
  async recordGap({ kind, expectedCursor }: RecordGapArgs): Promise<RecordGapResult> {
    if ((this.cursor ?? this.resetFromCursor) !== expectedCursor) return { recorded: false, newGap: false, superseded: true };
    this.resetFromCursor = null;
    this.status = "needs_resync";
    this.statuses.push("needs_resync");
    this.needsResync = true;
    if (this.gaps.some((g) => g.kind === kind && g.resolvedAt === null)) return { recorded: true, newGap: false, superseded: false };
    this.gaps.push({ id: this.gaps.length + 1, kind, detectedAt: this.now(), expiredCursor: expectedCursor, resolvedAt: null, resolution: null });
    return { recorded: true, newGap: true, superseded: false };
  }
  async resolveGaps(): Promise<number> {
    let n = 0;
    for (const g of this.gaps) {
      if (g.resolvedAt === null && !this.needsResync && this.resyncRequestedAt !== null && g.detectedAt <= this.resyncRequestedAt) {
        g.resolvedAt = this.now();
        g.resolution = "full_resync";
        n += 1;
      }
    }
    return n;
  }
  /** The operator action (idr_begin_resync). */
  beginResync(): void {
    this.cursor = null;
    this.needsResync = false;
    this.status = "resync_requested";
    this.resyncRequestedAt = this.now();
  }
}
