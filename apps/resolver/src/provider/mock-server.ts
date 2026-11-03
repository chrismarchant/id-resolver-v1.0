/**
 * Tiny Enrich v3 emulator for end-to-end tests and the Railway POC
 * (`npm run mock-provider`). Synthetic data only.
 *
 * POST <any prefix>/ip-to-company  {"ip": "..."}  with x-api-key or Bearer.
 * Responses are scripted per IP from fixture files (JSON objects
 * `{ "ip", "status"?, "headers"?, "body" }`), plus special addresses:
 *
 *   198.51.100.250  slow: sleeps `slowMs` (default 15 s) before answering
 *   198.51.100.251  500
 *   198.51.100.252  429 with Retry-After: 30
 *   198.51.100.253  401
 *   198.51.100.254  402
 *   198.51.100.249  200 with malformed JSON
 *   198.51.100.248  200 with a body missing `data`
 *   198.51.100.247  200 with an oversized (~100 KiB) body
 *
 * Unscripted addresses get 200 with no ipDomain. The server never logs IPs.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

export interface MockFixture {
  ip: string;
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  fixturesDir?: string;
  fixtures?: MockFixture[];
  slowMs?: number;
}

export interface MockServerHandle {
  url: string;
  port: number;
  /** Requests received per IP (for tests). */
  hits(ip: string): number;
  close(): Promise<void>;
}

export const SPECIAL_IPS = {
  slow: "198.51.100.250",
  serverError: "198.51.100.251",
  rateLimited: "198.51.100.252",
  unauthorized: "198.51.100.253",
  paymentRequired: "198.51.100.254",
  malformedJson: "198.51.100.249",
  missingData: "198.51.100.248",
  oversized: "198.51.100.247",
} as const;

export function loadFixtures(dir: string): MockFixture[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: MockFixture[] = [];
  for (const name of names.sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<MockFixture>;
    if (typeof parsed.ip === "string" && parsed.body !== undefined) out.push(parsed as MockFixture);
  }
  return out;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolveBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolveBody(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolveBody(null));
  });
}

export function startMockEnrichServer(opts: MockServerOptions = {}): Promise<MockServerHandle> {
  const fixtures = new Map<string, MockFixture>();
  for (const f of opts.fixtures ?? loadFixtures(opts.fixturesDir ?? resolve(process.cwd(), "test/fixtures/provider"))) {
    fixtures.set(f.ip, f);
  }
  const slowMs = opts.slowMs ?? 15_000;
  const counts = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").split("?")[0]!.endsWith("/ip-to-company")) {
      return send(res, 404, JSON.stringify({ success: false, error: "not_found" }));
    }
    const auth = req.headers["x-api-key"] ?? req.headers["authorization"];
    if (typeof auth !== "string" || auth.trim().length === 0) {
      return send(res, 401, JSON.stringify({ success: false, error: "unauthorized" }));
    }
    const raw = await readBody(req, 1024);
    let ip: unknown;
    try {
      ip = raw === null ? undefined : (JSON.parse(raw) as { ip?: unknown }).ip;
    } catch {
      ip = undefined;
    }
    if (typeof ip !== "string") return send(res, 400, JSON.stringify({ success: false, error: "bad_request" }));
    counts.set(ip, (counts.get(ip) ?? 0) + 1);

    switch (ip) {
      case SPECIAL_IPS.slow: {
        const t = setTimeout(() => {
          timers.delete(t);
          send(res, 200, JSON.stringify({ success: true, data: {}, meta: { credits_used: 0 } }));
        }, slowMs);
        timers.add(t);
        res.on("close", () => {
          clearTimeout(t);
          timers.delete(t);
        });
        return;
      }
      case SPECIAL_IPS.serverError:
        return send(res, 500, JSON.stringify({ success: false, error: "internal" }));
      case SPECIAL_IPS.rateLimited:
        return send(res, 429, JSON.stringify({ success: false, error: "rate_limited" }), {
          "retry-after": "30",
          "x-ratelimit-remaining": "0",
        });
      case SPECIAL_IPS.unauthorized:
        return send(res, 401, JSON.stringify({ success: false, error: "unauthorized" }));
      case SPECIAL_IPS.paymentRequired:
        return send(res, 402, JSON.stringify({ success: false, error: "insufficient_credits" }));
      case SPECIAL_IPS.malformedJson:
        return send(res, 200, '{"success": true, "data": {"ipDomain": "example.com"');
      case SPECIAL_IPS.missingData:
        return send(res, 200, JSON.stringify({ success: true, meta: { credits_used: 0 } }));
      case SPECIAL_IPS.oversized:
        return send(
          res,
          200,
          JSON.stringify({ success: true, data: { ipDomain: "example.com", ipUsageType: "COM", padding: "x".repeat(100 * 1024) } }),
        );
    }

    const fixture = fixtures.get(ip);
    if (fixture) return send(res, fixture.status ?? 200, JSON.stringify(fixture.body), fixture.headers ?? {});
    return send(res, 200, JSON.stringify({ success: true, data: { ipUsageType: "ISP" }, meta: { credits_used: 0 } }));
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const host = opts.host ?? "127.0.0.1";
      resolveStart({
        port,
        url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
        hits: (ip) => counts.get(ip) ?? 0,
        close: () =>
          new Promise<void>((done) => {
            for (const t of timers) clearTimeout(t);
            timers.clear();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const port = Number(process.env["MOCK_PROVIDER_PORT"] ?? process.env["PORT"] ?? 8787);
  const host = process.env["MOCK_PROVIDER_HOST"] ?? "127.0.0.1";
  const fixturesDir = process.env["MOCK_PROVIDER_FIXTURES"];
  const handle = await startMockEnrichServer({ port, host, ...(fixturesDir ? { fixturesDir } : {}) });
  process.stdout.write(`mock enrich provider listening on ${handle.url} (base url: ${handle.url}/api/v3)\n`);
  const stop = () => void handle.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
