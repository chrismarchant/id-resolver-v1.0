/**
 * HMAC-SHA-256 fingerprint over an unambiguous length-prefixed encoding of
 * (installation_id, website_id, canonical_ip). The output is protected
 * pseudonymous data: it never leaves the resolver and is never returned to
 * the website. It is not reversible encryption and is not "anonymous".
 */
import { createHmac } from "node:crypto";

export const FINGERPRINT_DOMAIN = "id-resolver/ip-fingerprint/v1";

function lengthPrefixed(parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    chunks.push(len, b);
  }
  return Buffer.concat(chunks);
}

export function decodeSecret(secret: string): Buffer {
  // Accept hex (64+ chars) or base64url; fall back to utf8 bytes.
  if (/^[0-9a-fA-F]{64,}$/.test(secret) && secret.length % 2 === 0) return Buffer.from(secret, "hex");
  if (/^[A-Za-z0-9_-]{43,}$/.test(secret)) return Buffer.from(secret, "base64url");
  return Buffer.from(secret, "utf8");
}

export function computeFingerprint(
  secretBytes: Buffer,
  installationId: string,
  websiteId: string,
  canonicalIp: string,
): Buffer {
  const h = createHmac("sha256", secretBytes);
  h.update(lengthPrefixed([FINGERPRINT_DOMAIN, installationId, websiteId, canonicalIp]));
  return h.digest();
}
