import type { ApplyPageArgs, ApplyPageResult, LocalCounts, RecordGapArgs, RecordGapResult, RecordStatusArgs, Store, SyncState } from "./types.ts";

export class StoreError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface PostgrestStoreOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  installationId: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new StoreError("bad_rpc_response");
  return v as Record<string, unknown>;
}
function int(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new StoreError("bad_rpc_response");
  return v;
}

/**
 * Store over Supabase PostgREST RPC using plain fetch (no supabase-js).
 * Calls the SQL functions from sql/0001_idr_projection.sql with the
 * service_role key. Error messages never include response bodies.
 */
export class PostgrestStore implements Store {
  constructor(private readonly o: PostgrestStoreOptions) {}

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 20_000);
    try {
      const res = await this.o.fetch(`${this.o.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: this.o.serviceRoleKey,
          authorization: `Bearer ${this.o.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        redirect: "manual",
        signal: ac.signal,
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw new StoreError(`rpc_${fn}_http_${res.status}`);
      }
      return (await res.json()) as unknown;
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError(`rpc_${fn}_failed`);
    } finally {
      clearTimeout(timer);
    }
  }

  async getState(): Promise<SyncState> {
    const r = obj(await this.rpc("idr_get_sync_state", { p_installation_id: this.o.installationId }));
    const cursor = r["cursor"];
    if (cursor !== null && typeof cursor !== "string") throw new StoreError("bad_rpc_response");
    const resetFrom = r["reset_from_cursor"] ?? null;
    if (resetFrom !== null && typeof resetFrom !== "string") throw new StoreError("bad_rpc_response");
    const version = r["schema_version"];
    return {
      schemaVersion: typeof version === "number" && Number.isSafeInteger(version) ? version : null,
      cursor: cursor ?? null,
      needsResync: r["needs_resync"] === true,
      gapOpen: r["gap_open"] === true,
      resetFromCursor: resetFrom,
    };
  }

  async applyPage(a: ApplyPageArgs): Promise<ApplyPageResult> {
    const r = obj(
      await this.rpc("idr_apply_feed_page", {
        p_installation_id: this.o.installationId,
        p_expected_cursor: a.expectedCursor,
        p_next_cursor: a.nextCursor,
        p_items: a.items,
        p_expected_reset_from: a.expectedResetFrom,
      }),
    );
    if (r["applied"] !== true) return { applied: false, observations: 0, tombstones: 0 };
    return { applied: true, observations: int(r["observations"]), tombstones: int(r["tombstones"]) };
  }

  async resetCursor(expectedCursor: string): Promise<boolean> {
    const r = obj(await this.rpc("idr_reset_cursor", { p_installation_id: this.o.installationId, p_expected_cursor: expectedCursor }));
    return r["applied"] === true;
  }

  async recordStatus(a: RecordStatusArgs): Promise<void> {
    await this.rpc("idr_record_sync_status", {
      p_installation_id: this.o.installationId,
      p_status: a.status,
      p_needs_resync: a.needsResync,
    });
  }

  async recordGap(a: RecordGapArgs): Promise<RecordGapResult> {
    const r = obj(
      await this.rpc("idr_record_sync_gap", { p_installation_id: this.o.installationId, p_kind: a.kind, p_expected_cursor: a.expectedCursor }),
    );
    if (typeof r["recorded"] !== "boolean" || typeof r["new"] !== "boolean" || typeof r["superseded"] !== "boolean") throw new StoreError("bad_rpc_response");
    return { recorded: r["recorded"], newGap: r["new"], superseded: r["superseded"] };
  }

  async resolveGaps(drainedCursor: string): Promise<number> {
    const r = obj(await this.rpc("idr_resolve_sync_gaps", { p_installation_id: this.o.installationId, p_drained_cursor: drainedCursor }));
    return int(r["resolved"]);
  }

  async localCounts(fromDay: string, toDay: string): Promise<LocalCounts> {
    const r = obj(await this.rpc("idr_reconcile_counts", { p_installation_id: this.o.installationId, p_from: fromDay, p_to: toDay }));
    return { observations: int(r["observations"]), observedCompanies: int(r["observed_companies"]) };
  }
}
