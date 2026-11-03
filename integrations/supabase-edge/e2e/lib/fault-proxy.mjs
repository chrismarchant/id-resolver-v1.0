// Fault-injecting HTTP proxy between the Edge Function (in its container) and
// the resolver (on the host, bound to 127.0.0.1). Pass-through unless a rule
// matches. It lets the harness hold a response (to kill the function while a
// page is in flight), fail a request, delay responses (to make invocations
// overlap) or replace the bearer token. It records every request it sees, but
// keeps no credential and no cursor: only booleans and counters.
import http from "node:http";

/**
 * @typedef {{ n: number, method: string, path: string, feed: boolean, hasAfter: boolean,
 *   limit: string | null, reportingAuth: boolean, status: number | null, action: string, clientGone: boolean }} Entry
 * @typedef {{ id: string, match: (e: Entry) => boolean, action: "fail" | "hold" | "delay" | "auth",
 *   remaining: number, status?: number, ms?: number, authorization?: string | null,
 *   held: Promise<Entry>, release: () => void, hits: number }} Rule
 */

/**
 * @param {{ host: string, port: number, target: { host: string, port: number }, reportingToken: string }} o
 */
export async function startFaultProxy(o) {
  /** @type {Entry[]} */
  const log = [];
  /** @type {Rule[]} */
  let rules = [];
  let n = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://proxy.invalid");
    /** @type {Entry} */
    const entry = {
      n: ++n,
      method: req.method ?? "",
      path: url.pathname,
      feed: url.pathname === "/v1/reporting/observations",
      hasAfter: url.searchParams.has("after"),
      limit: url.searchParams.get("limit"),
      reportingAuth: req.headers["authorization"] === `Bearer ${o.reportingToken}`,
      status: null,
      action: "pass",
      clientGone: false,
    };
    log.push(entry);
    res.on("close", () => {
      if (!res.writableFinished) entry.clientGone = true;
    });
    const rule = rules.find((r) => r.remaining !== 0 && r.match(entry));
    if (rule) {
      rule.remaining -= 1;
      rule.hits += 1;
      entry.action = rule.action;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void handle(req, res, entry, rule, Buffer.concat(chunks));
    });
  });

  /**
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {Entry} entry
   * @param {Rule | undefined} rule @param {Buffer} body
   */
  async function handle(req, res, entry, rule, body) {
    try {
      if (rule?.action === "fail") {
        entry.status = rule.status ?? 503;
        res.writeHead(entry.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "injected_fault" }));
        rule.resolveHeld(entry);
        return;
      }
      if (rule?.action === "delay") await new Promise((r) => setTimeout(r, rule.ms ?? 0));
      const headers = { ...req.headers, host: `${o.target.host}:${o.target.port}` };
      if (rule?.action === "auth") {
        if (rule.authorization === null || rule.authorization === undefined) delete headers["authorization"];
        else headers["authorization"] = rule.authorization;
      }
      const upstream = await new Promise((resolve, reject) => {
        const u = http.request({ host: o.target.host, port: o.target.port, method: req.method, path: req.url, headers }, (r) => {
          const parts = [];
          r.on("data", (c) => parts.push(c));
          r.on("end", () => resolve({ status: r.statusCode ?? 502, headers: r.headers, body: Buffer.concat(parts) }));
          r.on("error", reject);
        });
        u.on("error", reject);
        u.end(body);
      });
      entry.status = upstream.status;
      if (rule?.action === "hold") {
        // The resolver has answered; the function has not received the page yet.
        rule.resolveHeld(entry);
        await rule.released;
      } else if (rule) {
        rule.resolveHeld(entry);
      }
      if (entry.clientGone || res.destroyed) return;
      const h = { ...upstream.headers };
      delete h["transfer-encoding"];
      h["content-length"] = String(upstream.body.length);
      res.writeHead(upstream.status, h);
      res.end(upstream.body);
    } catch {
      entry.status = 502;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502);
        res.end();
      }
    }
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve(undefined));
  });

  return {
    url: `http://${o.host}:${o.port}`,
    log,
    /** Index to pass to since(). */
    mark: () => log.length,
    /** @param {number} m */
    since: (m) => log.slice(m),
    /**
     * @param {{ id: string, match: (e: Entry) => boolean, action: Rule["action"], times?: number,
     *   status?: number, ms?: number, authorization?: string | null }} spec
     */
    addRule(spec) {
      /** @type {(e: Entry) => void} */
      let resolveHeld = () => undefined;
      /** @type {() => void} */
      let release = () => undefined;
      const rule = {
        ...spec,
        remaining: spec.times ?? -1,
        hits: 0,
        held: new Promise((r) => {
          resolveHeld = r;
        }),
        released: new Promise((r) => {
          release = () => r(undefined);
        }),
      };
      rule.resolveHeld = (e) => resolveHeld(e);
      rule.release = () => release();
      rules.push(rule);
      return rule;
    },
    clearRules() {
      for (const r of rules) r.release();
      rules = [];
    },
    close: () =>
      new Promise((resolve) => {
        for (const r of rules) r.release();
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/** Feed requests without a cursor (start of the retained buffer). */
export const firstPage = (e) => e.feed && !e.hasAfter;
/** Feed requests that carry a cursor. */
export const withCursor = (e) => e.feed && e.hasAfter;
/** Any feed request. */
export const anyFeed = (e) => e.feed;
