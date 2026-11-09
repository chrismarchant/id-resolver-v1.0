import assert from "node:assert/strict";
import { test } from "node:test";

import { toRows } from "../src/rows.mjs";
import { observation } from "./helpers.mjs";

const SYNCED = "2026-11-05T10:00:00.000Z";

test("maps observations to rows with the sync time", () => {
  const { rows, erasedCompanies } = toRows([observation(1, 7)], SYNCED);
  assert.equal(erasedCompanies, 0);
  assert.deepEqual(rows, [
    {
      observation_id: "1",
      company_id: 7,
      domain: "company7.example",
      organisation_name: "Company 7",
      observed_at: "2026-11-05T09:00:00.000Z",
      method: "provider",
      page_key: "/",
      acquisition: "direct",
      entrance_contract: "entrance.v1",
      synced_at: SYNCED,
    },
  ]);
});

test("drops every observation of an erased company, wherever the tombstone sits", () => {
  const items = [
    observation(1, 7),
    observation(2, 8),
    { type: "company_erased", company_id: 7 },
    observation(3, 7),
  ];
  const { rows, erasedCompanies } = toRows(items, SYNCED);
  assert.equal(erasedCompanies, 1);
  assert.deepEqual(rows.map((r) => r.observation_id), ["2"]);
});

test("erasure applies by company id, never by domain", () => {
  const items = [
    observation(1, 7, { domain: "same.example" }),
    { type: "company_erased", company_id: 7 },
    observation(2, 9, { domain: "same.example" }),
  ];
  assert.deepEqual(toRows(items, SYNCED).rows.map((r) => r.observation_id), ["2"]);
});

test("keeps one row per observation id", () => {
  const { rows } = toRows([observation(1, 7), observation(1, 7)], SYNCED);
  assert.equal(rows.length, 1);
});
