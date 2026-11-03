/**
 * POST /v1/events (contract event.v1, Gate 4, CHR-64; owner decision D4)
 * through the real server wiring and real PostgreSQL: the route exists only
 * when EVENTS_ENABLED=true, accepts the website credential only (checked
 * before the body is parsed), validates strictly (unknown fields, vocabulary,
 * event_id, page_key, the occurred_at window, website_id), enforces the
 * consent policy, stores each event_id once, bounds its writes and its rate
 * bucket, and never logs or stores an IP, a header value, an event_id or a
 * page_key.
 *
 * Synthetic data only: RFC 5737 documentation addresses, example.* hosts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EVENT_WRITES_MAX_IN_FLIGHT, EVENTS_ROUTE } from "../../src/api/events.js";
import { buildServer } from "../../src/api/server.js";
import { EVENT_VOCABULARY, type BrowserEventRecord, type EventRepository } from "../../src/contracts/event.js";
import type { JobRequest, Runner } from "../../src/contracts/runtime.js";
import type { Db } from "../../src/db/index.js";
import { DbError } from "../../src/db/pool.js";
import { createMemoryLogger, LOG_EVENTS } from "../../src/log/index.js";
import { createTestDb, resetTestDb } from "../helpers/db.js";
import { testConfig, TEST_AUTH_TOKEN } from "../helpers/env.js";
import { dumpDatabaseText, findLeaks, ipVariants } from "../helpers/leak-scan.js";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const REPORTING_TOKEN = ["test", "events", "reporting", "token", "0123456789abcdef0123456789abcdef"].join("-");
const json = { "content-type": "application/json" };
const auth = { authorization: `Bearer ${TEST_AUTH_TOKEN}`, ...json };
const NOT_FOUND = { version: "1", error: "not_found" };
const UNAUTHORIZED = { version: "1", error: "unauthorized" };
const INVALID = { version: "1", error: "invalid_request" };

let seq = 0;
const eventId = () => `evt_api_${String(++seq).padStart(12, "0")}`;

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: "event.v1",
    website_id: "site-test",
    event_id: eventId(),
    occurred_at: new Date(NOW).toISOString(),
    type: "conversion_intent",
    name: "pricing_view",
    page_key: "/pricing",
    consent: "granted",
    ...over,
  };
}

/** A runner that must never be called by the event route. */
function countingRunner(): Runner & { jobs: JobRequest[] } {
  const jobs: JobRequest[] = [];
  return {
    jobs,
    activeCount: () => 0,
    capacity: () => 4,
    async run(job) {
      jobs.push(job);
      return { status: "no_match", source: "cache" };
    },
    async shutdown() {
      return { drained: true, activeJobs: 0, pendingWrites: 0 };
    },
  };
}

describe("POST /v1/events (event.v1)", () => {
  let db: Db;
  let logger: ReturnType<typeof createMemoryLogger>;
  let runner: ReturnType<typeof countingRunner>;
  let app: FastifyInstance;
  let disabled: FastifyInstance;

  const build = async (over: Record<string, string> = {}, events: EventRepository | null = db.events) => {
    const s = await buildServer({
      config: testConfig({ EVENTS_ENABLED: "true", AUTH_FAILURE_LIMIT_PER_MINUTE: "100000", ...over }),
      logger,
      runner,
      ping: async () => true,
      now: () => NOW,
      ...(events ? { events } : {}),
    });
    await s.ready();
    return s;
  };
  const post = (payload: unknown, headers: Record<string, string> = auth, target: FastifyInstance = app) =>
    target.inject({ method: "POST", url: EVENTS_ROUTE, headers, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });
  const rows = async () =>
    (
      await db.pool.query<{ event_id: string; type: string; name: string; page_key: string; consent: string; origin: string; occurred_at: Date; installation_id: string; website_id: string }>(
        "SELECT installation_id, website_id, event_id, type, name, page_key, consent, origin, occurred_at FROM browser_events ORDER BY id",
      )
    ).rows;
  const count = async (table: string) => (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  beforeAll(async () => {
    db = await createTestDb({ max: 8 });
    logger = createMemoryLogger();
    runner = countingRunner();
    app = await build();
    disabled = await buildServer({ config: testConfig({ AUTH_FAILURE_LIMIT_PER_MINUTE: "100000" }), logger, runner, ping: async () => true, now: () => NOW, events: db.events });
    await disabled.ready();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });
  afterAll(async () => {
    await resetTestDb(db);
    await app.close();
    await disabled.close();
    await db.close();
  });

  describe("route existence", () => {
    it("EVENTS_ENABLED defaults to false: the route does not exist and answers exactly like an unknown route (404 with the credential, 401 without)", async () => {
      expect(testConfig().EVENTS_ENABLED).toBe(false);
      const body = event();
      const r = await post(body, auth, disabled);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(NOT_FOUND);
      const unknown = await disabled.inject({ method: "POST", url: "/v1/unknown", headers: auth, payload: JSON.stringify(body) });
      expect({ status: r.statusCode, body: r.body }).toEqual({ status: unknown.statusCode, body: unknown.body });
      expect((await post("{not json", auth, disabled)).statusCode).toBe(404);
      expect((await post(body, json, disabled)).statusCode).toBe(401);
      expect(await count("browser_events")).toBe(0);
    });

    it("EVENTS_ENABLED=true registers the route: a valid event answers 200 {version, recorded: true} and is stored once with origin=browser", async () => {
      const body = event({ type: "engagement", name: "scroll_50", page_key: "/docs/start" });
      const r = await post(body);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ version: "1", recorded: true });
      expect(Object.keys(r.json()).sort()).toEqual(["recorded", "version"]);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(await rows()).toEqual([
        {
          installation_id: "inst-test",
          website_id: "site-test",
          event_id: body["event_id"],
          type: "engagement",
          name: "scroll_50",
          page_key: "/docs/start",
          consent: "granted",
          origin: "browser",
          occurred_at: new Date(NOW),
        },
      ]);
      expect(runner.jobs).toEqual([]);
    });

    it("EVENTS_ENABLED=true without an event store refuses to build the server (fail closed)", async () => {
      let err: unknown;
      try {
        await build({}, null);
      } catch (e) {
        err = e;
      }
      expect(String(err)).toMatch(/EVENTS_ENABLED=true requires an event store/);
    });
  });

  describe("credentials: the website credential only, checked before the body is parsed", () => {
    it("answers 401 for no, wrong, malformed or the reporting credential, even for an invalid or oversized body; nothing is stored", async () => {
      const withReporting = await build({ REPORTING_AUTH_TOKEN: REPORTING_TOKEN });
      try {
        const bodies: Array<string | Record<string, unknown>> = [event(), "{not json", JSON.stringify({ ip: "203.0.113.9" }), "x".repeat(4_096)];
        const credentials: Array<Record<string, string>> = [
          json,
          { authorization: `Bearer ${TEST_AUTH_TOKEN}x`, ...json },
          { authorization: `Basic ${TEST_AUTH_TOKEN}`, ...json },
          { authorization: `Bearer ${REPORTING_TOKEN}`, ...json },
        ];
        for (const headers of credentials) {
          for (const b of bodies) {
            const r = await post(b, headers, withReporting);
            expect(r.statusCode, `${headers["authorization"] ?? "none"} / ${String(b).slice(0, 20)}`).toBe(401);
            expect(r.json()).toEqual(UNAUTHORIZED);
          }
        }
        // Control: the same server accepts the website credential.
        expect((await post(event(), auth, withReporting)).statusCode).toBe(200);
        expect(await count("browser_events")).toBe(1);
        // And with the credential, body errors are what they are: malformed 400, oversized 413.
        expect((await post("{not json", auth, withReporting)).statusCode).toBe(400);
        const big = await post("x".repeat(4_096), auth, withReporting);
        expect(big.statusCode).toBe(413);
        expect(big.json()).toEqual({ version: "1", error: "payload_too_large" });
      } finally {
        await withReporting.close();
      }
    });
  });

  describe("strict validation (400 invalid_request), nothing stored", () => {
    it.each(["ip", "user_agent", "referrer", "company_id", "session_id", "visitor_id", "cookie", "company", "path", "v"])("rejects the unknown field %s", async (field) => {
      const r = await post(event({ [field]: field === "ip" ? "203.0.113.9" : "example-value" }));
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual(INVALID);
      expect(await count("browser_events")).toBe(0);
    });

    it("rejects out-of-vocabulary types, names and type-name pairs, and accepts every vocabulary pair", async () => {
      for (const over of [{ type: "click" }, { name: "scroll_75", type: "engagement" }, { type: "page_view", name: "cta_click" }, { type: "engagement", name: "page_view" }, { type: "__proto__", name: "page_view" }]) {
        const r = await post(event(over));
        expect(r.statusCode, JSON.stringify(over)).toBe(400);
        expect(r.json()).toEqual(INVALID);
      }
      expect(await count("browser_events")).toBe(0);
      let n = 0;
      for (const [type, names] of Object.entries(EVENT_VOCABULARY.types)) {
        for (const name of names) {
          expect((await post(event({ type, name }))).statusCode, `${type}/${name}`).toBe(200);
          n += 1;
        }
      }
      expect(await count("browser_events")).toBe(n);
    });

    it("rejects a bad event_id", async () => {
      for (const id of ["short", "x".repeat(65), "has space 0123456789", "evt.0123456789abcdef", 1234567890123456]) {
        const r = await post(event({ event_id: id }));
        expect(r.statusCode, String(id)).toBe(400);
      }
      expect(await count("browser_events")).toBe(0);
    });

    it("rejects a page_key with a query string or fragment, over 256 characters, or not a path", async () => {
      for (const pk of ["/pricing?plan=pro", "/pricing#faq", `/${"p".repeat(256)}`, "pricing", "https://example.com/pricing", "/a b"]) {
        const r = await post(event({ page_key: pk }));
        expect(r.statusCode, pk.slice(0, 40)).toBe(400);
      }
      expect(await count("browser_events")).toBe(0);
      expect((await post(event({ page_key: `/${"p".repeat(255)}` }))).statusCode).toBe(200);
    });

    it("bounds occurred_at to 300 s around resolver time, like entrances", async () => {
      for (const skew of [-300_001, 300_001, -3_600_000, 86_400_000]) {
        const r = await post(event({ occurred_at: new Date(NOW + skew).toISOString() }));
        expect(r.statusCode, String(skew)).toBe(400);
        expect(r.json()).toEqual(INVALID);
      }
      expect(await count("browser_events")).toBe(0);
      for (const skew of [-300_000, -299_000, 299_000, 300_000]) {
        expect((await post(event({ occurred_at: new Date(NOW + skew).toISOString() }))).statusCode, String(skew)).toBe(200);
      }
    });

    it("answers 403 forbidden when website_id is not this deployment's", async () => {
      const r = await post(event({ website_id: "another-site" }));
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ version: "1", error: "forbidden" });
      expect(await count("browser_events")).toBe(0);
    });
  });

  describe("consent policy (EVENT_CONSENT_MODE)", () => {
    it("required (the default): consent not_required answers 403 consent_required and is not stored; granted is stored", async () => {
      expect(testConfig().EVENT_CONSENT_MODE).toBe("required");
      const r = await post(event({ consent: "not_required" }));
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ version: "1", error: "consent_required" });
      expect(await count("browser_events")).toBe(0);
      expect((await post(event({ consent: "granted" }))).statusCode).toBe(200);
      expect((await rows()).map((x) => x.consent)).toEqual(["granted"]);
    });

    it("not_required: both values are accepted and stored as asserted", async () => {
      const lax = await build({ EVENT_CONSENT_MODE: "not_required" });
      try {
        expect((await post(event({ consent: "not_required" }), auth, lax)).json()).toEqual({ version: "1", recorded: true });
        expect((await post(event({ consent: "granted" }), auth, lax)).json()).toEqual({ version: "1", recorded: true });
        expect((await rows()).map((x) => x.consent)).toEqual(["not_required", "granted"]);
        // Other values stay invalid whatever the mode.
        expect((await post(event({ consent: "denied" }), auth, lax)).statusCode).toBe(400);
      } finally {
        await lax.close();
      }
    });
  });

  describe("idempotency by event_id", () => {
    it("a repeated event_id is stored once; the repeat answers recorded:false and changes nothing", async () => {
      const first = event({ type: "page_view", name: "page_view", page_key: "/a" });
      expect((await post(first)).json()).toEqual({ version: "1", recorded: true });
      expect((await post(first)).json()).toEqual({ version: "1", recorded: false });
      // A repeat with different content is still the same event: the first write wins.
      const altered = { ...first, type: "conversion_intent", name: "form_submit", page_key: "/b", occurred_at: new Date(NOW + 1_000).toISOString() };
      expect((await post(altered)).json()).toEqual({ version: "1", recorded: false });
      const stored = await rows();
      expect(stored.length).toBe(1);
      expect(stored[0]).toMatchObject({ event_id: first["event_id"], type: "page_view", name: "page_view", page_key: "/a", occurred_at: new Date(NOW) });
    });

    it("concurrent duplicates over HTTP are stored once and exactly one answer says recorded:true", async () => {
      const dup = event();
      const answers = await Promise.all(Array.from({ length: EVENT_WRITES_MAX_IN_FLIGHT }, () => post(dup)));
      expect(answers.map((a) => a.statusCode)).toEqual(Array(EVENT_WRITES_MAX_IN_FLIGHT).fill(200));
      expect(answers.filter((a) => a.json().recorded === true).length).toBe(1);
      expect(await count("browser_events")).toBe(1);
    });

    it("concurrent duplicates at the store (25 inserts at once on separate connections) are stored once", async () => {
      const rec: BrowserEventRecord = {
        installationId: "inst-test",
        websiteId: "site-test",
        eventId: eventId(),
        type: "engagement",
        name: "engaged_30s",
        pageKey: "/race",
        consent: "granted",
        occurredAt: new Date(NOW),
      };
      const results = await Promise.all(Array.from({ length: 25 }, () => db.events.record(rec)));
      expect(results.filter((x) => x).length).toBe(1);
      expect(await count("browser_events")).toBe(1);
    });
  });

  describe("bounded resources", () => {
    it(`at most ${EVENT_WRITES_MAX_IN_FLIGHT} writes are in flight: one more answers 503 overloaded at once; the slots are freed after each write, including a failed one`, async () => {
      const releases: Array<() => void> = [];
      let fail = false;
      const blocking: EventRepository = {
        record: async () => {
          if (fail) throw new DbError("57P01");
          await new Promise<void>((r) => releases.push(r));
          return true;
        },
        pruneBefore: async () => 0,
      };
      const held = await build({}, blocking);
      try {
        const inFlight = Array.from({ length: EVENT_WRITES_MAX_IN_FLIGHT }, () => post(event(), auth, held));
        while (releases.length < EVENT_WRITES_MAX_IN_FLIGHT) await new Promise((r) => setImmediate(r));
        const over = await post(event(), auth, held);
        expect(over.statusCode).toBe(503);
        expect(over.json()).toEqual({ version: "1", error: "overloaded" });
        for (const r of releases.splice(0)) r();
        expect((await Promise.all(inFlight)).map((a) => a.statusCode)).toEqual(Array(EVENT_WRITES_MAX_IN_FLIGHT).fill(200));
        // A database failure answers 503 not_ready (retryable; the event_id makes the retry safe) and frees its slot.
        fail = true;
        for (let i = 0; i < EVENT_WRITES_MAX_IN_FLIGHT + 2; i++) {
          const r = await post(event(), auth, held);
          expect(r.statusCode).toBe(503);
          expect(r.json()).toEqual({ version: "1", error: "not_ready" });
        }
        fail = false;
        const after = post(event(), auth, held);
        while (releases.length < 1) await new Promise((r) => setImmediate(r));
        releases.splice(0).forEach((r) => r());
        expect((await after).statusCode).toBe(200);
      } finally {
        await held.close();
      }
    });

    it("events have their own rate-limit bucket (RATE_LIMIT_PER_MINUTE): exhausting it never blocks entrances, and the reverse", async () => {
      const limited = await build({ RATE_LIMIT_PER_MINUTE: "3" });
      const entrance = (ip: string) => ({
        contract: "entrance.v1",
        website_id: "site-test",
        ip,
        entrance_id: eventId(),
        occurred_at: new Date(NOW).toISOString(),
        page_key: "/pricing",
        acquisition: "direct",
        eligibility: "tsa-1",
      });
      const postEntrance = () => limited.inject({ method: "POST", url: "/v1/entrances", headers: auth, payload: JSON.stringify(entrance("203.0.113.20")) });
      try {
        const codes: number[] = [];
        for (let i = 0; i < 5; i++) codes.push((await post(event(), auth, limited)).statusCode);
        expect(codes).toEqual([200, 200, 200, 429, 429]);
        const tooMany = await post(event(), auth, limited);
        expect(tooMany.json()).toEqual({ version: "1", error: "rate_limited" });
        // The deployment bucket is untouched by the events above.
        const entranceCodes: number[] = [];
        for (let i = 0; i < 4; i++) entranceCodes.push((await postEntrance()).statusCode);
        expect(entranceCodes).toEqual([200, 200, 200, 429]);
        expect(await count("browser_events")).toBe(3);
      } finally {
        await limited.close();
      }
    });

    it("applies the request body limit (BODY_LIMIT_BYTES): 413 payload_too_large", async () => {
      const r = await post(event({ page_key: `/${"p".repeat(200)}`, pad: "x".repeat(2_000) }));
      expect(r.statusCode).toBe(413);
      expect(await count("browser_events")).toBe(0);
    });
  });

  describe("no IP, header value, event_id or page_key in logs, responses or storage", () => {
    it("the log leak scan is clean for accepted, repeated and rejected event requests, and only allowlisted events and fields appear", async () => {
      const scan = createMemoryLogger();
      const scanned = await buildServer({
        config: testConfig({ EVENTS_ENABLED: "true", AUTH_FAILURE_LIMIT_PER_MINUTE: "100000" }),
        logger: scan,
        runner,
        ping: async () => true,
        now: () => NOW,
        events: db.events,
      });
      await scanned.ready();
      const IP4 = "203.0.113.45";
      const IP6 = "2001:db8::45";
      const PAGE = "/leak-scan-unique-page-key";
      const UA = "LeakScanAgent/9.9 (unique-user-agent-marker)";
      const REF = "https://example.com/unique-referrer-marker";
      const COOKIE = "sid=unique-cookie-marker";
      const leakHeaders = { ...auth, "user-agent": UA, referer: REF, cookie: COOKIE, "x-forwarded-for": `${IP4}, ${IP6}`, "x-real-ip": IP4, forwarded: `for=${IP4}` };
      const ids: string[] = [];
      const send = async (over: Record<string, unknown>, headers: Record<string, string> = leakHeaders) => {
        const b = event({ page_key: PAGE, ...over });
        ids.push(String(b["event_id"]));
        return scanned.inject({ method: "POST", url: EVENTS_ROUTE, headers, payload: JSON.stringify(b), remoteAddress: IP4 });
      };
      try {
        const accepted = await send({});
        expect(accepted.statusCode).toBe(200);
        const repeatId = ids[0]!;
        expect((await send({ event_id: repeatId })).json()).toEqual({ version: "1", recorded: false });
        for (const over of [{ ip: IP4 }, { user_agent: UA }, { referrer: REF }, { type: "bogus_type" }, { consent: "not_required" }, { website_id: "another-site" }, { occurred_at: new Date(NOW - 3_600_000).toISOString() }]) {
          expect((await send(over)).statusCode, JSON.stringify(over)).not.toBe(200);
        }
        expect((await send({}, { ...leakHeaders, authorization: "Bearer wrong-token-unique-marker" })).statusCode).toBe(401);
        for (const r of [accepted]) expect(findLeaks(r.body, [...ids, PAGE, UA, REF, COOKIE, ...ipVariants(IP4), IP6])).toEqual([]);

        const text = JSON.stringify(scan.entries);
        expect(findLeaks(text, [...ids, PAGE, UA, REF, COOKIE, "unique-cookie-marker", "wrong-token-unique-marker", TEST_AUTH_TOKEN, ...ipVariants(IP4), IP6, "2001:db8"])).toEqual([]);
        expect(scan.entries.length).toBeGreaterThan(0);
        for (const e of scan.entries) expect(LOG_EVENTS as readonly string[]).toContain(e["event"]);
        const completed = scan.entries.filter((e) => e["event"] === "request_completed" && e["route"] === EVENTS_ROUTE);
        expect(completed.length).toBe(2);
        for (const e of completed) expect(Object.keys(e).sort()).toEqual(["component", "duration_ms", "event", "http_status", "level", "recorded", "route", "time"]);
        const rejected = scan.entries.filter((e) => e["event"] === "request_rejected" && e["route"] === EVENTS_ROUTE);
        // The last one is the onRequest credential rejection, which carries no reason.
        expect(rejected.map((e) => e["reason"] ?? e["error_code"])).toEqual(["schema", "schema", "schema", "schema", "consent", "website_id", "occurred_at", "unauthorized"]);
        for (const e of rejected) {
          const keys = ["component", "error_code", "event", "http_status", "level", "route", "time", ...(e["reason"] === undefined ? [] : ["reason"])].sort();
          expect(Object.keys(e).sort()).toEqual(keys);
        }

        // Nothing of the headers or any address reached the database either.
        const dbText = await dumpDatabaseText(db.pool);
        expect(findLeaks(dbText, [UA, REF, COOKIE, "unique-cookie-marker", ...ipVariants(IP4), IP6, "2001:db8"])).toEqual([]);
        // No stored value of browser_events looks like a network address.
        for (const row of await rows()) {
          for (const v of Object.values(row)) {
            const s = v instanceof Date ? v.toISOString() : String(v);
            expect(s, s).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
            expect(s, s).not.toMatch(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/i);
          }
        }
      } finally {
        await scanned.close();
      }
    });
  });
});
