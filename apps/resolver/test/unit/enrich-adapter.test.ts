import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrichAdapter, parseRetryAfter } from "../../src/provider/enrich.js";
import { createProvider } from "../../src/provider/index.js";
import { createMockProvider } from "../../src/provider/mock.js";
import { SPECIAL_IPS, startMockEnrichServer, type MockServerHandle } from "../../src/provider/mock-server.js";
import type { ProviderOutcome } from "../../src/contracts/provider.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures/provider");
const FORBIDDEN = ["ipRange", "ipIsp", "latitude", "longitude", "Example Transit Networks", "203.0.113.0/24", "Exampleland", "Example City"];

let server: MockServerHandle;
let adapter: ReturnType<typeof createEnrichAdapter>;

function lookup(ip: string, timeoutMs = 2_000): Promise<ProviderOutcome> {
  return adapter.lookup(ip, { signal: AbortSignal.timeout(timeoutMs) });
}

function assertClean(outcome: ProviderOutcome, ip: string): void {
  const s = JSON.stringify(outcome);
  expect(s).not.toContain(ip);
  for (const f of FORBIDDEN) expect(s).not.toContain(f);
}

beforeAll(async () => {
  server = await startMockEnrichServer({ fixturesDir: FIXTURES, slowMs: 5_000 });
  adapter = createEnrichAdapter({ baseUrl: `${server.url}/api/v3/`, apiKey: "sk_test_key_123", authHeader: "x-api-key" });
});
afterAll(async () => {
  await server.close();
});

describe("enrich adapter against the mock server", () => {
  it("maps a 200 with domain to resolved, keeping only allowlisted fields", async () => {
    const o = await lookup("203.0.113.10");
    expect(o).toEqual({ kind: "resolved", domain: "example.com", organisationName: "Example Ltd", usageType: "COM", creditsReported: 100 });
    assertClean(o, "203.0.113.10");
  });

  it("reads the documented credit field names and ignores a bare credits value (could be a balance)", async () => {
    expect(await lookup("203.0.113.11")).toMatchObject({ kind: "resolved", usageType: "ISP", creditsReported: 100 });
    expect(await lookup("203.0.113.12")).toMatchObject({ kind: "resolved", usageType: null, creditsReported: null });
  });

  it("handles IPv6", async () => {
    expect(await lookup("2001:db8::10")).toMatchObject({ kind: "resolved", domain: "example.edu", usageType: "EDU" });
  });

  it("maps a 200 without domain to no_domain", async () => {
    const o = await lookup("203.0.113.13");
    expect(o).toEqual({ kind: "no_domain", creditsReported: 0 });
    assertClean(o, "203.0.113.13");
    expect(await lookup("198.51.100.77")).toEqual({ kind: "no_domain", creditsReported: 0 });
  });

  it("treats an invalid provider domain as no_domain", async () => {
    expect(await lookup("203.0.113.14")).toEqual({ kind: "no_domain", creditsReported: 100 });
  });

  it("treats success=false without a domain as no_domain", async () => {
    expect(await lookup("203.0.113.15")).toEqual({ kind: "no_domain", creditsReported: null });
  });

  it.each([
    [SPECIAL_IPS.unauthorized, { kind: "error", category: "auth", retryAfterMs: null }],
    [SPECIAL_IPS.paymentRequired, { kind: "error", category: "credits", retryAfterMs: null }],
    [SPECIAL_IPS.rateLimited, { kind: "error", category: "rate_limited", retryAfterMs: 30_000 }],
    [SPECIAL_IPS.serverError, { kind: "error", category: "server", retryAfterMs: null }],
    [SPECIAL_IPS.malformedJson, { kind: "error", category: "malformed", retryAfterMs: null }],
    [SPECIAL_IPS.missingData, { kind: "error", category: "malformed", retryAfterMs: null }],
    [SPECIAL_IPS.oversized, { kind: "error", category: "malformed", retryAfterMs: null }],
  ])("maps %s to %j", async (ip, expected) => {
    const o = await lookup(ip);
    expect(o).toEqual(expected);
    assertClean(o, ip);
  });

  it("maps an abort after dispatch to timeout", async () => {
    const started = Date.now();
    const o = await lookup(SPECIAL_IPS.slow, 300);
    expect(o).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns auth error when the key is missing (server rejects)", async () => {
    const a = createEnrichAdapter({ baseUrl: server.url, apiKey: "", authHeader: "x-api-key" });
    expect(await a.lookup("203.0.113.10", { signal: AbortSignal.timeout(2_000) })).toMatchObject({ kind: "error", category: "auth" });
  });

  it("maps a refused connection to a network error", async () => {
    const a = createEnrichAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "k", authHeader: "x-api-key" });
    expect(await a.lookup("203.0.113.10", { signal: AbortSignal.timeout(2_000) })).toEqual({
      kind: "error",
      category: "network",
      retryAfterMs: null,
    });
  });
});

describe("enrich adapter request shape and edge cases", () => {
  let raw: Server;
  let url: string;
  const seen: Array<{ method: string | undefined; path: string | undefined; headers: Record<string, unknown>; body: string }> = [];
  let respond: (res: import("node:http").ServerResponse) => void = (res) => res.end();

  beforeAll(async () => {
    raw = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        seen.push({ method: req.method, path: req.url, headers: { ...req.headers }, body });
        respond(res);
      });
    });
    await new Promise<void>((r) => raw.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(raw.address() as AddressInfo).port}/api/v3`;
  });
  afterAll(async () => {
    raw.closeAllConnections();
    await new Promise<void>((r) => raw.close(() => r()));
  });

  it("POSTs JSON with the configured auth header", async () => {
    respond = (res) => res.writeHead(200, { "content-type": "application/json" }).end('{"success":true,"data":{}}');
    const bearer = createEnrichAdapter({ baseUrl: url, apiKey: "sk_bearer", authHeader: "authorization-bearer" });
    await bearer.lookup("203.0.113.20", { signal: AbortSignal.timeout(2_000) });
    const xkey = createEnrichAdapter({ baseUrl: url, apiKey: "sk_header", authHeader: "x-api-key" });
    await xkey.lookup("2001:db8::20", { signal: AbortSignal.timeout(2_000) });
    const [a, b] = seen.slice(-2);
    expect(a).toMatchObject({ method: "POST", path: "/api/v3/ip-to-company", body: '{"ip":"203.0.113.20"}' });
    expect(a!.headers["authorization"]).toBe("Bearer sk_bearer");
    expect(a!.headers["x-api-key"]).toBeUndefined();
    expect(a!.headers["content-type"]).toBe("application/json");
    expect(a!.headers["accept"]).toBe("application/json");
    expect(b!.headers["x-api-key"]).toBe("sk_header");
    expect(b!.headers["authorization"]).toBeUndefined();
    expect(b!.body).toBe('{"ip":"2001:db8::20"}');
  });

  it.each([
    [403, "auth"],
    [404, "server"],
    [418, "server"],
    [503, "server"],
  ])("maps HTTP %i to %s", async (status, category) => {
    respond = (res) => res.writeHead(status).end("{}");
    const a = createEnrichAdapter({ baseUrl: url, apiKey: "k", authHeader: "x-api-key" });
    expect(await a.lookup("203.0.113.21", { signal: AbortSignal.timeout(2_000) })).toEqual({ kind: "error", category, retryAfterMs: null });
  });

  it("treats success=false with a domain, and wrong types, as malformed", async () => {
    const a = createEnrichAdapter({ baseUrl: url, apiKey: "k", authHeader: "x-api-key" });
    for (const body of [
      '{"success":false,"data":{"ipDomain":"example.com"}}',
      '{"success":"yes","data":{}}',
      '{"success":true,"data":{"ipDomain":42}}',
      "[]",
      "null",
      "",
    ]) {
      respond = (res) => res.writeHead(200, { "content-type": "application/json" }).end(body);
      expect(await a.lookup("203.0.113.22", { signal: AbortSignal.timeout(2_000) }), body).toMatchObject({ kind: "error", category: "malformed" });
    }
  });

  it("rejects a streamed body over the cap without content-length", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"success":true,"data":{"ipDomain":"example.com","pad":"');
      res.end("y".repeat(70 * 1024) + '"}}');
    };
    const a = createEnrichAdapter({ baseUrl: url, apiKey: "k", authHeader: "x-api-key" });
    expect(await a.lookup("203.0.113.23", { signal: AbortSignal.timeout(2_000) })).toMatchObject({ kind: "error", category: "malformed" });
  });

  it("never rejects, even when fetch itself throws synchronously-ish", async () => {
    const throwing = (() => {
      throw new Error("boom 203.0.113.24");
    }) as unknown as typeof fetch;
    const a = createEnrichAdapter({ baseUrl: url, apiKey: "k", authHeader: "x-api-key", fetchImpl: throwing });
    const o = await a.lookup("203.0.113.24", { signal: AbortSignal.timeout(2_000) });
    expect(o).toEqual({ kind: "error", category: "network", retryAfterMs: null });
    assertClean(o, "203.0.113.24");
  });

  it("returns timeout when the signal is already aborted", async () => {
    const a = createEnrichAdapter({ baseUrl: url, apiKey: "k", authHeader: "x-api-key" });
    expect(await a.lookup("203.0.113.25", { signal: AbortSignal.abort() })).toEqual({ kind: "timeout" });
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  it("parses seconds and HTTP dates, caps at 1h, null when absent", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("999999", now)).toBe(3_600_000);
    expect(parseRetryAfter("Mon, 26 Oct 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Mon, 26 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});

describe("provider factory and mock adapter", () => {
  it("selects adapters by mode and refuses plain http to non-loopback hosts", async () => {
    const base = { base_url: "https://dev.enrich.so/api/v3", api_key: "sk_test_key_123", auth_header: "x-api-key" };
    expect(createProvider({ ...base, mode: "live" }).name).toBe("enrich-v3");
    expect(createProvider({ ...base, mode: "mock" }).name).toBe("mock");
    expect(createProvider({ ...base, mode: "disabled" }).name).toBe("disabled");
    expect(createProvider({ ...base, mode: "live", base_url: "http://127.0.0.1:8787/api/v3" }).name).toBe("enrich-v3");
    expect(() => createProvider({ ...base, mode: "live", base_url: "http://dev.enrich.so/api/v3" })).toThrow();
    expect(() => createProvider({ ...base, mode: "live", api_key: "" })).toThrow();
  });

  it("mock adapter is scripted, counts calls and honours abort", async () => {
    const mock = createMockProvider({
      "203.0.113.10": { outcome: { kind: "no_domain", creditsReported: 0 } },
      "203.0.113.99": { outcome: { kind: "no_domain", creditsReported: 0 }, delayMs: 10_000 },
    });
    expect(await mock.lookup("203.0.113.10", { signal: AbortSignal.timeout(1_000) })).toEqual({ kind: "no_domain", creditsReported: 0 });
    expect(await mock.lookup("203.0.113.99", { signal: AbortSignal.timeout(50) })).toEqual({ kind: "timeout" });
    expect(await mock.lookup("192.0.2.1", { signal: AbortSignal.timeout(1_000) })).toEqual({ kind: "no_domain", creditsReported: 0 });
    expect(mock.calls).toBe(3);
  });
});
