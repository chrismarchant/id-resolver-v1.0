/**
 * Event-loop watchdog for the single-process runtime (CHR-70).
 *
 * Every request shares one event loop, so a loop blocked by synchronous work
 * (a pathological regular expression, a runaway loop, a native call that
 * never returns) stalls every deadline at once, and no timer on the loop can
 * fire to notice. The watchdog therefore runs on a separate thread: the main
 * loop increments a shared counter every HEARTBEAT_MS; the watchdog thread
 * checks it and, when it has not moved for longer than the threshold, writes
 * one fixed log line straight to stdout and terminates the whole process with
 * SIGKILL (exit status 137). The platform then restarts the service.
 *
 * SIGKILL, not SIGTERM: the SIGTERM handler cannot run on a blocked loop.
 * Never SIGABRT: that would write a core dump containing process memory
 * (request IPs, secrets); the entrypoint also sets `ulimit -c 0`.
 *
 * The thread is created from a constant source string (no file to resolve,
 * no user input) and is unref'd, so it never keeps the process alive.
 */
import { Worker } from "node:worker_threads";

export const HEARTBEAT_MS = 100;
/** How often the watchdog thread checks the heartbeat. */
export const CHECK_MS = 100;

const WATCHDOG_SOURCE = `
"use strict";
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const beats = new Int32Array(workerData.buffer);
let last = Atomics.load(beats, 0);
let since = Date.now();
setInterval(() => {
  const now = Date.now();
  const current = Atomics.load(beats, 0);
  if (current !== last) {
    last = current;
    since = now;
    return;
  }
  const stalled = now - since;
  if (stalled <= workerData.thresholdMs) return;
  try {
    writeSync(1, JSON.stringify({ level: "fatal", time: now, component: "watchdog", event: "event_loop_blocked", duration_ms: stalled }) + "\\n");
  } catch {}
  process.kill(process.pid, "SIGKILL");
}, workerData.checkMs);
`;

export interface Watchdog {
  stop(): Promise<void>;
}

export function startEventLoopWatchdog(opts: { thresholdMs: number; heartbeatMs?: number; checkMs?: number }): Watchdog {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const checkMs = opts.checkMs ?? CHECK_MS;
  if (!(opts.thresholdMs > heartbeatMs + checkMs)) throw new Error("watchdog threshold must exceed the heartbeat and check intervals");
  const buffer = new SharedArrayBuffer(4);
  const beats = new Int32Array(buffer);
  const heartbeat = setInterval(() => Atomics.add(beats, 0, 1), heartbeatMs);
  heartbeat.unref();
  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { buffer, thresholdMs: opts.thresholdMs, checkMs },
    // The watchdog needs no inherited flags or environment.
    execArgv: [],
    env: {},
    stdout: false,
    stderr: false,
  });
  worker.unref();
  return {
    async stop() {
      clearInterval(heartbeat);
      await worker.terminate().catch(() => undefined);
    },
  };
}
