/**
 * Provider factory: selects the live Enrich adapter, the in-process mock, or
 * a disabled adapter that never dispatches anything.
 *
 * To exercise the HTTP path end-to-end against `npm run mock-provider`, use
 * mode "live" with base_url pointing at the mock server (loopback only may
 * use plain http).
 */
import type { PipelineConfig } from "../contracts/runtime.js";
import type { ProviderAdapter } from "../contracts/provider.js";
import { createEnrichAdapter } from "./enrich.js";
import { createMockProvider, type MockScript } from "./mock.js";

export type ProviderInput = Pick<PipelineConfig["provider"], "mode" | "base_url" | "api_key" | "auth_header">;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const disabledProvider: ProviderAdapter = {
  name: "disabled",
  // Never reached by the pipeline (it checks the mode first); fails closed.
  lookup: async () => ({ kind: "error", category: "server", retryAfterMs: null }),
};

export function createProvider(
  input: ProviderInput,
  opts: { mockScript?: MockScript; fetchImpl?: typeof fetch } = {},
): ProviderAdapter {
  switch (input.mode) {
    case "disabled":
      return disabledProvider;
    case "mock":
      return createMockProvider(opts.mockScript);
    case "live": {
      const url = new URL(input.base_url);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
        throw new Error("provider base url must use https");
      }
      if (input.api_key.length === 0) throw new Error("provider api key missing");
      return createEnrichAdapter({
        baseUrl: input.base_url,
        apiKey: input.api_key,
        authHeader: input.auth_header,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    default:
      return disabledProvider;
  }
}
