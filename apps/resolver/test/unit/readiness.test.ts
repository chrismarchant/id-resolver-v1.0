/**
 * CHR-66 F6: the cached, single-flight readiness probe in isolation.
 */
import { describe, expect, it } from "vitest";
import { createCachedProbe, READINESS_CACHE_MS } from "../../src/api/readiness.js";

describe("createCachedProbe", () => {
  it("shares one in-flight ping between concurrent callers and reuses the result for the window", async () => {
    let t = 0;
    let calls = 0;
    let release: (ok: boolean) => void = () => undefined;
    const probe = createCachedProbe(
      () => {
        calls += 1;
        return new Promise<boolean>((r) => (release = r));
      },
      { now: () => t },
    );
    const waiting = Array.from({ length: 100 }, () => probe());
    expect(calls).toBe(1);
    release(true);
    expect(await Promise.all(waiting)).toEqual(Array(100).fill(true));
    t += READINESS_CACHE_MS - 1;
    expect(await probe()).toBe(true);
    expect(calls).toBe(1);
    t += 1;
    const next = probe();
    expect(calls).toBe(2);
    release(false);
    expect(await next).toBe(false);
  });

  it("treats a rejecting or non-boolean ping as not ready, never rejects, and caches that too", async () => {
    let t = 0;
    let calls = 0;
    const probe = createCachedProbe(
      async () => {
        calls += 1;
        throw new Error("injected failure");
      },
      { now: () => t },
    );
    await expect(probe()).resolves.toBe(false);
    await expect(probe()).resolves.toBe(false);
    expect(calls).toBe(1);
    const odd = createCachedProbe(async () => "yes" as unknown as boolean, { now: () => t });
    await expect(odd()).resolves.toBe(false);
  });

  it("a clock that moves backwards never extends the cache", async () => {
    let t = 10_000;
    let calls = 0;
    const probe = createCachedProbe(
      async () => {
        calls += 1;
        return true;
      },
      { now: () => t },
    );
    await probe();
    t -= 5_000;
    await probe();
    expect(calls).toBe(2);
  });
});
