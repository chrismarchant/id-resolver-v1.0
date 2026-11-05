/**
 * Allowlisted structured logging. Callers may only log a fixed event name
 * plus a small set of scalar fields. Free text, request objects, provider
 * bodies and errors are never serialized. A final defensive redaction
 * replaces anything that looks like an IP literal or a bearer token.
 */
import pino from "pino";

export const LOG_EVENTS = [
  "server_started",
  "server_stopping",
  "server_stopped",
  "config_loaded",
  "request_rejected",
  "request_completed",
  "job_started",
  "job_finished",
  "job_timeout",
  "job_settled",
  "job_stuck",
  "job_error",
  "process_fatal",
  "event_loop_blocked",
  "provider_call",
  "provider_outcome",
  "cache_lookup",
  "reservation",
  "lease_lost",
  "usage_reservation",
  "cache_prune",
  "db_error",
  "shutdown_timeout",
  "readiness",
  "activity_recorded",
  "activity_write_failed",
  "observation_prune",
  "migration_check",
  "maintenance_run",
  "maintenance_backlog",
  "event_prune",
  "config_override",
  "database_role_check",
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];

export const LOG_FIELDS = [
  "job_id",
  "status",
  "reason",
  "source",
  "http_status",
  "error_code",
  "duration_ms",
  "signal",
  "active_jobs",
  "outcome",
  "category",
  "rows",
  "ready",
  "installation_id",
  "website_id",
  "period_key",
  "cap",
  "resolved_cap",
  "attempts",
  "count",
  "route",
  "method",
  "component",
  "company_id",
  "recorded",
  "previously_seen",
  "cache_rows",
  "observation_rows",
  "event_rows",
  "backlog",
  "events_enabled",
  "event_consent_mode",
  "variable",
  "tls_mode",
  "db_role",
] as const;

export type LogField = (typeof LOG_FIELDS)[number];
export type LogFields = Partial<Record<LogField, string | number | boolean>>;

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi;
const BEARER = /bearer\s+[a-z0-9._~+/=-]+/gi;
const KEY = /\bsk_[a-z0-9]+/gi;

export function redactText(value: string): string {
  return value.replace(BEARER, "bearer [redacted]").replace(KEY, "[redacted]").replace(IPV4, "[ip]").replace(IPV6, "[ip]");
}

export interface Logger {
  log(level: "error" | "warn" | "info" | "debug", event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  debug(event: LogEvent, fields?: LogFields): void;
  flush(): Promise<void>;
}

function sanitiseFields(fields: LogFields | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!fields) return out;
  for (const key of LOG_FIELDS) {
    const v = fields[key];
    if (v === undefined) continue;
    if (typeof v === "string") out[key] = redactText(v.slice(0, 200));
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

export function createLogger(opts: { level: string; component: string; destination?: pino.DestinationStream }): Logger {
  const destination = opts.destination ?? pino.destination({ fd: 1, sync: false });
  // A closed stdout (EPIPE) must never crash the service.
  (destination as unknown as { on?: (ev: string, fn: () => void) => void }).on?.("error", () => {});
  const base = pino(
    {
      level: opts.level,
      base: { component: opts.component },
      messageKey: "event",
      // Belt and braces: pino-level redaction of anything accidentally nested.
      redact: { paths: ["ip", "*.ip", "authorization", "*.authorization", "headers", "body", "err", "error"], remove: true },
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
  const emit = (level: "error" | "warn" | "info" | "debug", event: LogEvent, fields?: LogFields) => {
    if (!(LOG_EVENTS as readonly string[]).includes(event)) return;
    base[level](sanitiseFields(fields), event);
  };
  return {
    log: emit,
    error: (e, f) => emit("error", e, f),
    warn: (e, f) => emit("warn", e, f),
    info: (e, f) => emit("info", e, f),
    debug: (e, f) => emit("debug", e, f),
    flush: () =>
      new Promise<void>((resolve) => {
        base.flush(() => resolve());
      }),
  };
}

/** Logger that records events in memory for tests. */
export function createMemoryLogger(level = "debug"): Logger & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const dest: pino.DestinationStream = {
    write(chunk: string) {
      for (const line of chunk.split("\n")) {
        if (line.trim()) entries.push(JSON.parse(line) as Record<string, unknown>);
      }
    },
  };
  const logger = createLogger({ level, component: "test", destination: dest });
  return Object.assign(logger, { entries });
}
