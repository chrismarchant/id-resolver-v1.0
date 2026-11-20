/**
 * IPNetDB prefix database for the watch-only source comparison: download,
 * verification, weekly refresh and lookups.
 *
 * The manifest (IPNETDB_MANIFEST_URL, verified format
 * {"prefix": {"url","file","date","sha256","bytes"}, "asn": {...}}) names the
 * current prefix file; its records carry the prefix and AS entities, so the
 * separate ASN file is not needed. The file (about 200 MB) is streamed to a
 * temporary file in IPNETDB_DIR while its SHA-256 is computed, never held in
 * memory. It is accepted only from https://cdn.ipnetdb.net, at most 400 MB,
 * with exactly the manifest's byte count and SHA-256; anything else deletes
 * the temporary file, keeps the copy in use and logs
 * `ipnetdb_refresh_failed{category}`. A file refused for its content (size,
 * SHA-256, format, host or size bound) is remembered by its manifest entry and
 * not downloaded again until the manifest changes. An accepted file is opened
 * with the asynchronous positional-read reader (src/shadow/mmdb.ts), swapped
 * in, and the previous copy is closed (after the lookups in flight) and deleted.
 *
 * IPNETDB_DIR is created with mode 0700 and refused (`unsafe_dir`) when it is a
 * symbolic link, not owned by this user, or writable by group or others: the
 * verified file is re-opened by its path, so nobody else may be able to swap it.
 *
 * Loading never blocks the service: start() schedules the first check at
 * once, in the background; until a copy is loaded, lookups answer
 * `unavailable`. A check runs once a day and downloads when no copy is loaded,
 * when the manifest is at least 7 days newer than the loaded copy (a weekly
 * cadence), or on a Monday (UTC) when the manifest is newer at all, so the
 * owner's Monday refresh lands on Mondays. While nothing is loaded the check
 * runs hourly, backing off exponentially (up to a day) while it keeps failing.
 * Logs carry dates, byte counts and fixed categories only, never a URL, an
 * address or an entity.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "../log/index.js";
import { DEFAULT_MAX_BODY_BYTES, discardBody, readCappedText } from "../provider/http.js";
import { canonicaliseOrganisationName } from "../resolution/qualify.js";
import { MmdbReader } from "./mmdb.js";
import type { IpnetdbResult } from "./types.js";

export const IPNETDB_FILE_HOST = "cdn.ipnetdb.net";
export const IPNETDB_MAX_BYTES = 400 * 1024 * 1024;
export const IPNETDB_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** While no copy is loaded (first start, or every download failed so far), check again sooner; doubled per consecutive failure, up to a day. */
export const IPNETDB_RETRY_INTERVAL_MS = 60 * 60 * 1000;
export const IPNETDB_REFRESH_AFTER_DAYS = 7;
const MANIFEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_WAIT_MS = 2_000;
const DAY_MS = 86_400_000;

/** Files this loader writes in IPNETDB_DIR; nothing else there is ever touched. */
const OWN_FILE = /^(?:\.prefix-\d{4}-\d{2}-\d{2}-[0-9a-f]{16}\.part|prefix-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}\.mmdb)$/;

export type RefreshFailure =
  | "manifest_fetch"
  | "manifest_invalid"
  | "host_refused"
  | "too_large"
  | "download"
  | "size_mismatch"
  | "sha_mismatch"
  | "invalid_file"
  | "unsafe_dir"
  | "filesystem";

/** Failures caused by the file the manifest names (not by the network): that manifest entry is not tried again. */
const CONTENT_FAILURES: ReadonlySet<RefreshFailure> = new Set(["host_refused", "too_large", "size_mismatch", "sha_mismatch", "invalid_file"]);

/** `skipped`: the manifest still names a file that was refused for its content. */
export type RefreshOutcome = "loaded" | "current" | "skipped" | "failed" | "busy" | "stopped";

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const ManifestSchema = z.object({
  prefix: z.object({
    url: z.string().max(2048),
    date: z.string().regex(DATE),
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    bytes: z.number().int().positive(),
  }),
});

// Only these fields of a record are read; every other field is ignored.
const RecordSchema = z.object({
  prefix_entity: z.string().max(1024).nullish().catch(null),
  as_entity: z.string().max(1024).nullish().catch(null),
  as: z.number().int().min(0).max(4_294_967_295).nullish().catch(null),
  prefix_bogon: z.boolean().nullish().catch(null),
});

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/**
 * Whether a check should download the manifest's file: nothing is loaded; or
 * the manifest is at least IPNETDB_REFRESH_AFTER_DAYS newer than the loaded
 * copy; or it is Monday (UTC) and the manifest is newer at all.
 */
export function shouldDownload(loadedDate: string | null, manifestDate: string, now: Date): boolean {
  if (loadedDate === null) return true;
  const age = dayNumber(manifestDate) - dayNumber(loadedDate);
  if (!(age > 0)) return false;
  return age >= IPNETDB_REFRESH_AFTER_DAYS || now.getUTCDay() === 1;
}

/** Delay before the next check: daily once loaded; while nothing is loaded, hourly, doubled per consecutive failure up to daily. */
export function nextCheckDelay(loaded: boolean, consecutiveFailures: number, checkMs: number, retryMs: number): number {
  if (loaded) return checkMs;
  return Math.min(checkMs, retryMs * 2 ** Math.min(Math.max(0, consecutiveFailures - 1), 20));
}

/** The download host check: https, exactly cdn.ipnetdb.net, default port, no credentials. */
export function acceptedFileUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== IPNETDB_FILE_HOST || url.port !== "" || url.username !== "" || url.password !== "") return null;
  return url;
}

export interface IpnetdbLoaderOptions {
  manifestUrl: string;
  dir: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Upper bound on the file; default IPNETDB_MAX_BYTES (400 MB). */
  maxBytes?: number;
  checkIntervalMs?: number;
  retryIntervalMs?: number;
}

export interface IpnetdbLoader {
  /** Asynchronous (reads the file); never rejects. `unavailable` until a copy is loaded or when the read fails. */
  lookup(canonicalIp: string): Promise<IpnetdbResult>;
  /** Schedules the first check at once (in the background) and the following ones. */
  start(): void;
  /** One check (the scheduler calls it; exposed for tests). Never rejects. */
  refresh(): Promise<RefreshOutcome>;
  /** Clears the schedule, aborts a running download, closes and deletes the loaded copy. */
  stop(): Promise<void>;
  /** Manifest date (YYYY-MM-DD) of the loaded copy, or null. */
  readonly loadedDate: string | null;
}

class RefreshError extends Error {
  constructor(readonly category: RefreshFailure) {
    super(category);
  }
}

interface Loaded {
  reader: MmdbReader;
  date: string;
  path: string;
}

export function createIpnetdbLoader(opts: IpnetdbLoaderOptions): IpnetdbLoader {
  const { logger, dir } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const maxBytes = opts.maxBytes ?? IPNETDB_MAX_BYTES;
  const checkMs = opts.checkIntervalMs ?? IPNETDB_CHECK_INTERVAL_MS;
  const retryMs = opts.retryIntervalMs ?? IPNETDB_RETRY_INTERVAL_MS;
  let current: Loaded | null = null;
  let running: Promise<RefreshOutcome> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let started = false;
  let stopped = false;
  let cleaned = false;
  let failures = 0;
  /** The manifest entry last refused for its content; not downloaded again until the manifest changes. */
  let refused: string | null = null;
  const controller = new AbortController();

  const removeQuietly = async (path: string): Promise<void> => {
    await unlink(path).catch(() => undefined);
  };

  /** Creates IPNETDB_DIR (0700) and refuses one that others could write or swap. */
  const ensureDir = async (): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new RefreshError("filesystem");
    }
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(dir);
    } catch {
      throw new RefreshError("filesystem");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid) || (st.mode & 0o022) !== 0) throw new RefreshError("unsafe_dir");
  };

  /** Removes this loader's leftovers (a crashed download, an older copy) from IPNETDB_DIR; never other files. */
  const cleanup = async (): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (OWN_FILE.test(n) && p !== current?.path) await removeQuietly(p);
    }
  };

  const fetchManifest = async (): Promise<z.infer<typeof ManifestSchema>["prefix"]> => {
    let res: Response;
    try {
      res = await fetchImpl(opts.manifestUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]),
        redirect: "error",
      });
    } catch {
      throw new RefreshError("manifest_fetch");
    }
    if (res.status !== 200) {
      await discardBody(res);
      throw new RefreshError("manifest_fetch");
    }
    let text: string;
    try {
      text = await readCappedText(res, DEFAULT_MAX_BODY_BYTES);
    } catch {
      throw new RefreshError("manifest_fetch");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RefreshError("manifest_invalid");
    }
    const parsed = ManifestSchema.safeParse(json);
    if (!parsed.success || Number.isNaN(dayNumber(parsed.data.prefix.date))) throw new RefreshError("manifest_invalid");
    return parsed.data.prefix;
  };

  /** Streams the file to `tmp`, counting bytes and hashing; throws RefreshError. */
  const download = async (url: URL, expectedBytes: number, expectedSha: string, tmp: string): Promise<void> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]), redirect: "error" });
    } catch {
      throw new RefreshError("download");
    }
    if (res.status !== 200 || !res.body) {
      await discardBody(res);
      throw new RefreshError("download");
    }
    const declared = Number(res.headers.get("content-length"));
    if (res.headers.has("content-length") && Number.isFinite(declared) && declared !== expectedBytes) {
      await discardBody(res);
      throw new RefreshError("size_mismatch");
    }
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(tmp, "wx", 0o600);
    } catch {
      await discardBody(res);
      throw new RefreshError("filesystem");
    }
    const hash = createHash("sha256");
    let total = 0;
    try {
      const reader = res.body.getReader();
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch {
            throw new RefreshError("download");
          }
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > expectedBytes) throw new RefreshError("size_mismatch");
          hash.update(chunk.value);
          let written: number;
          try {
            written = (await fh.write(chunk.value)).bytesWritten;
          } catch {
            throw new RefreshError("filesystem");
          }
          if (written !== chunk.value.byteLength) throw new RefreshError("filesystem");
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      // What is on disk, not what was handed to write(): a short write (a full disk) never passes.
      let onDisk: number;
      try {
        await fh.sync();
        onDisk = (await fh.stat()).size;
      } catch {
        throw new RefreshError("filesystem");
      }
      if (onDisk !== total) throw new RefreshError("filesystem");
    } finally {
      await fh.close().catch(() => undefined);
    }
    if (total !== expectedBytes) throw new RefreshError("size_mismatch");
    if (hash.digest("hex") !== expectedSha.toLowerCase()) throw new RefreshError("sha_mismatch");
  };

  const check = async (): Promise<RefreshOutcome> => {
    await ensureDir();
    if (!cleaned) {
      cleaned = true;
      await cleanup();
    }
    const manifest = await fetchManifest();
    if (!shouldDownload(current?.date ?? null, manifest.date, now())) return "current";
    const entry = `${manifest.date}|${manifest.sha256.toLowerCase()}|${manifest.bytes}|${manifest.url}`;
    if (entry === refused) return "skipped";
    try {
      return await install(manifest);
    } catch (e) {
      if (e instanceof RefreshError && CONTENT_FAILURES.has(e.category)) refused = entry;
      throw e;
    }
  };

  const install = async (manifest: z.infer<typeof ManifestSchema>["prefix"]): Promise<RefreshOutcome> => {
    const url = acceptedFileUrl(manifest.url);
    if (!url) throw new RefreshError("host_refused");
    if (manifest.bytes > maxBytes) throw new RefreshError("too_large");
    const sha = manifest.sha256.toLowerCase();
    const tmp = join(dir, `.prefix-${manifest.date}-${randomBytes(8).toString("hex")}.part`);
    const final = join(dir, `prefix-${manifest.date}-${sha.slice(0, 12)}.mmdb`);
    try {
      await download(url, manifest.bytes, sha, tmp);
      if (stopped) throw new RefreshError("download");
      await rename(tmp, final).catch(() => {
        throw new RefreshError("filesystem");
      });
    } catch (e) {
      await removeQuietly(tmp);
      throw e;
    }
    let reader: MmdbReader;
    try {
      reader = await MmdbReader.open(final);
    } catch {
      await removeQuietly(final);
      throw new RefreshError("invalid_file");
    }
    if (stopped) {
      await reader.close();
      await removeQuietly(final);
      return "stopped";
    }
    // Swap: new lookups use the new copy at once; the old one closes after the lookups still reading it.
    const previous = current;
    current = { reader, date: manifest.date, path: final };
    if (previous) {
      await previous.reader.close();
      if (previous.path !== final) await removeQuietly(previous.path);
    }
    logger.info("ipnetdb_loaded", { date: manifest.date, bytes: manifest.bytes });
    return "loaded";
  };

  const refresh = (): Promise<RefreshOutcome> => {
    if (stopped) return Promise.resolve("stopped");
    if (running) return Promise.resolve("busy");
    const run = check()
      .then((outcome) => {
        if (outcome !== "skipped") failures = 0;
        return outcome;
      })
      .catch((e: unknown): RefreshOutcome => {
        if (stopped) return "stopped";
        failures += 1;
        logger.warn("ipnetdb_refresh_failed", { category: e instanceof RefreshError ? e.category : "filesystem" });
        return "failed";
      })
      .finally(() => {
        running = null;
      });
    running = run;
    return run;
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh().then(() => schedule(nextCheckDelay(current !== null, failures, checkMs, retryMs)));
    }, ms);
    timer.unref();
  };

  return {
    get loadedDate() {
      return current?.date ?? null;
    },
    async lookup(canonicalIp: string): Promise<IpnetdbResult> {
      const c = current;
      if (!c) return { verdict: "unavailable" };
      let record: unknown;
      try {
        record = (await c.reader.lookup(canonicalIp)).record;
      } catch {
        // Closed by a swap or stop, a read error, a corrupt record or the decode budget.
        return { verdict: "unavailable" };
      }
      if (record === null) return { verdict: "not_found" };
      if (typeof record !== "object" || Array.isArray(record)) return { verdict: "unavailable" };
      const r = RecordSchema.safeParse(record);
      if (!r.success) return { verdict: "unavailable" };
      if (r.data.prefix_bogon === true) return { verdict: "bogon" };
      return {
        verdict: "found",
        prefixEntity: canonicaliseOrganisationName(r.data.prefix_entity),
        asEntity: canonicaliseOrganisationName(r.data.as_entity),
        asn: r.data.as ?? null,
      };
    },
    start(): void {
      if (started || stopped) return;
      started = true;
      schedule(0);
    },
    refresh,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      controller.abort();
      if (running) {
        let t: NodeJS.Timeout | undefined;
        await Promise.race([running, new Promise<void>((r) => (t = setTimeout(r, STOP_WAIT_MS)))]);
        clearTimeout(t);
      }
      const c = current;
      current = null;
      if (c) {
        await c.reader.close();
        await removeQuietly(c.path);
      }
    },
  };
}
