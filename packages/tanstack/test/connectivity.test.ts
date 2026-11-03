import { afterEach, describe, expect, it } from "vitest";
import { checkConnectivity } from "../src/index.js";
import { baseOptions, TEST_TOKEN, validateEntranceV1 } from "./helpers.js";
import { closedPortUrl, startResolver } from "./resolver-fixture.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe("checkConnectivity", () => {
  it("proves URL + token + contract with a documentation-range IP and reports resolver status only", async () => {
    const fx = await startResolver({ kind: "ok", status: "ineligible", recorded: false });
    closers.push(() => fx.close());
    const r = await checkConnectivity(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true, allowDocumentationRanges: false }));
    expect(r).toMatchObject({ ok: true, reason: "delivered", httpStatus: 200, resolverStatus: "ineligible" });
    const body = JSON.parse(fx.captured[0]!.body);
    expect(validateEntranceV1(body)).toEqual([]);
    expect(body.ip).toBe("198.51.100.1");
    expect(body.page_key).toBe("/idr-connectivity-check");
    expect(JSON.stringify(r)).not.toContain("198.51.100");
  });

  it.each([
    [{ kind: "status", code: 401 } as const, "http_4xx", 401],
    [{ kind: "status", code: 403 } as const, "http_4xx", 403],
    [{ kind: "status", code: 400 } as const, "http_4xx", 400],
  ])("diagnoses %j", async (behaviour, reason, status) => {
    const fx = await startResolver(behaviour);
    closers.push(() => fx.close());
    const r = await checkConnectivity(baseOptions({ resolverUrl: fx.url, allowInsecureHttp: true }));
    expect(r).toMatchObject({ ok: false, reason, httpStatus: status });
  });

  it("reports network failure and invalid config without throwing or leaking secrets", async () => {
    const r1 = await checkConnectivity(baseOptions({ resolverUrl: await closedPortUrl(), allowInsecureHttp: true }));
    expect(r1).toMatchObject({ ok: false, reason: "network" });
    const r2 = await checkConnectivity(baseOptions({ token: "short" }));
    expect(r2).toMatchObject({ ok: false, reason: "config_invalid" });
    expect(JSON.stringify([r1, r2])).not.toContain(TEST_TOKEN);
  });
});
