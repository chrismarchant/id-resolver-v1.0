/**
 * Stub child for child-manager tests. Behaviour is selected by the job's IP
 * (the only per-job input). Exits 42 if the spawn hygiene assertions fail:
 * no extra argv, no secrets in env, no inspector flags, config before job.
 */
const FORBIDDEN_ENV = ["IP_HMAC_SECRET", "ENRICH_API_KEY", "DATABASE_URL", "RESOLVER_AUTH_TOKEN"];

function hygieneOk(): boolean {
  if (process.argv.length !== 2) return false;
  if (FORBIDDEN_ENV.some((k) => k in process.env)) return false;
  if (process.execArgv.some((a) => a.startsWith("--inspect") || a.startsWith("--debug"))) return false;
  return typeof process.send === "function";
}

if (!hygieneOk()) process.exit(42);

let gotConfig = false;
const hang = () => setInterval(() => undefined, 1_000);
const send = (msg: unknown, then?: () => void) => process.send!(msg, undefined, {}, () => then?.());
const result = (jobId: string, outcome: unknown) => ({ v: 1, type: "result", job_id: jobId, outcome });
const qualified = {
  status: "qualified",
  company: {
    domain: "example.com",
    organisation_name: "Example Ltd",
    qualification: { category: "COM", source: "provider_usage_type" },
    resolved_at: "2026-10-26T12:00:00.000Z",
  },
  source: "provider",
  reason: "provider_resolved",
};

process.on("message", (m: { type?: string; job_id?: string; ip?: string; config?: { ip_hmac_secret?: string } }) => {
  if (m.type === "config") {
    if (gotConfig || typeof m.config?.ip_hmac_secret !== "string") process.exit(42);
    gotConfig = true;
    return;
  }
  if (m.type !== "job" || !gotConfig || typeof m.job_id !== "string") process.exit(42);
  const jobId = m.job_id!;
  send({ v: 1, type: "ready" });
  switch (m.ip) {
    case "203.0.113.1": // happy path
      return send(result(jobId, qualified), () => process.exit(0));
    case "203.0.113.2": // crash
      return process.exit(1);
    case "203.0.113.3": // hang forever
      hang();
      return;
    case "203.0.113.4": // non-protocol message, then hang
      send({ hello: "world" });
      hang();
      return;
    case "203.0.113.5": // result, then hang
      send(result(jobId, { status: "no_match", company: null, source: "provider", reason: "provider_no_domain" }));
      hang();
      return;
    case "203.0.113.6": // invalid status
      return send(result(jobId, { status: "owned", company: null, source: "provider" }), () => process.exit(0));
    case "203.0.113.7": // wrong job id
      return send(result("not-this-job", qualified), () => process.exit(0));
    case "203.0.113.8": // company on a non-qualified status
      return send(result(jobId, { ...qualified, status: "unknown" }), () => process.exit(0));
    case "203.0.113.9": // ignores SIGTERM: requires SIGKILL
      process.on("SIGTERM", () => undefined);
      hang();
      return;
    case "203.0.113.10": // free-text reason injection
      return send(result(jobId, { status: "no_match", company: null, source: "provider", reason: "203.0.113.10 leaked" }), () =>
        process.exit(0),
      );
    default:
      return send(result(jobId, { status: "no_match", company: null, source: "none" }), () => process.exit(0));
  }
});
