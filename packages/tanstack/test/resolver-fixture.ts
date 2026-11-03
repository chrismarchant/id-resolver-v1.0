import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type FixtureBehaviour = { kind: "ok"; status?: string; recorded?: boolean } | { kind: "status"; code: number; headers?: Record<string, string> } | { kind: "hang" } | { kind: "sequence"; steps: FixtureBehaviour[] } | { kind: "bad-json" } | { kind: "redirect"; to: string };

/** A real HTTP server standing in for the resolver. */
export async function startResolver(behaviour: FixtureBehaviour = { kind: "ok" }) {
  const captured: Captured[] = [];
  const open = new Set<import("node:net").Socket>();
  let step = 0;
  const pick = (): FixtureBehaviour => (behaviour.kind === "sequence" ? behaviour.steps[Math.min(step++, behaviour.steps.length - 1)]! : behaviour);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const b = pick();
      switch (b.kind) {
        case "hang":
          return; // never answers
        case "status":
          res.writeHead(b.code, { "content-type": "application/json", ...(b.headers ?? {}) }).end(JSON.stringify({ version: "1", error: "x" }));
          return;
        case "bad-json":
          res.writeHead(200, { "content-type": "application/json" }).end("{not json");
          return;
        case "redirect":
          res.writeHead(302, { location: b.to }).end();
          return;
        default:
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "1", status: b.kind === "ok" ? (b.status ?? "qualified") : "unknown", source: "cache", recorded: b.kind === "ok" ? (b.recorded ?? true) : false }));
      }
    });
  });
  server.on("connection", (s) => {
    open.add(s);
    s.on("close", () => open.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    captured,
    async close() {
      for (const s of open) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A port on which nothing listens (connection refused). */
export async function closedPortUrl(): Promise<string> {
  const s = await startResolver();
  const url = s.url;
  await s.close();
  return url;
}
