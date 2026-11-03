import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IdrOptions } from "../src/index.js";

/** Synthetic test secret: matches the public-repo allowlist pattern (32 chars). */
export const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
export const PUBLIC_IP = "198.51.100.23"; // RFC 5737 documentation range, accepted only with allowDocumentationRanges
export const PUBLIC_IP_V6 = "2001:db8::1234"; // RFC 3849

export const BROWSER_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
};

export function req(path = "/pricing", headers: Record<string, string> = {}, init: { method?: string; host?: string; base?: boolean } = {}): Request {
  const url = `https://${init.host ?? "www.example.com"}${path}`;
  const h = init.base === false ? headers : { ...BROWSER_HEADERS, ...headers };
  return new Request(url, { method: init.method ?? "GET", headers: h });
}

export function baseOptions(over: Partial<IdrOptions> = {}): IdrOptions {
  return {
    resolverUrl: "https://resolver.example.com",
    token: TEST_TOKEN,
    websiteId: "example-site",
    trustPolicy: { mode: "header", name: "x-client-ip" },
    allowDocumentationRanges: true,
    ...over,
  };
}

/** A request carrying a client IP under the default header trust policy. */
export function reqWithIp(path = "/pricing", ip = PUBLIC_IP, headers: Record<string, string> = {}): Request {
  return req(path, { "x-client-ip": ip, ...headers });
}

export function withWaitUntil(request: Request): { request: Request; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  (request as unknown as { waitUntil: (p: Promise<unknown>) => void }).waitUntil = (p) => {
    pending.push(p);
  };
  return { request, pending };
}

export async function settle(pending: Promise<unknown>[]): Promise<void> {
  await Promise.all(pending);
}

/** Strict validator for the frozen entrance.v1 request body (docs/contracts/entrance.v1.md). */
export function validateEntranceV1(body: unknown): string[] {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ["body is not an object"];
  const b = body as Record<string, unknown>;
  const allowed = new Set(["contract", "website_id", "ip", "entrance_id", "occurred_at", "page_key", "acquisition", "eligibility"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) errors.push(`unknown field ${k}`);
  for (const k of allowed) if (!(k in b)) errors.push(`missing field ${k}`);
  const s = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");
  if (b["contract"] !== "entrance.v1") errors.push("contract");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(s("website_id"))) errors.push("website_id");
  if (s("ip").length === 0 || s("ip").length > 64 || !/^[0-9a-f:.]+$/.test(s("ip"))) errors.push("ip");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(s("entrance_id"))) errors.push("entrance_id");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s("occurred_at")) || Number.isNaN(Date.parse(s("occurred_at")))) errors.push("occurred_at");
  const pk = s("page_key");
  if (pk.length < 1 || pk.length > 256 || !pk.startsWith("/") || /[?#\s\u0000-\u001f\u007f]/.test(pk)) errors.push("page_key");
  if (!["direct", "search", "social", "email", "paid", "referral", "internal", "unknown"].includes(s("acquisition"))) errors.push("acquisition");
  if (!/^[a-z0-9][a-z0-9.-]{0,31}$/.test(s("eligibility"))) errors.push("eligibility");
  return errors;
}

/** The canonical vocabulary, read from the contract (not from the package under test). */
export function canonicalVocabulary(): { types: Record<string, string[]> } {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../docs/contracts/event-vocabulary.v1.json"), "utf8")) as { types: Record<string, string[]> };
}

export const EVENT_V1_KEYS = ["consent", "contract", "event_id", "name", "occurred_at", "page_key", "type", "website_id"];

/** Strict validator for the frozen event.v1 resolver request body (docs/contracts/event.v1.md, section 2). */
export function validateEventV1(body: unknown): string[] {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ["body is not an object"];
  const b = body as Record<string, unknown>;
  if (JSON.stringify(Object.keys(b).sort()) !== JSON.stringify(EVENT_V1_KEYS)) errors.push(`keys ${Object.keys(b).sort().join(",")}`);
  const s = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");
  if (b["contract"] !== "event.v1") errors.push("contract");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(s("website_id"))) errors.push("website_id");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(s("event_id"))) errors.push("event_id");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s("occurred_at")) || Number.isNaN(Date.parse(s("occurred_at")))) errors.push("occurred_at");
  const types = canonicalVocabulary().types;
  if (!(types[s("type")] ?? []).includes(s("name"))) errors.push("type/name");
  const pk = s("page_key");
  if (pk.length < 1 || pk.length > 256 || !pk.startsWith("/") || /[?#\s\u0000-\u001f\u007f]/.test(pk)) errors.push("page_key");
  if (b["consent"] !== "granted" && b["consent"] !== "not_required") errors.push("consent");
  return errors;
}
