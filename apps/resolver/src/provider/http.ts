/**
 * Shared HTTP helpers for the outbound adapters (Enrich, and the watch-only
 * source comparison in src/shadow/). A response body is read with a hard byte
 * cap and never buffered beyond it; the text is returned to the adapter that
 * parses it and is never logged or embedded in an error.
 */

/** 64 KiB: far above any answer an IP lookup returns, small enough that a hostile body cannot hurt. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** The body is (or declares itself) larger than the cap. Carries no part of the body. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("response body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads the whole body as UTF-8, refusing (BodyTooLargeError) a declared
 * Content-Length above `maxBytes` before reading anything, and cancelling the
 * stream as soon as more than `maxBytes` arrive. Other failures (an aborted or
 * broken stream) propagate as thrown by the stream.
 */
export async function readCappedText(res: Response, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Discards a body that will not be read (frees the connection); never throws. */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}
