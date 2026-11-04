/**
 * HTTP helpers shared by the development smoke test (src/ops/smoke.ts) and
 * its phases. Nothing here prints anything: callers report statuses and
 * enums only, never a body, header value, token or address.
 */

export interface HttpAnswer {
  status: number;
  text: string;
  headers: Headers;
}

/** One request with a 10 s bound and no redirect following. */
export async function call(base: string, path: string, init: RequestInit = {}): Promise<HttpAnswer> {
  const r = await fetch(`${base}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

/** The JSON object in `text`, or undefined (never throws). */
export function parse(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Headers whose values legitimately differ between two otherwise identical
 * answers: the clock, and the per-deployment rate-limit counters.
 */
const VOLATILE_HEADER = (name: string) => name === "date" || name.startsWith("x-ratelimit-") || name === "retry-after";

/**
 * Whether two answers are the same bytes: status, body and every header
 * (names, and values apart from the volatile ones). Returns the differing
 * parts by name only (`status`, `body`, `header:<name>`), never a value.
 */
export function answerDifferences(a: HttpAnswer, b: HttpAnswer): string[] {
  const diffs: string[] = [];
  if (a.status !== b.status) diffs.push("status");
  if (a.text !== b.text) diffs.push("body");
  const names = new Set<string>();
  a.headers.forEach((_v, k) => names.add(k));
  b.headers.forEach((_v, k) => names.add(k));
  for (const name of [...names].sort()) {
    const va = a.headers.get(name);
    const vb = b.headers.get(name);
    if (va === null || vb === null) diffs.push(`header:${name}`);
    else if (!VOLATILE_HEADER(name) && va !== vb) diffs.push(`header:${name}`);
  }
  return diffs;
}
