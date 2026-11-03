/**
 * Process-level crash containment for the single-process runtime (CHR-70).
 *
 * With jobs running in the service process, a fault that escapes a job's own
 * try/catch (an unhandled rejection, an exception thrown from a timer or an
 * event emitter) leaves the process in an unknown state. The only safe
 * response is to log a FIXED event (the error object, which may embed an IP,
 * a query parameter or a payload, is never logged) and exit non-zero so the
 * platform restarts the service (Railway restartPolicyType ON_FAILURE).
 *
 * The website never waits on the resolver (its adapter is non-blocking), so
 * a restart costs in-flight identifications, never page renders.
 */
import type { Logger } from "../log/index.js";

/** Bounded wait for the asynchronous log destination before a fatal exit. */
export const FATAL_FLUSH_MS = 250;
export const FATAL_EXIT_CODE = 70; // EX_SOFTWARE

export type FatalCategory = "unhandled_rejection" | "uncaught_exception" | "job_stuck";

export interface ProcessGuards {
  /** Logs `process_fatal{category}` once and exits with FATAL_EXIT_CODE after a bounded flush. */
  fatal(category: FatalCategory): void;
  /** Removes the handlers (tests). */
  uninstall(): void;
}

export function installProcessGuards(opts: { logger: Logger; exit?: (code: number) => void }): ProcessGuards {
  const { logger } = opts;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let exiting = false;

  const fatal = (category: FatalCategory): void => {
    if (exiting) return;
    exiting = true;
    try {
      logger.error("process_fatal", { category });
    } catch {
      // logging must never prevent the exit
    }
    const hard = setTimeout(() => exit(FATAL_EXIT_CODE), FATAL_FLUSH_MS);
    hard.unref();
    logger
      .flush()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(hard);
        exit(FATAL_EXIT_CODE);
      });
  };

  // Listeners take no arguments on purpose: the reason/error is never inspected or logged.
  const onRejection = () => fatal("unhandled_rejection");
  const onException = () => fatal("uncaught_exception");
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  return {
    fatal,
    uninstall() {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    },
  };
}
