/**
 * Child-process fixture for test/unit/process-guards.test.ts: installs the
 * service's real process guards / watchdog / runner wiring, then provokes one
 * fault selected by argv[2]. The fault messages deliberately embed a test IP
 * and a placeholder secret so the test can prove they are never written out.
 */
import { createLogger } from "../../src/log/index.js";
import { installProcessGuards } from "../../src/runtime/process-guards.js";
import { startEventLoopWatchdog } from "../../src/runtime/watchdog.js";
import { createRunner } from "../../src/runtime/runner.js";

const mode = process.argv[2];
const logger = createLogger({ level: "debug", component: "fixture" });
const guards = installProcessGuards({ logger });
const LEAKY = "fault 203.0.113.5 sk_test_placeholder";
const keepAlive = setInterval(() => undefined, 1_000);

switch (mode) {
  case "unhandled-rejection":
    void Promise.reject(new Error(LEAKY));
    break;
  case "uncaught-exception":
    setTimeout(() => {
      throw new Error(LEAKY);
    }, 10);
    break;
  case "blocked-loop": {
    startEventLoopWatchdog({ thresholdMs: 400 });
    setTimeout(() => {
      for (;;) {
        // a runaway synchronous loop: no timer on the main thread can fire again
      }
    }, 200);
    break;
  }
  case "healthy": {
    startEventLoopWatchdog({ thresholdMs: 400 });
    // Busy but yielding: 100 ms synchronous slices, well below the threshold.
    const busy = setInterval(() => {
      const until = Date.now() + 100;
      while (Date.now() < until) {
        // work
      }
    }, 120);
    setTimeout(() => {
      clearInterval(busy);
      clearInterval(keepAlive);
      process.exit(0);
    }, 1_500);
    break;
  }
  case "stuck-job": {
    // Wired exactly as src/main.ts wires it: a stuck job is fatal.
    const runner = createRunner({
      config: {} as never,
      deps: {} as never,
      logger,
      capacity: 1,
      stuckAfterMs: 200,
      onStuck: () => guards.fatal("job_stuck"),
      execute: () => new Promise(() => undefined),
    });
    void runner.run({ ip: "203.0.113.5", deadlineAtMs: Date.now() + 100, observationRef: "obsref-0123456789abcdef" });
    break;
  }
  default:
    process.exit(2);
}
