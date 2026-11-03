import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Placeholder credential (matches the allowlisted synthetic pattern). */
export const TOKEN = "0123456789abcdef0123456789abcdef";

export type Item = Record<string, unknown>;

export function obs(id: number, company: number, observedAt: string, extra: Item = {}): Item {
  return {
    type: "observation",
    observation_id: String(id),
    company_id: company,
    domain: `company${company}.example.com`,
    organisation_name: `Company ${company} Ltd`,
    observed_at: observedAt,
    method: "cache",
    page_key: "/pricing",
    acquisition: "search",
    entrance_contract: "entrance.v1",
    ...extra,
  };
}

export function tomb(id: number, company: number, erasedAt = "2026-11-03T12:05:00.000Z"): Item {
  return { type: "company_erased", tombstone_id: String(id), company_id: company, erased_at: erasedAt };
}

export interface Override {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface LoggedRequest {
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
}

/**
 * Scripted resolver implementing reporting-feed.v1 exactly as documented:
 * one ordered stream, opaque integrity-checked cursor ("c<index>"), limit
 * 1..500, 410 cursor_expired below the retention floor, and a summary
 * endpoint computed from the stream. `overrides` are consumed first, per
 * request, to script 429/5xx behaviour.
 */
export class MockResolver {
  items: Item[] = [];
  overrides: Override[] = [];
  /** Cursors below this stream index answer 410 cursor_expired. */
  retentionFloor = 0;
  requests: LoggedRequest[] = [];
  installationId = "inst_test";
  private server: Server;
  baseUrl = "";

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  reset(): void {
    this.items = [];
    this.overrides = [];
    this.retentionFloor = 0;
    this.requests = [];
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    this.requests.push({ path: url.pathname, query: url.searchParams, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return this.send(res, 401, { version: "1", error: "unauthorized" });
    const o = this.overrides.shift();
    if (o) return this.send(res, o.status, o.body ?? { version: "1", error: "scripted" }, o.headers);

    const scope = { installation_id: this.installationId, website_id: "site_test" };
    if (url.pathname === "/v1/reporting/observations") {
      const after = url.searchParams.get("after");
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? 200 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return this.send(res, 400, { version: "1", error: "invalid_request" });
      let start = this.retentionFloor; // no cursor = start of the retained buffer
      if (after !== null) {
        const m = /^c([0-9]{1,9})$/.exec(after);
        if (!m || Number(m[1]) > this.items.length) return this.send(res, 400, { version: "1", error: "invalid_request" });
        start = Number(m[1]);
        if (start < this.retentionFloor) return this.send(res, 410, { version: "1", error: "cursor_expired" });
      }
      const slice = this.items.slice(start, start + limit);
      const end = start + slice.length;
      return this.send(res, 200, {
        version: "1",
        contract: "reporting-feed.v1",
        scope,
        items: slice,
        next_cursor: `c${end}`,
        has_more: end < this.items.length,
      });
    }
    if (url.pathname === "/v1/reporting/summary") {
      const from = Date.parse(`${url.searchParams.get("from")}T00:00:00.000Z`);
      const to = Date.parse(`${url.searchParams.get("to")}T00:00:00.000Z`) + 86_400_000;
      const erased = new Set(this.items.filter((i) => i["type"] === "company_erased").map((i) => i["company_id"]));
      const inRange = this.items.filter(
        (i) => i["type"] === "observation" && !erased.has(i["company_id"]) && Date.parse(String(i["observed_at"])) >= from && Date.parse(String(i["observed_at"])) < to,
      );
      const companies = new Set(inRange.map((i) => i["company_id"]));
      return this.send(res, 200, {
        version: "1",
        scope,
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        observations: inRange.length,
        observed_companies: companies.size,
        newly_observed_companies: 0,
        previously_observed_companies: companies.size,
      });
    }
    return this.send(res, 404, { version: "1", error: "not_found" });
  }
}
