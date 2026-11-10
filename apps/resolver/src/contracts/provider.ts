/**
 * Provider adapter contract. The adapter is the ONLY code that sees a raw
 * provider response. Everything it returns is allowlisted; it must never
 * include the queried IP, IP ranges, ISP names, geolocation, or raw bodies.
 */

export type ProviderErrorCategory =
  | "auth" // 401/403: key rejected
  | "credits" // 402: insufficient credits
  | "rate_limited" // 429
  | "server" // 5xx
  | "network" // DNS/TCP/TLS failure before or during the request
  | "malformed"; // 2xx but body failed the allowlist schema

export type ProviderOutcome =
  | {
      kind: "resolved";
      /** Canonical lowercase domain from the provider (not yet qualified). */
      domain: string;
      organisationName: string | null;
      /**
       * True when the provider names the organisation as the operator of the address's network (its ISP field
       * equals the organisation). Computed in the adapter; the ISP name itself never leaves it. Absent = false.
       */
      organisationIsNetworkOperator?: boolean;
      /** Provider usage-type code (e.g. "COM", "ISP", "DCH") or null when absent. */
      usageType: string | null;
      /** Credits the provider reported for this call, if present in the response. */
      creditsReported: number | null;
    }
  | { kind: "no_domain"; creditsReported: number | null }
  /** Request was dispatched and the deadline elapsed: billing is uncertain. */
  | { kind: "timeout" }
  | { kind: "error"; category: ProviderErrorCategory; retryAfterMs: number | null };

export interface ProviderAdapter {
  readonly name: string;
  /**
   * Resolve one address. Must respect `signal` and never throw: every failure
   * is mapped to an outcome. The adapter must not log the IP or the body.
   */
  lookup(ip: string, opts: { signal: AbortSignal }): Promise<ProviderOutcome>;
}
