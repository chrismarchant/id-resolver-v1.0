/**
 * Bounded draining for the periodic maintenance deletes (CHR-66 F1).
 *
 * Runs one bounded batch after another until a batch comes back short (fewer
 * rows than the batch size: nothing more is due, as of that statement), the
 * time budget is spent, `maxBatches` non-empty batches have run, or the
 * signal is aborted (shutdown). Each batch is its own statement, so a stop
 * between batches leaves no work half-done.
 *
 * `backlog` is true when the loop stopped for any reason other than a short
 * batch: rows that are already due may remain and the next run continues.
 */
export interface DrainOptions {
  /** Rows per batch. */
  batch: number;
  /** Stop after this many non-empty batches. Default: unbounded. */
  maxBatches?: number;
  /** Stop before starting a batch at or after this instant (ms on `now`'s clock). Default: no time bound. */
  deadlineAtMs?: number;
  /** Clock for `deadlineAtMs`. Default Date.now. */
  now?: () => number;
  /** Stop before the next batch once aborted. */
  signal?: AbortSignal;
}

export interface DrainResult {
  /** Rows deleted across all batches. */
  deleted: number;
  /** Batches that deleted at least one row. */
  batches: number;
  /** True when rows may still be due: the loop stopped before a short batch. */
  backlog: boolean;
}

export async function drainBatches(step: (limit: number) => Promise<number>, opts: DrainOptions): Promise<DrainResult> {
  const maxBatches = opts.maxBatches ?? Number.MAX_SAFE_INTEGER;
  const now = opts.now ?? Date.now;
  let deleted = 0;
  let batches = 0;
  for (;;) {
    if (batches >= maxBatches || opts.signal?.aborted === true || (opts.deadlineAtMs !== undefined && now() >= opts.deadlineAtMs)) {
      return { deleted, batches, backlog: true };
    }
    const n = await step(opts.batch);
    if (n > 0) {
      deleted += n;
      batches += 1;
    }
    if (n < opts.batch) return { deleted, batches, backlog: false };
  }
}
