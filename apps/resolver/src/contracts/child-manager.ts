/**
 * Supervisor-side child lifecycle contract. Implemented in
 * src/supervisor/child-manager.ts; the API layer only depends on this.
 */
import type { ChildOutcome } from "./ipc.js";

export interface ChildJobRequest {
  /** Raw IP string as validated by the API layer (length-bounded, literal only). */
  ip: string;
  /** Safe correlation id for logs (already validated); never the IP. */
  requestId?: string;
  /** Absolute wall-clock deadline in ms since epoch. */
  deadlineAtMs: number;
  /** Opaque observation reference (validated by the API layer or generated there); never the IP. */
  observationRef: string;
}

export class ChildManagerOverloadedError extends Error {
  constructor() {
    super("child manager at capacity");
    this.name = "ChildManagerOverloadedError";
  }
}

export class ChildManagerStoppedError extends Error {
  constructor() {
    super("child manager is shutting down");
    this.name = "ChildManagerStoppedError";
  }
}

export interface ChildManager {
  /** Children currently alive (spawned and not yet reaped). */
  activeCount(): number;
  /** Configured bound. */
  capacity(): number;
  /**
   * Run exactly one job in a fresh child. Rejects synchronously-in-spirit with
   * ChildManagerOverloadedError when at capacity, or ChildManagerStoppedError
   * after shutdown began. Otherwise ALWAYS resolves: child crash, timeout,
   * malformed reply and spawn failure all resolve to
   * `{ status: "unavailable", company: null, source: "none", reason }`.
   * The child is guaranteed to be terminated and reaped before resolution.
   */
  run(job: ChildJobRequest): Promise<ChildOutcome>;
  /** Stop accepting jobs, wait up to graceMs for active children, then SIGKILL and reap the rest. */
  shutdown(graceMs: number): Promise<void>;
}
