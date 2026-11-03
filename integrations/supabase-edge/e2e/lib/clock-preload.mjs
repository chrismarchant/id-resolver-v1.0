// Preloaded with `node --import` into the UNMODIFIED resolver prune command
// (apps/resolver/dist/ops/prune.js) to run it "as if" at a later instant:
// Date.now() starts at E2E_FAKE_NOW_MS and then advances with the real clock.
// prune.js computes its cutoff as Date.now() - OBSERVATION_RETENTION_DAYS, so
// this is exactly the prune that would run at that later instant. The delete
// itself is the resolver's own statement, so the 0006 watermark trigger and
// the 0007 guards apply unchanged (no ad-hoc delete). Test harness only.
const raw = process.env["E2E_FAKE_NOW_MS"];
if (raw === undefined || !/^[0-9]{13}$/.test(raw)) {
  throw new Error("clock-preload: E2E_FAKE_NOW_MS must be epoch milliseconds");
}
const fakeStart = Number(raw);
const realStart = Date.now();
const realNow = Date.now.bind(Date);
Date.now = () => fakeStart + (realNow() - realStart);
