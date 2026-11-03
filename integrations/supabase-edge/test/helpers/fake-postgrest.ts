import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { asRole } from "./db.ts";

export const SERVICE_KEY = "0123456789abcdef0123456789abcdef";

/**
 * Minimal PostgREST stand-in: POST /rest/v1/rpc/<fn> with a JSON object of
 * named arguments runs the SQL function as service_role over pg. Only the
 * idr_* functions are reachable.
 */
export class FakePostgrest {
  private server: Server;
  url = "";
  calls = 0;

  constructor(pool: pg.Pool) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => chunks.push(d));
      req.on("end", () => {
        void (async () => {
          const m = /^\/rest\/v1\/rpc\/(idr_[a-z_]+)$/.exec(req.url ?? "");
          const authorised = req.headers.apikey === SERVICE_KEY && req.headers.authorization === `Bearer ${SERVICE_KEY}`;
          if (!m || req.method !== "POST" || !authorised) {
            res.writeHead(m && !authorised ? 401 : 404).end();
            return;
          }
          this.calls++;
          try {
            const args = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            const keys = Object.keys(args);
            const params = keys.map((k, i) => `${k} => $${i + 1}${typeof args[k] === "object" && args[k] !== null ? "::jsonb" : ""}`);
            const values = keys.map((k) => (typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
            const r = await asRole(pool, "service_role", (c) =>
              c.query<{ out: unknown }>(`select public.${m[1]}(${params.join(", ")}) as out`, values),
            );
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r.rows[0]!.out));
          } catch {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ message: "sql error" }));
          }
        })();
      });
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
