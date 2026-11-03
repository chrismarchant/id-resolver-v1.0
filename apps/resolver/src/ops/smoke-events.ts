/**
 * Events phase of the development smoke test (src/ops/smoke.ts, Gate 5):
 * contract event.v1 (docs/contracts/event.v1.md, POST /v1/events) against the
 * running deployment, and proof of owner decision D4 (browser events are
 * never associated with companies) from the outside.
 *
 * Events enabled (EVENTS_ENABLED=true in the smoke's own environment):
 *   - ingestion: a valid event (consent granted, approved vocabulary, page_key
 *     /smoke/<run>/ev) is stored, the same event_id again is not stored twice,
 *     a second event is stored; the response is exactly {version, recorded};
 *   - rejections: no credential and the reporting credential 401; an unknown
 *     field (`ip`) and an out-of-vocabulary name 400; consent not_required
 *     403 consent_required under EVENT_CONSENT_MODE=required (accepted under
 *     not_required); occurred_at outside the 300 s window 400. Each rejected
 *     body carries a fresh event_id and the run's page_key, so a request that
 *     was wrongly stored shows up in the row count below;
 *   - no address appears in any event response (body or header);
 *   - database, read-only, this service only (src/ops/smoke-events-db.ts):
 *     browser_events holds exactly the accepted events of this run, with
 *     exactly the 0008 columns and vocabulary-only values; no company
 *     observation carries the event page_key or appeared for this run during
 *     the event requests; the inserting transactions wrote no other table;
 *     and no cache, company or observation row appeared during the event
 *     requests (inconclusive, reported as skipped, if other resolver traffic
 *     ran at the same time);
 *   - the reporting feed afterwards: no item derived from the events (no
 *     event page_key or event_id anywhere in it, this run's observation count
 *     unchanged) and the reporting-feed.v1 shape exactly.
 * Events disabled: POST /v1/events answers exactly like an unknown route
 * (404 with the website credential, 401 without), byte for byte.
 *
 * Side effects: two (three under EVENT_CONSENT_MODE=not_required) synthetic
 * browser_events rows with page_key /smoke/<run>/ev, pruned by retention like
 * any event. The phase writes no configuration and no switch.
 *
 * Details are statuses, enums and counts only: never a token, address,
 * body, event_id, page_key or configuration value.
 */
import { randomBytes } from "node:crypto";
import { EVENT_VOCABULARY, isVocabularyPair, type EventConsentMode } from "../contracts/event.js";
import type { FeedRead } from "./smoke-feed.js";
import { answerDifferences, parse, type HttpAnswer } from "./smoke-http.js";
import type { SmokeReport } from "./smoke-report.js";
import { BROWSER_EVENT_COLUMNS, NON_EVENT_TABLES, windowVerdict, type EventsDbProbe, type ResolutionSnapshot } from "./smoke-events-db.js";

export const UNKNOWN_ROUTE = "/v1/smoke-unknown-route";
/** An address placed in a rejected body only: it must never come back in any response. */
export const EVENT_PROBE_ADDRESS = "203.0.113.77";
/** Address fragments that must never appear in a response (the smoke's own synthetic addresses). */
export const ADDRESS_NEEDLES = ["203.0.113.", "2001:db8", "10.0.0.1"] as const;
/** Wait after the last event request before the closing snapshot, so a write deferred by the service would land inside the window. */
export const SETTLE_MS = 500;

export const EV = {
  accepted: "events: valid event -> 200 recorded:true",
  keys: "events: response is exactly {version, recorded}",
  repeat: "events: same event_id again -> 200 recorded:false (idempotent)",
  second: "events: second distinct event -> 200 recorded:true",
  noCredential: "events: without credential -> 401",
  reporting: "events: reporting credential rejected -> 401",
  unknownField: "events: unknown field (ip) -> 400 (strict schema)",
  vocabulary: "events: out-of-vocabulary name -> 400",
  consentRequired: "events: consent not_required under EVENT_CONSENT_MODE=required -> 403 consent_required",
  consentNotRequired: "events: consent not_required under EVENT_CONSENT_MODE=not_required -> 200 recorded:true",
  window: "events: occurred_at outside the 300 s window -> 400",
  noAddress: "events: no response carries an address",
  rows: "events db: browser_events holds exactly this run's accepted events",
  columns: "events db: stored rows carry exactly the 0008 columns, vocabulary-only values, no address",
  observations: "events db: no company observation from the event requests (run page_key scoped)",
  sameTransaction: "events db: the event inserts wrote browser_events only (same-transaction check)",
  hwm: "events db: no cache, company or observation row created during the event requests (high-water marks)",
  feed: "events feed: no item derived from the events; run observations unchanged",
  feedShape: "events feed: reporting-feed.v1 shape unchanged",
  disabled: "events disabled: POST /v1/events with the website credential -> 404, byte-identical to an unknown route",
  disabledNoCredential: "events disabled: POST /v1/events without credential -> 401, byte-identical to an unknown route",
} as const;

export const EV_DB_CHECKS = [EV.rows, EV.columns, EV.sameTransaction, EV.observations, EV.hwm] as const;

const ADDRESS_PATTERN = /(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])|(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}/i;
const containsAddress = (text: string) => ADDRESS_NEEDLES.some((n) => text.includes(n)) || text.includes(EVENT_PROBE_ADDRESS);
const answerHasAddress = (a: HttpAnswer) => {
  if (containsAddress(a.text)) return true;
  let found = false;
  a.headers.forEach((v) => {
    if (containsAddress(v)) found = true;
  });
  return found;
};

export interface EventsPhaseDeps {
  report: SmokeReport;
  /** POST a JSON body to `path` on the target with these headers. */
  post: (path: string, headers: Record<string, string>, body: unknown) => Promise<HttpAnswer>;
  websiteAuth: Record<string, string>;
  reportingAuth: Record<string, string>;
  json: Record<string, string>;
  websiteId: string;
  /** This run's id; the event page_key is `/smoke/<run>/ev`. */
  run: string;
  consentMode: EventConsentMode;
  /** Read-only database probe; undefined when the target is not this service. */
  db: EventsDbProbe | undefined;
  /** Reads the whole reporting feed with the reporting credential. */
  readFeed: () => Promise<FeedRead>;
  /** This run's observation items in the feed before the phase (entrance checks). */
  runObservationsBefore: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const newEventId = () => randomBytes(16).toString("base64url");

export function eventPageKey(run: string): string {
  return `/smoke/${run}/ev`;
}

export async function runEventsPhase(deps: EventsPhaseDeps): Promise<void> {
  const { report: rep, post, websiteAuth, reportingAuth, json } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pageKey = eventPageKey(deps.run);
  const event = (type: string, name: string, over: Record<string, unknown> = {}) => ({
    contract: "event.v1",
    website_id: deps.websiteId,
    event_id: newEventId(),
    occurred_at: now().toISOString(),
    type,
    name,
    page_key: pageKey,
    consent: "granted",
    ...over,
  });
  const send = (headers: Record<string, string>, body: unknown) => post("/v1/events", headers, body);
  const answers: HttpAnswer[] = [];
  const track = async (p: Promise<HttpAnswer>) => {
    const a = await p;
    answers.push(a);
    return a;
  };
  /** (type, name, consent) of every event that must be stored, by event_id. */
  const expected = new Map<string, { type: string; name: string; consent: string }>();
  /** Every event_id sent in this phase, stored or not. */
  const sent: string[] = [];
  const describe = (a: HttpAnswer) => {
    const b = parse(a.text);
    return `status ${a.status} recorded=${String(b?.["recorded"])}`;
  };

  const before = deps.db ? await deps.db.snapshot().catch(() => undefined) : undefined;

  // ---- ingestion -------------------------------------------------------------
  const first = event("page_view", "page_view");
  sent.push(first.event_id);
  let a = await track(send(websiteAuth, first));
  let b = parse(a.text);
  const firstOk = a.status === 200 && b?.["recorded"] === true;
  if (firstOk) expected.set(first.event_id, { type: first.type, name: first.name, consent: "granted" });
  rep.check(EV.accepted, firstOk, describe(a));
  rep.check(EV.keys, b !== undefined && JSON.stringify(Object.keys(b).sort()) === JSON.stringify(["recorded", "version"]) && b["version"] === "1", `keys ${b ? Object.keys(b).sort().join(",") : "none"}`);

  // The same request again, as a website retry would send it.
  a = await track(send(websiteAuth, first));
  b = parse(a.text);
  rep.check(EV.repeat, a.status === 200 && b?.["recorded"] === false, describe(a));

  const second = event("engagement", "scroll_50");
  sent.push(second.event_id);
  a = await track(send(websiteAuth, second));
  b = parse(a.text);
  const secondOk = a.status === 200 && b?.["recorded"] === true;
  if (secondOk) expected.set(second.event_id, { type: second.type, name: second.name, consent: "granted" });
  rep.check(EV.second, secondOk, describe(a));

  // ---- rejections (each would add a row if it were wrongly accepted) ----------
  const rejected = (body: Record<string, unknown>) => {
    sent.push(String(body["event_id"]));
    return body;
  };
  a = await track(send(json, rejected(event("page_view", "page_view"))));
  rep.check(EV.noCredential, a.status === 401, `status ${a.status}`);
  a = await track(send({ ...json, ...reportingAuth }, rejected(event("page_view", "page_view"))));
  rep.check(EV.reporting, a.status === 401, `status ${a.status}`);
  a = await track(send(websiteAuth, rejected(event("page_view", "page_view", { ip: EVENT_PROBE_ADDRESS }))));
  rep.check(EV.unknownField, a.status === 400, `status ${a.status}`);
  // A plausible but unapproved name: capturing form values is exactly what the vocabulary excludes.
  if (isVocabularyPair("conversion_intent", "form_value")) throw new Error("smoke: the out-of-vocabulary probe name is in the vocabulary");
  a = await track(send(websiteAuth, rejected(event("conversion_intent", "form_value"))));
  rep.check(EV.vocabulary, a.status === 400, `status ${a.status}`);

  const notRequired = event("conversion_intent", "cta_click", { consent: "not_required" });
  sent.push(notRequired.event_id);
  a = await track(send(websiteAuth, notRequired));
  b = parse(a.text);
  if (deps.consentMode === "required") {
    rep.check(EV.consentRequired, a.status === 403 && b?.["error"] === "consent_required", `status ${a.status} error ${String(b?.["error"])}`);
  } else {
    const ok = a.status === 200 && b?.["recorded"] === true;
    if (ok) expected.set(notRequired.event_id, { type: notRequired.type, name: notRequired.name, consent: "not_required" });
    rep.check(EV.consentNotRequired, ok, describe(a));
  }

  a = await track(send(websiteAuth, rejected(event("page_view", "page_view", { occurred_at: new Date(now().getTime() - 3_600_000).toISOString() }))));
  rep.check(EV.window, a.status === 400, `status ${a.status}`);

  const leaking = answers.filter(answerHasAddress).length;
  rep.check(EV.noAddress, leaking === 0, leaking === 0 ? `clean (${answers.length} responses)` : `${leaking} of ${answers.length} responses`);

  // Events this phase expects stored: the two granted ones, plus the not_required one where the policy accepts it.
  const expectedRows = deps.consentMode === "required" ? 2 : 3;

  // ---- database (read-only, this service only) ----------------------------------
  if (!deps.db) {
    for (const c of EV_DB_CHECKS) rep.skip(c, "target is not this service (its database is not this environment's)");
  } else {
    await sleep(SETTLE_MS);
    await databaseChecks(deps.db, rep, { pageKey, run: deps.run, expected, expectedRows, before, websiteId: deps.websiteId });
  }

  // ---- reporting feed afterwards -----------------------------------------------
  const feed = await deps.readFeed();
  if (!feed.ok) {
    rep.check(EV.feed, false, `feed status ${feed.status}`);
    rep.check(EV.feedShape, false, `feed status ${feed.status}`);
  } else {
    const derived = feed.includes(pageKey) || sent.some((id) => feed.includes(id));
    const runKey = `/smoke/${deps.run}`;
    const ofRun = (p: unknown) => typeof p === "string" && (p === runKey || p.startsWith(`${runKey}/`));
    const runObservations = feed.items.filter((it) => it["type"] === "observation" && ofRun(it["page_key"])).length;
    rep.check(
      EV.feed,
      !derived && runObservations === deps.runObservationsBefore,
      `${derived ? "event page_key or event_id present" : "no event page_key or event_id"}; run observations ${runObservations} (before ${deps.runObservationsBefore})`,
    );
    rep.check(EV.feedShape, feed.shapeProblems.length === 0, feed.shapeProblems.length === 0 ? `exact (${feed.pages} pages)` : `problems ${feed.shapeProblems.join(",")}`);
  }
}

async function databaseChecks(
  db: EventsDbProbe,
  rep: SmokeReport,
  ctx: {
    pageKey: string;
    run: string;
    expected: Map<string, { type: string; name: string; consent: string }>;
    expectedRows: number;
    before: ResolutionSnapshot | undefined;
    websiteId: string;
  },
): Promise<void> {
  const rows = await db.runEvents(ctx.pageKey).catch(() => undefined);
  if (rows === undefined) {
    rep.check(EV.rows, false, "database unreadable");
    rep.check(EV.columns, false, "database unreadable");
  } else {
    const ids = rows.map((r) => String(r.row["event_id"]));
    const exact = rows.length === ctx.expectedRows && ctx.expected.size === ctx.expectedRows && ids.every((id) => ctx.expected.has(id)) && new Set(ids).size === ids.length;
    rep.check(EV.rows, exact, `rows ${rows.length}, expected ${ctx.expectedRows}`);

    const problems = new Set<string>();
    for (const { row } of rows) {
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(BROWSER_EVENT_COLUMNS)) problems.add("columns");
      const want = ctx.expected.get(String(row["event_id"]));
      const type = String(row["type"]);
      const name = String(row["name"]);
      if (!isVocabularyPair(type, name) || !Object.hasOwn(EVENT_VOCABULARY.types, type)) problems.add("vocabulary");
      if (!want || want.type !== type || want.name !== name || want.consent !== row["consent"]) problems.add("values");
      if (row["origin"] !== "browser") problems.add("origin");
      if (row["page_key"] !== ctx.pageKey) problems.add("page_key");
      if (row["website_id"] !== ctx.websiteId) problems.add("scope");
      // No value of any column may look like a network address.
      for (const [k, v] of Object.entries(row)) {
        if (k === "occurred_at" || k === "received_at") continue; // timestamps contain colons, never address groups of hex
        if (typeof v === "string" && ADDRESS_PATTERN.test(v)) problems.add("address");
      }
    }
    rep.check(EV.columns, rows.length > 0 && problems.size === 0, problems.size === 0 ? `columns ${BROWSER_EVENT_COLUMNS.length}, ${rows.length} rows clean` : `problems ${[...problems].sort().join(",")}`);

    // Same-transaction: the transactions that inserted this run's events wrote nothing else.
    const xids = rows.map((r) => r.xid);
    const written = xids.length > 0 ? await db.writtenByTransactions(xids).catch(() => undefined) : undefined;
    if (written === undefined) {
      rep.check(EV.sameTransaction, false, xids.length === 0 ? "no stored event to check" : "database unreadable");
    } else {
      const hits = NON_EVENT_TABLES.filter((t) => written[t] !== 0);
      rep.check(EV.sameTransaction, hits.length === 0, hits.length === 0 ? `${NON_EVENT_TABLES.length} tables clean, ${xids.length} transactions` : `written: ${hits.join(",")}`);
    }
  }

  const after = await db.snapshot().catch(() => undefined);
  if (!ctx.before || !after) {
    rep.check(EV.observations, false, "database unreadable");
    rep.check(EV.hwm, false, "database unreadable");
    return;
  }
  const obs = await db.runObservations(ctx.pageKey, ctx.before.observationsMaxId, `/smoke/${ctx.run}`).catch(() => undefined);
  if (!obs) rep.check(EV.observations, false, "database unreadable");
  else rep.check(EV.observations, obs.withEventPageKey === 0 && obs.runSinceMark === 0, `event page_key ${obs.withEventPageKey}, run rows since mark ${obs.runSinceMark}`);

  const verdict = windowVerdict(ctx.before, after);
  if (verdict.kind === "quiet") rep.check(EV.hwm, true, "no row created");
  else if (verdict.kind === "written_without_resolver_traffic") rep.check(EV.hwm, false, `rows created with no resolver request: ${verdict.grew.join(",")}`);
  else rep.skip(EV.hwm, `inconclusive, concurrent resolver traffic during the window (${verdict.grew.join(",")}); the scoped checks above still apply`);
}

/**
 * Events disabled: POST /v1/events must be indistinguishable from an unknown
 * route, with and without the website credential. `expectStatus` is 404 for
 * a Gate 4 or later build; a rollback target older than Gate 4 answers every
 * authenticated unknown route with 400 and passes `undefined` (any 4xx).
 */
export async function checkEventsAbsent(deps: {
  report: SmokeReport;
  post: (path: string, headers: Record<string, string>, body: unknown) => Promise<HttpAnswer>;
  websiteAuth: Record<string, string>;
  json: Record<string, string>;
  websiteId: string;
  run: string;
  expectStatus: 404 | undefined;
  names?: { withCredential: string; withoutCredential: string };
}): Promise<void> {
  const names = deps.names ?? { withCredential: EV.disabled, withoutCredential: EV.disabledNoCredential };
  const body = {
    contract: "event.v1",
    website_id: deps.websiteId,
    event_id: newEventId(),
    occurred_at: new Date().toISOString(),
    type: "page_view",
    name: "page_view",
    page_key: eventPageKey(deps.run),
    consent: "granted",
  };
  const compare = async (name: string, headers: Record<string, string>, status: number | undefined) => {
    const events = await deps.post("/v1/events", headers, body);
    const unknown = await deps.post(UNKNOWN_ROUTE, headers, body);
    const diffs = answerDifferences(events, unknown);
    const statusOk = status !== undefined ? events.status === status : events.status >= 400 && events.status < 500;
    deps.report.check(
      name,
      diffs.length === 0 && statusOk,
      diffs.length === 0 ? `status ${events.status}, identical to an unknown route` : `status ${events.status} vs ${unknown.status}, differs: ${diffs.join(",")}`,
    );
  };
  await compare(names.withCredential, deps.websiteAuth, deps.expectStatus);
  await compare(names.withoutCredential, deps.json, 401);
}
