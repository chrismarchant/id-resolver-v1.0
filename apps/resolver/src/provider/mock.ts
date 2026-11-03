/**
 * In-process deterministic mock adapter. Outcomes are scripted per canonical
 * IP; unscripted addresses resolve to `no_domain`. It never touches the
 * network and respects the abort signal (an aborted wait yields `timeout`).
 */
import type { ProviderAdapter, ProviderOutcome } from "../contracts/provider.js";

export interface MockScriptEntry {
  outcome: ProviderOutcome;
  /** Simulated latency; if the signal aborts first the result is `timeout`. */
  delayMs?: number;
}

export type MockScript = Record<string, MockScriptEntry>;

/**
 * Default table used when PROVIDER_MODE=mock. Documentation addresses only
 * (RFC 5737 / RFC 3849) and obviously fake organisations.
 */
export const DEFAULT_MOCK_SCRIPT: MockScript = {
  "203.0.113.10": {
    outcome: { kind: "resolved", domain: "example.com", organisationName: "Example Ltd", usageType: "COM", creditsReported: 100 },
  },
  "203.0.113.11": {
    outcome: { kind: "resolved", domain: "example-isp.net", organisationName: "Example Broadband", usageType: "ISP", creditsReported: 100 },
  },
  "203.0.113.12": {
    outcome: { kind: "resolved", domain: "example.org", organisationName: "Example Org", usageType: null, creditsReported: 100 },
  },
  "203.0.113.13": { outcome: { kind: "no_domain", creditsReported: 0 } },
  "2001:db8::10": {
    outcome: { kind: "resolved", domain: "example.edu", organisationName: "Example University", usageType: "EDU", creditsReported: 100 },
  },
  "198.51.100.250": { outcome: { kind: "no_domain", creditsReported: 0 }, delayMs: 60_000 },
  "198.51.100.251": { outcome: { kind: "error", category: "server", retryAfterMs: null } },
  "198.51.100.252": { outcome: { kind: "error", category: "rate_limited", retryAfterMs: 30_000 } },
  "198.51.100.253": { outcome: { kind: "error", category: "auth", retryAfterMs: null } },
  "198.51.100.254": { outcome: { kind: "error", category: "credits", retryAfterMs: null } },
  "198.51.100.249": { outcome: { kind: "error", category: "malformed", retryAfterMs: null } },
};

export interface MockProvider extends ProviderAdapter {
  /** Number of lookups dispatched (for tests). */
  readonly calls: number;
}

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockProvider(
  script: MockScript = DEFAULT_MOCK_SCRIPT,
  fallback: ProviderOutcome = { kind: "no_domain", creditsReported: 0 },
): MockProvider {
  let calls = 0;
  return {
    name: "mock",
    get calls() {
      return calls;
    },
    async lookup(ip: string, { signal }: { signal: AbortSignal }): Promise<ProviderOutcome> {
      calls += 1;
      const entry = Object.prototype.hasOwnProperty.call(script, ip) ? script[ip] : undefined;
      const ok = await wait(entry?.delayMs ?? 0, signal);
      if (!ok) return { kind: "timeout" };
      return structuredClone(entry?.outcome ?? fallback);
    },
  };
}
