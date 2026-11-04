/**
 * Schema 8 guards in idr_apply_feed_page (docs/GUARDRAILS.md):
 *   G7 erasure propagation: an observation of a company already tombstoned for
 *      the installation is ignored, so nothing can resurrect an erased company;
 *   G5 page_key guard: a page_key that fails the resolver's own rule
 *      (migration 0005) is not stored; the observation is kept with null.
 * Neither halts the sync: the page applies, the cursor advances, and the
 * result counts what was ignored or cleared. Positive and negative cases, at
 * the SQL function and through the engine.
 */
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isValidPageKey as resolverIsValidPageKey } from "../../../apps/resolver/src/contracts/api.ts";
import { codePointLength, isResolverPageKey, parseFeedPage, runSync } from "../src/core/index.ts";
import { INSTALLATION, PgStore, asRole, counts, newPool, resetDatabase, storedCursor, truncateAll } from "./helpers/db.ts";
import { MockResolver, obs, tomb } from "./helpers/mock-resolver.ts";
import { testConfig, testDeps } from "./helpers/setup.ts";

const D = "2026-11-02T12:00:00.000Z";
let pool: pg.Pool;
const mock = new MockResolver();

beforeAll(async () => {
  pool = newPool();
  await resetDatabase(pool);
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
  await pool.end();
});
beforeEach(async () => {
  mock.reset();
  await truncateAll(pool);
});

type Item = Record<string, unknown>;
interface Applied {
  applied: boolean;
  observations: number;
  tombstones: number;
  ignored_erased: number;
  page_keys_cleared: number;
}

/** One page through the real function, as service_role, compare-and-set on the stored cursor. */
async function apply(items: Item[], installation = INSTALLATION): Promise<Applied> {
  const st = await pool.query<{ cursor: string | null }>("select cursor from public.idr_sync_state where installation_id = $1", [installation]);
  const expected = st.rows[0]?.cursor ?? null;
  const next = `c${Number((expected ?? "c0").slice(1)) + 1}`;
  const r = await asRole(pool, "service_role", (c) =>
    c.query<{ r: Applied }>("select public.idr_apply_feed_page($1, $2, $3, $4::jsonb, null) as r", [installation, expected, next, JSON.stringify(items)]),
  );
  return r.rows[0]!.r;
}

const companyIds = async () => (await pool.query<{ id: number }>("select company_id::int as id from public.idr_companies order by 1")).rows.map((r) => r.id);
const obsIds = async () => (await pool.query<{ id: number }>("select observation_id::int as id from public.idr_observations order by 1")).rows.map((r) => r.id);

describe("G7: erasure propagation", () => {
  it("a stale page re-applied after the tombstone cannot resurrect the erased company", async () => {
    expect(await apply([obs(1, 7, D), obs(2, 8, D)])).toMatchObject({ applied: true, observations: 2, ignored_erased: 0 });
    expect(await apply([tomb(1, 7)])).toMatchObject({ applied: true, tombstones: 1 });
    expect(await companyIds()).toEqual([8]);
    // The same observations again (at-least-once delivery, or a replay): company 7's are ignored, 8 is untouched.
    const again = await apply([obs(1, 7, D), obs(3, 7, D), obs(2, 8, D), obs(4, 8, D)]);
    expect(again).toMatchObject({ applied: true, observations: 1, ignored_erased: 2 });
    expect(await companyIds()).toEqual([8]);
    expect(await obsIds()).toEqual([2, 4]);
    expect(await storedCursor(pool)).toBe("c3");
  });

  it("within one page: an observation after its company's tombstone is ignored; one before it is removed by the tombstone", async () => {
    const r = await apply([obs(1, 7, D), tomb(1, 7), obs(2, 7, D), obs(3, 9, D)]);
    expect(r).toMatchObject({ applied: true, observations: 2, tombstones: 1, ignored_erased: 1 });
    expect(await companyIds()).toEqual([9]);
    expect(await obsIds()).toEqual([3]);
  });

  it("negative controls: re-observation under a NEW company id is applied, and another installation's tombstone does not apply here", async () => {
    await apply([obs(1, 7, D), tomb(1, 7)]);
    // The resolver gives a re-observed domain a new company id: an ordinary item.
    expect(await apply([obs(2, 70, D, { domain: "company7.example.com" })])).toMatchObject({ observations: 1, ignored_erased: 0 });
    // Company 7 erased in another installation only: still applied in this one.
    await apply([obs(10, 5, D), tomb(9, 5)], "inst_other");
    expect(await apply([obs(11, 5, D)])).toMatchObject({ observations: 1, ignored_erased: 0 });
    expect(await companyIds()).toEqual([5, 70]);
    expect((await counts(pool)).tombstones).toBe(2);
  });

  it("through the engine: a resync replays the stream from the start and the erased company stays erased", async () => {
    mock.items = [obs(1, 7, D), obs(2, 8, D), tomb(1, 7)];
    const store = new PgStore(pool);
    expect((await runSync(testConfig(mock), testDeps(store))).status).toBe("ok");
    expect(await companyIds()).toEqual([8]);
    // The resolver deleted company 7's observations on erasure, but a stale copy of the first page (for example
    // from a cache or a consumer bug) is served again on the replay, after the tombstone was applied.
    await pool.query("select public.idr_begin_resync($1)", [INSTALLATION]);
    mock.items = [obs(1, 7, D), obs(2, 8, D), tomb(1, 7), obs(3, 7, D)];
    const r = await runSync(testConfig(mock), testDeps(store));
    expect(r.status).toBe("ok");
    // The count reaches the run result (and the handler's response and log line): obs 1 and 3 of company 7.
    expect(r).toMatchObject({ ignoredErased: 2, pageKeysCleared: 0 });
    expect(await companyIds()).toEqual([8]);
    expect(await obsIds()).toEqual([2]);
  });
});

describe("G5: page_key guard (the resolver's rule, migration 0005)", () => {
  const VALID = ["/", "/pricing", "/blog/:slug", "/a/b-c_d.e~f", "/%7Euser", `/${"a".repeat(255)}`, "/café"];
  const INVALID: Array<[string, string]> = [
    ["a query string", "/checkout?email=someone"],
    ["a fragment", "/page#token"],
    ["a space", "/a b"],
    ["a tab", "/a\tb"],
    ["a newline", "/a\nb"],
    ["a control character", "/a\u0001b"],
    ["no leading slash", "no-leading-slash"],
    ["an absolute URL", "https://www.example.com/pricing"],
    ["the empty string", ""],
    ["257 characters", `/${"a".repeat(256)}`],
  ];

  it("every value the resolver accepts is stored unchanged", async () => {
    const r = await apply(VALID.map((k, i) => obs(i + 1, 7, D, { page_key: k })));
    expect(r).toMatchObject({ applied: true, observations: VALID.length, page_keys_cleared: 0 });
    const stored = (await pool.query<{ k: string }>("select page_key as k from public.idr_observations order by observation_id")).rows.map((x) => x.k);
    expect(stored).toEqual(VALID);
    // null stays null (older contract).
    expect(await apply([obs(100, 7, D, { page_key: null })])).toMatchObject({ observations: 1, page_keys_cleared: 0 });
  });

  it.each(INVALID)("%s: the observation is kept with page_key null, the page applies and the cursor advances", async (_name, key) => {
    const r = await apply([obs(1, 7, D, { page_key: key }), obs(2, 7, D, { page_key: "/ok" })]);
    expect(r).toMatchObject({ applied: true, observations: 2, page_keys_cleared: 1 });
    const rows = (await pool.query<{ id: number; k: string | null }>("select observation_id::int as id, page_key as k from public.idr_observations order by 1")).rows;
    expect(rows).toEqual([
      { id: 1, k: null },
      { id: 2, k: "/ok" },
    ]);
    expect(await storedCursor(pool)).toBe("c1");
    // Nothing of the value is stored anywhere in the projection.
    if (key.length > 1) {
      const dump = JSON.stringify((await pool.query("select * from public.idr_observations")).rows);
      expect(dump).not.toContain(key);
    }
  });

  // Code points, not UTF-16 code units (the resolver's unit: isValidPageKey counts Array.from, migration 0005
  // char_length). A character outside the Basic Multilingual Plane is one code point and two UTF-16 units.
  const ASTRAL = "\u{1F600}";
  const astralKey = (codePoints: number) => `/${ASTRAL.repeat(codePoints - 1)}`;

  it("the units: an astral key of 256 code points is 511 UTF-16 units; the resolver accepts it, and 257 it refuses", () => {
    expect(codePointLength(astralKey(256))).toBe(256);
    expect(astralKey(256).length).toBe(511);
    expect(resolverIsValidPageKey(astralKey(256))).toBe(true);
    expect(resolverIsValidPageKey(astralKey(257))).toBe(false);
  });

  it("the validator applies exactly the resolver's rule (differential, over valid, boundary and invalid keys)", () => {
    const corpus = [
      ...VALID,
      ...INVALID.map(([, k]) => k),
      astralKey(150),
      astralKey(256),
      astralKey(257),
      `/${"\u00e9".repeat(255)}`,
      `/${"\u00e9".repeat(256)}`,
      `/${"a".repeat(254)}${ASTRAL}`,
      `/${"a".repeat(255)}${ASTRAL}`,
      "/a\u00a0b", // no-break space (\s)
      "/a\u2028b", // line separator
      "/a\u0085b", // NEL (a C1 control)
      "/a\ufeffb", // BOM (\s in JavaScript)
      "/a\ud800b", // lone high surrogate
      "/a\udc00b", // lone low surrogate
      "/\u{10FFFF}",
      "//",
      "/%3F",
    ];
    for (const k of corpus) expect(isResolverPageKey(k), JSON.stringify(k)).toBe(resolverIsValidPageKey(k));
  });

  it("the reviewer's case: 150 emoji (151 code points, 301 UTF-16 units) is a valid page, not a contract error", () => {
    const key = astralKey(151);
    expect(key.length).toBe(301);
    const page = parseFeedPage({ version: "1", contract: "reporting-feed.v1", scope: { installation_id: INSTALLATION }, items: [obs(1, 7, D, { page_key: key })], next_cursor: "c1", has_more: false }, INSTALLATION);
    expect(page).not.toBeNull();
    expect(page!.pageKeysCleared).toBe(0);
    expect(page!.items[0]).toMatchObject({ page_key: key });
  });

  it("through the engine: astral keys at the boundary; 256 code points stored unchanged, 257 cleared (G5), never a halt", async () => {
    const k256 = astralKey(256);
    const k257 = astralKey(257);
    mock.items = [obs(1, 7, D, { page_key: astralKey(151) }), obs(2, 7, D, { page_key: k256 }), obs(3, 7, D, { page_key: k257 }), obs(4, 7, D, { page_key: `/${"a".repeat(256)}` })];
    const r = await runSync(testConfig(mock), testDeps(new PgStore(pool)));
    expect(r).toMatchObject({ status: "ok", pages: 2, observations: 4, pageKeysCleared: 2 });
    const rows = (await pool.query<{ id: number; k: string | null; n: number | null }>("select observation_id::int as id, page_key as k, char_length(page_key) as n from public.idr_observations order by 1")).rows;
    expect(rows).toEqual([
      { id: 1, k: astralKey(151), n: 151 },
      { id: 2, k: k256, n: 256 },
      { id: 3, k: null, n: null },
      { id: 4, k: null, n: null },
    ]);
    expect(await storedCursor(pool)).toBe("c4");
    // A replay of the same stream (at-least-once) changes nothing and still does not halt.
    await pool.query("select public.idr_begin_resync($1)", [INSTALLATION]);
    const again = await runSync(testConfig(mock), testDeps(new PgStore(pool)));
    expect(again).toMatchObject({ status: "ok", observations: 0, pageKeysCleared: 2 });
    expect((await pool.query("select observation_id::int as id, page_key as k from public.idr_observations order by 1")).rows).toEqual(rows.map(({ id, k }) => ({ id, k })));
  });

  it("through the engine: a page of resolver-valid keys only never halts and stores every key unchanged", async () => {
    const keys = [...VALID, astralKey(2), astralKey(129), astralKey(256), `/${"\u00e9".repeat(255)}`, `/${"a".repeat(255)}`];
    for (const k of keys) expect(resolverIsValidPageKey(k), k).toBe(true);
    mock.items = keys.map((k, i) => obs(i + 1, 7, D, { page_key: k }));
    const r = await runSync(testConfig(mock, { pageLimit: 5 }), testDeps(new PgStore(pool)));
    expect(r).toMatchObject({ status: "ok", observations: keys.length, pageKeysCleared: 0 });
    expect((await pool.query<{ k: string }>("select page_key as k from public.idr_observations order by observation_id")).rows.map((x) => x.k)).toEqual(keys);
  });

  it("a page_key that is not a string is still a contract violation (the type is the contract)", async () => {
    for (const bad of [42, true, ["/a"], { p: "/a" }]) {
      mock.reset();
      mock.items = [obs(1, 7, D, { page_key: bad })];
      expect((await runSync(testConfig(mock), testDeps(new PgStore(pool)))).status, JSON.stringify(bad)).toBe("contract_error");
    }
    expect(await storedCursor(pool)).toBeNull();
  });

  it("organisation_name is bounded in code points too (the resolver caps it at 200 code points)", () => {
    const page = (name: string) =>
      parseFeedPage({ version: "1", contract: "reporting-feed.v1", scope: { installation_id: INSTALLATION }, items: [obs(1, 7, D, { organisation_name: name })], next_cursor: "c1", has_more: false }, INSTALLATION);
    // 512 astral code points are 1024 UTF-16 units: accepted (the earlier UTF-16 bound refused anything over 512 units).
    expect(page(ASTRAL.repeat(512))?.items[0]).toMatchObject({ organisation_name: ASTRAL.repeat(512) });
    expect(page(ASTRAL.repeat(200))).not.toBeNull();
    // Over the bound is still a contract violation, as before.
    expect(page(ASTRAL.repeat(513))).toBeNull();
    expect(page("a".repeat(513))).toBeNull();
  });

  it("through the engine: an invalid page_key does not halt the sync (status ok, value not stored)", async () => {
    mock.items = [obs(1, 7, D, { page_key: "/reset?token=abc" }), obs(2, 7, D, { page_key: "/ok" })];
    const r = await runSync(testConfig(mock), testDeps(new PgStore(pool)));
    expect(r.status).toBe("ok");
    expect(r).toMatchObject({ observations: 2, pageKeysCleared: 1, ignoredErased: 0 });
    const rows = (await pool.query<{ k: string | null }>("select page_key as k from public.idr_observations order by observation_id")).rows;
    expect(rows.map((x) => x.k)).toEqual([null, "/ok"]);
  });
});
