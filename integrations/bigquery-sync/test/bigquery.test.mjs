import assert from "node:assert/strict";
import { test } from "node:test";

import { BigQueryError, METADATA_TOKEN_URL, SCHEMA, metadataAccessToken, replaceTable } from "../src/bigquery.mjs";
import { readConfig } from "../src/config.mjs";
import { ENV, json, recordingFetch } from "./helpers.mjs";

const cfg = readConfig(ENV);
const fast = { pollMs: 0, sleep: async () => {} };
const row = { observation_id: "1", company_id: 7, domain: "company7.example", organisation_name: null, observed_at: "2026-11-05T09:00:00.000Z", method: "provider", page_key: "/", acquisition: null, entrance_contract: "entrance.v1", synced_at: "2026-11-05T10:00:00.000Z" };

test("gets an access token from the metadata server", async () => {
  const fetch = recordingFetch(() => json(200, { access_token: "ya29.x", expires_in: 3599 }));
  assert.equal(await metadataAccessToken({ fetch }), "ya29.x");
  assert.equal(fetch.calls[0].url, METADATA_TOKEN_URL);
  assert.equal(fetch.calls[0].init.headers["metadata-flavor"], "Google");
});

test("metadata failures are errors", async () => {
  await assert.rejects(metadataAccessToken({ fetch: recordingFetch(() => json(500, {})) }), BigQueryError);
  await assert.rejects(metadataAccessToken({ fetch: recordingFetch(() => json(200, {})) }), /no access_token/);
});

test("replaces the table with a WRITE_TRUNCATE load job and waits for it", async () => {
  const fetch = recordingFetch((call, n) => (n === 1 ? json(200, { status: { state: "PENDING" } }) : json(200, { status: { state: n === 2 ? "RUNNING" : "DONE" } })));
  const jobId = await replaceTable(cfg, [row, { ...row, observation_id: "2" }], "ya29.x", { fetch, jobId: "job1", ...fast });
  assert.equal(jobId, "job1");

  const upload = fetch.calls[0];
  assert.equal(upload.url, "https://bigquery.googleapis.com/upload/bigquery/v2/projects/example-project/jobs?uploadType=multipart");
  assert.equal(upload.init.headers.authorization, "Bearer ya29.x");
  const boundary = /boundary=(.+)$/.exec(upload.init.headers["content-type"])[1];
  const parts = upload.init.body.split(`--${boundary}`);
  const metadata = JSON.parse(parts[1].split("\r\n\r\n")[1]);
  assert.deepEqual(metadata.jobReference, { projectId: "example-project", jobId: "job1", location: "EU" });
  assert.equal(metadata.configuration.load.writeDisposition, "WRITE_TRUNCATE");
  assert.equal(metadata.configuration.load.createDisposition, "CREATE_NEVER");
  assert.equal(metadata.configuration.load.sourceFormat, "NEWLINE_DELIMITED_JSON");
  assert.deepEqual(metadata.configuration.load.destinationTable, { projectId: "example-project", datasetId: "idr", tableId: "company_visits" });
  assert.deepEqual(metadata.configuration.load.schema.fields, SCHEMA);
  const lines = parts[2].split("\r\n\r\n")[1].replace(/\r\n$/, "").split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l).observation_id), ["1", "2"]);
  assert.match(parts[3], /^--/);

  assert.equal(fetch.calls[1].url, "https://bigquery.googleapis.com/bigquery/v2/projects/example-project/jobs/job1?location=EU");
  assert.equal(fetch.calls.length, 3);
});

test("an empty feed truncates the table instead of loading", async () => {
  const fetch = recordingFetch((call, n) => json(200, n === 1 ? {} : { status: { state: "DONE" } }));
  await replaceTable(cfg, [], "ya29.x", { fetch, jobId: "job2", ...fast });
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(fetch.calls[0].url, "https://bigquery.googleapis.com/bigquery/v2/projects/example-project/jobs");
  assert.equal(body.configuration.query.query, "TRUNCATE TABLE `example-project.idr.company_visits`");
  assert.equal(body.configuration.query.useLegacySql, false);
  assert.equal(body.jobReference.location, "EU");
});

test("a refused job or a failed job is an error", async () => {
  const refused = recordingFetch(() => json(403, { error: { status: "PERMISSION_DENIED", message: "nope" } }));
  await assert.rejects(replaceTable(cfg, [row], "ya29.x", { fetch: refused, ...fast }), /HTTP 403 \(PERMISSION_DENIED: nope\)/);

  const failed = recordingFetch((call, n) => json(200, n === 1 ? {} : { status: { state: "DONE", errorResult: { reason: "invalid", message: "bad row" } } }));
  await assert.rejects(replaceTable(cfg, [row], "ya29.x", { fetch: failed, ...fast }), /failed \(invalid: bad row\)/);
});

test("a job that never finishes is an error", async () => {
  const fetch = recordingFetch(() => json(200, { status: { state: "RUNNING" } }));
  await assert.rejects(replaceTable(cfg, [row], "ya29.x", { fetch, ...fast, maxPolls: 3 }), /did not finish/);
});
