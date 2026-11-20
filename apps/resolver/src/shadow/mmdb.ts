/**
 * Minimal MaxMind DB (MMDB format 2) reader for the IPNetDB prefix database.
 * No dependency, asynchronous, and the file is NOT loaded into memory: the
 * reader keeps an open FileHandle and reads only the bytes a lookup needs with
 * positional reads (fs/promises FileHandle.read, never a synchronous read, so
 * a lookup never blocks the event loop on disk), through a small page cache
 * (at most PAGE_CACHE_PAGES x 4 KiB; concurrent reads of one page are shared).
 * The real prefix file is about 200 MB; the service has a 500 MB memory limit.
 *
 * Supported: record sizes 24, 28 and 32; ip_version 4 and 6 search trees,
 * with IPv4 lookups in an IPv6 tree through the IPv4 subtree (the node after
 * 96 leading zero bits, computed once); the data section types pointer, utf8
 * string, double, bytes, uint16, uint32, map, int32, uint64, uint128, array,
 * boolean and float. uint64 and uint128 values above Number.MAX_SAFE_INTEGER
 * are returned as bigint.
 *
 * Bounds against a corrupt or hostile file: nesting depth (pointers included)
 * and, per decode (one lookup's record, or the metadata at open), a work
 * budget counted across pointer expansions: at most DECODE_MAX_VALUES decoded
 * values and DECODE_MAX_BYTES of string and bytes data. Pointers make the data
 * a graph, so without the budget a small file could expand exponentially.
 *
 * Specification: https://maxmind.github.io/MaxMind-DB/. Every error rejects
 * with MmdbError and a fixed message (never an address or file content);
 * callers treat any rejection as "unavailable".
 */
import { open, type FileHandle } from "node:fs/promises";
import ipaddr from "ipaddr.js";

export class MmdbError extends Error {
  constructor(message: string) {
    super(`mmdb: ${message}`);
    this.name = "MmdbError";
  }
}

export const METADATA_MARKER = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from("MaxMind.com", "ascii")]);
/** The metadata section is at most 128 KiB from the end of the file. */
export const METADATA_MAX_BYTES = 128 * 1024;
const DATA_SECTION_SEPARATOR = 16;
const PAGE_BYTES = 4096;
export const PAGE_CACHE_PAGES = 256;
/** Per decode (one record or the metadata), across pointer expansions. */
export const DECODE_MAX_VALUES = 10_000;
export const DECODE_MAX_BYTES = 1024 * 1024;
/** Nesting depth, pointers included (a pointer cycle ends here). */
export const DECODE_MAX_DEPTH = 64;

export interface MmdbMetadata {
  nodeCount: number;
  recordSize: 24 | 28 | 32;
  ipVersion: 4 | 6;
  databaseType: string;
  buildEpoch: number | null;
  binaryFormatMajorVersion: number;
}

export interface MmdbLookup {
  /** The decoded record, or null when the address is in no network of the database. */
  record: unknown;
  /** Prefix length of the network holding the address (for IPv4 in an IPv6 tree: of the IPv4 part, 0-32). */
  prefixLength: number;
}

type Decoded = [value: unknown, next: number];

interface Budget {
  values: number;
  bytes: number;
}

const newBudget = (): Budget => ({ values: DECODE_MAX_VALUES, bytes: DECODE_MAX_BYTES });

export class MmdbReader {
  private fh: FileHandle | null;
  readonly fileBytes: number;
  private meta: MmdbMetadata | null = null;
  private treeBytes = 0;
  private dataStart = 0;
  private dataEnd = 0;
  private nodeBytes = 0;
  private ipv4Start: Promise<number> | null = null;
  private readonly pages = new Map<number, Buffer>();
  private readonly loading = new Map<number, Promise<Buffer>>();
  private active = 0;
  private closing: Promise<void> | null = null;
  private onIdle: (() => void) | null = null;

  private constructor(fh: FileHandle, fileBytes: number) {
    this.fh = fh;
    this.fileBytes = fileBytes;
  }

  /** Opens and validates a database file. Rejects with MmdbError. Keeps the file open until close(). */
  static async open(path: string): Promise<MmdbReader> {
    let fh: FileHandle;
    try {
      fh = await open(path, "r");
    } catch {
      throw new MmdbError("cannot open file");
    }
    let reader: MmdbReader | null = null;
    try {
      reader = new MmdbReader(fh, (await fh.stat()).size);
      await reader.loadMetadata();
      return reader;
    } catch (e) {
      if (reader) await reader.close();
      else await fh.close().catch(() => undefined);
      throw e instanceof MmdbError ? e : new MmdbError("unreadable file");
    }
  }

  get metadata(): MmdbMetadata {
    if (!this.meta) throw new MmdbError("not open");
    return this.meta;
  }

  /** True once close() was called (lookups then reject). */
  get closed(): boolean {
    return this.closing !== null;
  }

  /** Refuses new lookups, waits for those in flight, then closes the file. Idempotent. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.active > 0) await new Promise<void>((r) => (this.onIdle = r));
      const fh = this.fh;
      this.fh = null;
      this.pages.clear();
      await fh?.close().catch(() => undefined);
    })();
    return this.closing;
  }

  /** Looks up a canonical IPv4 or IPv6 address. Rejects with MmdbError (closed, IPv6 in an IPv4 tree, corrupt file, budget). */
  async lookup(ip: string): Promise<MmdbLookup> {
    if (this.closing || !this.fh) throw new MmdbError("closed");
    let bytes: number[];
    try {
      bytes = ipaddr.parse(ip).toByteArray();
    } catch {
      throw new MmdbError("not an address");
    }
    this.active += 1;
    try {
      return await this.find(bytes);
    } catch (e) {
      throw e instanceof MmdbError ? e : new MmdbError("read failed");
    } finally {
      this.active -= 1;
      if (this.active === 0 && this.onIdle) {
        const idle = this.onIdle;
        this.onIdle = null;
        idle();
      }
    }
  }

  private async find(bytes: number[]): Promise<MmdbLookup> {
    const m = this.metadata;
    const bitCount = bytes.length * 8;
    let node: number;
    if (bitCount === 32 && m.ipVersion === 6) node = await this.ipv4StartNode();
    else if (bitCount === 128 && m.ipVersion === 4) throw new MmdbError("IPv6 lookup in an IPv4 database");
    else node = 0;
    let i = 0;
    while (i < bitCount && node < m.nodeCount) {
      const bit = ((bytes[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
      node = await this.readNode(node, bit);
      i += 1;
    }
    if (node === m.nodeCount) return { record: null, prefixLength: i };
    if (node < m.nodeCount) throw new MmdbError("invalid node in search tree");
    const offset = this.dataStart + (node - m.nodeCount - DATA_SECTION_SEPARATOR);
    if (offset < this.dataStart || offset >= this.dataEnd) throw new MmdbError("record pointer outside the data section");
    const [record] = await this.decode(offset, this.dataStart, 0, this.dataEnd, newBudget());
    return { record, prefixLength: i };
  }

  private async loadMetadata(): Promise<void> {
    const tailBytes = Math.min(this.fileBytes, METADATA_MAX_BYTES);
    const tail = await this.readDirect(this.fileBytes - tailBytes, tailBytes);
    const at = tail.lastIndexOf(METADATA_MARKER);
    if (at < 0) throw new MmdbError("metadata marker not found");
    const markerPos = this.fileBytes - tailBytes + at;
    const metaStart = markerPos + METADATA_MARKER.length;
    const [meta] = await this.decode(metaStart, metaStart, 0, this.fileBytes, newBudget());
    const m = parseMetadata(meta);
    this.nodeBytes = (m.recordSize * 2) / 8;
    this.treeBytes = this.nodeBytes * m.nodeCount;
    this.dataStart = this.treeBytes + DATA_SECTION_SEPARATOR;
    this.dataEnd = markerPos;
    if (this.dataStart > this.dataEnd) throw new MmdbError("search tree larger than the file");
    this.meta = m;
  }

  private ipv4StartNode(): Promise<number> {
    if (!this.ipv4Start) {
      const walk = (async () => {
        let node = 0;
        for (let i = 0; i < 96 && node < this.metadata.nodeCount; i += 1) node = await this.readNode(node, 0);
        return node;
      })();
      this.ipv4Start = walk;
      // A failed walk (a read error) is not cached.
      walk.catch(() => {
        if (this.ipv4Start === walk) this.ipv4Start = null;
      });
    }
    return this.ipv4Start;
  }

  private async readNode(node: number, bit: number): Promise<number> {
    const b = await this.read(node * this.nodeBytes, this.nodeBytes, this.treeBytes);
    switch (this.metadata.recordSize) {
      case 24:
        return bit === 0 ? (b[0]! << 16) | (b[1]! << 8) | b[2]! : (b[3]! << 16) | (b[4]! << 8) | b[5]!;
      case 28:
        return bit === 0 ? ((b[3]! & 0xf0) << 20) | (b[0]! << 16) | (b[1]! << 8) | b[2]! : ((b[3]! & 0x0f) << 24) | (b[4]! << 16) | (b[5]! << 8) | b[6]!;
      default:
        return b.readUInt32BE(bit === 0 ? 0 : 4);
    }
  }

  // ---- bytes -------------------------------------------------------------------

  private async readDirect(pos: number, len: number): Promise<Buffer> {
    const fh = this.fh;
    if (!fh) throw new MmdbError("closed");
    const buf = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const { bytesRead } = await fh.read(buf, done, len - done, pos + done);
      if (bytesRead <= 0) throw new MmdbError("unexpected end of file");
      done += bytesRead;
    }
    return buf;
  }

  private page(index: number): Promise<Buffer> {
    const hit = this.pages.get(index);
    if (hit) {
      // Least recently used order: a hit moves to the end.
      this.pages.delete(index);
      this.pages.set(index, hit);
      return Promise.resolve(hit);
    }
    const pending = this.loading.get(index);
    if (pending) return pending;
    const fh = this.fh;
    if (!fh) return Promise.reject(new MmdbError("closed"));
    const load = (async () => {
      const buf = Buffer.alloc(PAGE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, PAGE_BYTES, index * PAGE_BYTES);
      const page = bytesRead === PAGE_BYTES ? buf : buf.subarray(0, Math.max(0, bytesRead));
      if (this.fh) {
        this.pages.set(index, page);
        if (this.pages.size > PAGE_CACHE_PAGES) {
          const oldest = this.pages.keys().next().value;
          if (oldest !== undefined) this.pages.delete(oldest);
        }
      }
      return page;
    })().finally(() => this.loading.delete(index));
    this.loading.set(index, load);
    return load;
  }

  /** `len` bytes at `pos`, which must end at or before `limit`. */
  private async read(pos: number, len: number, limit: number): Promise<Buffer> {
    if (!Number.isSafeInteger(pos) || pos < 0 || len < 0 || pos + len > limit) throw new MmdbError("read outside its section");
    if (len === 0) return Buffer.alloc(0);
    if (len > PAGE_BYTES) return this.readDirect(pos, len);
    // Division, not >>: offsets beyond 2 GiB must not wrap.
    const first = Math.floor(pos / PAGE_BYTES);
    const last = Math.floor((pos + len - 1) / PAGE_BYTES);
    if (first === last) {
      const p = await this.page(first);
      const off = pos - first * PAGE_BYTES;
      if (off + len > p.length) throw new MmdbError("unexpected end of file");
      return p.subarray(off, off + len);
    }
    const out = Buffer.alloc(len);
    let copied = 0;
    for (let idx = first; idx <= last; idx += 1) {
      const p = await this.page(idx);
      const start = idx === first ? pos - first * PAGE_BYTES : 0;
      const take = Math.min(p.length - start, len - copied);
      if (take <= 0) throw new MmdbError("unexpected end of file");
      p.copy(out, copied, start, start + take);
      copied += take;
    }
    return out;
  }

  // ---- data section decoder --------------------------------------------------------

  /** Decodes the field at `pos`; pointers are relative to `base` (the data or metadata section start). */
  private async decode(pos: number, base: number, depth: number, limit: number, budget: Budget): Promise<Decoded> {
    if (depth > DECODE_MAX_DEPTH) throw new MmdbError("data nested too deeply");
    budget.values -= 1;
    if (budget.values < 0) throw new MmdbError("decode budget exceeded");
    let off = pos;
    const ctrl = (await this.read(off, 1, limit))[0]!;
    off += 1;
    let type = ctrl >> 5;
    if (type === 1) {
      const ss = (ctrl >> 3) & 0x3;
      const vvv = ctrl & 0x7;
      let target: number;
      const p = await this.read(off, ss + 1, limit);
      switch (ss) {
        case 0:
          target = (vvv << 8) | p[0]!;
          break;
        case 1:
          target = ((vvv << 16) | (p[0]! << 8) | p[1]!) + 2048;
          break;
        case 2:
          target = vvv * 0x1000000 + ((p[0]! << 16) | (p[1]! << 8) | p[2]!) + 526_336;
          break;
        default:
          target = p.readUInt32BE(0);
      }
      off += ss + 1;
      const [value] = await this.decode(base + target, base, depth + 1, limit, budget);
      return [value, off];
    }
    if (type === 0) {
      type = 7 + (await this.read(off, 1, limit))[0]!;
      off += 1;
      if (type < 8) throw new MmdbError("invalid extended type");
    }
    let size = ctrl & 0x1f;
    if (size >= 29) {
      const n = size - 28;
      const s = await this.read(off, n, limit);
      off += n;
      if (n === 1) size = 29 + s[0]!;
      else if (n === 2) size = 285 + ((s[0]! << 8) | s[1]!);
      else size = 65_821 + ((s[0]! << 16) | (s[1]! << 8) | s[2]!);
    }
    switch (type) {
      case 2: // utf8 string
      case 4: {
        // bytes
        budget.bytes -= size;
        if (budget.bytes < 0) throw new MmdbError("decode budget exceeded");
        const raw = await this.read(off, size, limit);
        return [type === 2 ? raw.toString("utf8") : Buffer.from(raw), off + size];
      }
      case 3: // double
        if (size !== 8) throw new MmdbError("invalid double size");
        return [(await this.read(off, 8, limit)).readDoubleBE(0), off + 8];
      case 5: // uint16
      case 6: // uint32
      case 9: // uint64
      case 10: {
        // uint128
        const max = type === 5 ? 2 : type === 6 ? 4 : type === 9 ? 8 : 16;
        if (size > max) throw new MmdbError("invalid integer size");
        return [unsigned(await this.read(off, size, limit)), off + size];
      }
      case 7: {
        // map
        if (size > budget.values) throw new MmdbError("decode budget exceeded");
        const out: Record<string, unknown> = {};
        for (let i = 0; i < size; i += 1) {
          const [key, afterKey] = await this.decode(off, base, depth + 1, limit, budget);
          if (typeof key !== "string") throw new MmdbError("map key is not a string");
          const [value, afterValue] = await this.decode(afterKey, base, depth + 1, limit, budget);
          Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
          off = afterValue;
        }
        return [out, off];
      }
      case 8: {
        // int32
        if (size > 4) throw new MmdbError("invalid int32 size");
        const b = await this.read(off, size, limit);
        let v = 0;
        for (const x of b) v = (v << 8) | x;
        return [v | 0, off + size];
      }
      case 11: {
        // array
        if (size > budget.values) throw new MmdbError("decode budget exceeded");
        const out: unknown[] = [];
        for (let i = 0; i < size; i += 1) {
          const [value, next] = await this.decode(off, base, depth + 1, limit, budget);
          out.push(value);
          off = next;
        }
        return [out, off];
      }
      case 14: // boolean: the size is the value
        if (size > 1) throw new MmdbError("invalid boolean");
        return [size === 1, off];
      case 15: // float
        if (size !== 4) throw new MmdbError("invalid float size");
        return [(await this.read(off, 4, limit)).readFloatBE(0), off + 4];
      default:
        // 12 data cache container and 13 end marker never appear in a record; anything else is unknown.
        throw new MmdbError("unsupported data type");
    }
  }
}

function unsigned(b: Buffer): number | bigint {
  if (b.length <= 6) {
    let v = 0;
    for (const x of b) v = v * 256 + x;
    return v;
  }
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function parseMetadata(meta: unknown): MmdbMetadata {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new MmdbError("metadata is not a map");
  const m = meta as Record<string, unknown>;
  const nodeCount = m["node_count"];
  const recordSize = m["record_size"];
  const ipVersion = m["ip_version"];
  const major = m["binary_format_major_version"];
  if (typeof nodeCount !== "number" || !Number.isSafeInteger(nodeCount) || nodeCount < 1) throw new MmdbError("invalid node_count");
  if (recordSize !== 24 && recordSize !== 28 && recordSize !== 32) throw new MmdbError("unsupported record_size");
  if (ipVersion !== 4 && ipVersion !== 6) throw new MmdbError("unsupported ip_version");
  if (major !== 2) throw new MmdbError("unsupported binary format");
  const buildEpoch = m["build_epoch"];
  return {
    nodeCount,
    recordSize,
    ipVersion,
    databaseType: typeof m["database_type"] === "string" ? (m["database_type"] as string).slice(0, 128) : "",
    buildEpoch: typeof buildEpoch === "number" ? buildEpoch : typeof buildEpoch === "bigint" ? Number(buildEpoch) : null,
    binaryFormatMajorVersion: major,
  };
}
