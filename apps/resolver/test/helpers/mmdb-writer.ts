/**
 * Tiny MaxMind DB (format 2) writer for tests: builds a valid database in
 * memory for a few networks, so the reader (src/shadow/mmdb.ts) and the
 * IPNetDB loader are tested without any committed binary fixture or real
 * network data. Use documentation ranges only (192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24, 2001:db8::/32).
 *
 * - ip_version 6 (IPv4 networks are placed under ::/96, where the reader's
 *   IPv4 subtree starts) or 4; record sizes 24, 28 and 32.
 * - Data section: every JavaScript value maps to an MMDB type (string ->
 *   utf8 string, boolean -> boolean, non-negative safe integer -> uint32,
 *   other number -> double, Buffer -> bytes, array -> array, object -> map);
 *   `mmdbType.*` forces a specific type (uint16, uint64, uint128, int32,
 *   float, double).
 * - Strings repeated across or within records are written once and referred
 *   to by pointers (`pointerStyle`: the smallest pointer that fits, or always
 *   the 4-byte form), and `padding` bytes before the first record push
 *   pointer targets past 2048 or 526336 so every pointer size is exercised.
 */
import ipaddr from "ipaddr.js";

export class Typed {
  constructor(
    readonly type: "uint16" | "uint32" | "uint64" | "uint128" | "int32" | "double" | "float",
    readonly value: number | bigint,
  ) {}
}

export const mmdbType = {
  uint16: (v: number) => new Typed("uint16", v),
  uint32: (v: number) => new Typed("uint32", v),
  uint64: (v: bigint | number) => new Typed("uint64", v),
  uint128: (v: bigint | number) => new Typed("uint128", v),
  int32: (v: number) => new Typed("int32", v),
  double: (v: number) => new Typed("double", v),
  float: (v: number) => new Typed("float", v),
};

export type MmdbValue = string | number | boolean | Buffer | Typed | MmdbValue[] | { [key: string]: MmdbValue };

export interface MmdbNetwork {
  /** CIDR, e.g. "192.0.2.0/24" or "2001:db8::/32". */
  network: string;
  record: MmdbValue;
}

export interface MmdbWriteOptions {
  ipVersion?: 4 | 6;
  recordSize?: 24 | 28 | 32;
  networks: MmdbNetwork[];
  /** "min" (default): the smallest pointer that reaches the target; 3: always the 4-byte form. */
  pointerStyle?: "min" | 3;
  /** Bytes of filler data written before the first record (moves pointer targets up). */
  padding?: number;
  databaseType?: string;
  /** Override metadata fields (e.g. to write an invalid file). */
  metadata?: Record<string, MmdbValue>;
  /** Omit the metadata marker entirely (an invalid file). */
  omitMarker?: boolean;
}

const MARKER = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from("MaxMind.com", "ascii")]);

function control(type: number, size: number): Buffer {
  const out: number[] = [];
  let first = type <= 7 ? type << 5 : 0;
  const ext = type > 7 ? [type - 7] : [];
  let sizeBytes: number[] = [];
  if (size < 29) first |= size;
  else if (size < 29 + 256) {
    first |= 29;
    sizeBytes = [size - 29];
  } else if (size < 285 + 65_536) {
    first |= 30;
    const v = size - 285;
    sizeBytes = [(v >> 8) & 0xff, v & 0xff];
  } else {
    first |= 31;
    const v = size - 65_821;
    sizeBytes = [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }
  out.push(first, ...ext, ...sizeBytes);
  return Buffer.from(out);
}

function minimalBytes(v: bigint): Buffer {
  const bytes: number[] = [];
  let x = v;
  while (x > 0n) {
    bytes.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  return Buffer.from(bytes);
}

function pointer(target: number, style: "min" | 3): Buffer {
  if (style === "min" && target < 2048) return Buffer.from([0x20 | (target >> 8), target & 0xff]);
  if (style === "min" && target < 2048 + 524_288) {
    const v = target - 2048;
    return Buffer.from([0x20 | (1 << 3) | (v >> 16), (v >> 8) & 0xff, v & 0xff]);
  }
  if (style === "min" && target < 526_336 + 134_217_728) {
    const v = target - 526_336;
    return Buffer.from([0x20 | (2 << 3) | Math.floor(v / 0x1000000), (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  const b = Buffer.alloc(5);
  b[0] = 0x20 | (3 << 3);
  b.writeUInt32BE(target, 1);
  return b;
}

/** Data-section encoder; `strings` remembers where each string was written (for pointers). */
class Encoder {
  readonly chunks: Buffer[] = [];
  length = 0;
  readonly strings = new Map<string, number>();
  pointers = 0;
  constructor(
    private readonly style: "min" | 3,
    private readonly dedupe: boolean,
  ) {}

  private push(b: Buffer): void {
    this.chunks.push(b);
    this.length += b.length;
  }

  write(v: MmdbValue): void {
    if (typeof v === "string") {
      const at = this.dedupe ? this.strings.get(v) : undefined;
      if (at !== undefined) {
        this.pointers += 1;
        this.push(pointer(at, this.style));
        return;
      }
      if (this.dedupe) this.strings.set(v, this.length);
      const s = Buffer.from(v, "utf8");
      this.push(Buffer.concat([control(2, s.length), s]));
      return;
    }
    if (typeof v === "boolean") return this.push(control(14, v ? 1 : 0));
    if (typeof v === "number") return this.write(Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? new Typed("uint32", v) : new Typed("double", v));
    if (Buffer.isBuffer(v)) return this.push(Buffer.concat([control(4, v.length), v]));
    if (v instanceof Typed) {
      switch (v.type) {
        case "double": {
          const b = Buffer.alloc(8);
          b.writeDoubleBE(Number(v.value));
          return this.push(Buffer.concat([control(3, 8), b]));
        }
        case "float": {
          const b = Buffer.alloc(4);
          b.writeFloatBE(Number(v.value));
          return this.push(Buffer.concat([control(15, 4), b]));
        }
        case "int32": {
          const b = Buffer.alloc(4);
          b.writeInt32BE(Number(v.value));
          return this.push(Buffer.concat([control(8, 4), b]));
        }
        default: {
          const type = { uint16: 5, uint32: 6, uint64: 9, uint128: 10 }[v.type];
          const b = minimalBytes(BigInt(v.value));
          return this.push(Buffer.concat([control(type, b.length), b]));
        }
      }
    }
    if (Array.isArray(v)) {
      this.push(control(11, v.length));
      for (const item of v) this.write(item);
      return;
    }
    const entries = Object.entries(v);
    this.push(control(7, entries.length));
    for (const [k, val] of entries) {
      this.write(k);
      this.write(val);
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface TrieNode {
  children: [TrieNode | Leaf | null, TrieNode | Leaf | null];
  id?: number;
}
interface Leaf {
  leaf: number;
}

function bitsOf(network: string, ipVersion: 4 | 6): { bits: number[]; length: number } {
  const [addr, len] = ipaddr.parseCIDR(network);
  const raw = addr.toByteArray();
  let bytes = raw;
  let length = len;
  if (raw.length === 4 && ipVersion === 6) {
    bytes = [...new Array(12).fill(0), ...raw];
    length = len + 96;
  }
  if (raw.length === 16 && ipVersion === 4) throw new Error("IPv6 network in an IPv4 database");
  const bits: number[] = [];
  for (let i = 0; i < length; i += 1) bits.push(((bytes[i >> 3] ?? 0) >> (7 - (i & 7))) & 1);
  return { bits, length };
}

export interface MmdbBuild {
  file: Buffer;
  nodeCount: number;
  /** Pointers written in the data section (strings referred to a second time). */
  pointers: number;
  dataBytes: number;
}

/** Builds a complete database file. */
export function buildMmdb(opts: MmdbWriteOptions): MmdbBuild {
  const ipVersion = opts.ipVersion ?? 6;
  const recordSize = opts.recordSize ?? 28;
  const style = opts.pointerStyle ?? "min";

  // Data section: optional padding, then each record once.
  const data = new Encoder(style, true);
  if (opts.padding && opts.padding > 0) data.write(Buffer.alloc(opts.padding, 0x5a));
  const recordOffsets = opts.networks.map((n) => {
    const at = data.length;
    data.write(n.record);
    return at;
  });

  // Search tree.
  const root: TrieNode = { children: [null, null] };
  opts.networks.forEach((n, i) => {
    const { bits, length } = bitsOf(n.network, ipVersion);
    if (length === 0) throw new Error("a /0 network is not supported");
    let node = root;
    for (let d = 0; d < length - 1; d += 1) {
      const b = bits[d]!;
      const child = node.children[b];
      if (child && "leaf" in child) throw new Error("overlapping networks are not supported");
      if (!child) node.children[b] = { children: [null, null] };
      node = node.children[b] as TrieNode;
    }
    node.children[bits[length - 1]!] = { leaf: recordOffsets[i]! };
  });
  const order: TrieNode[] = [];
  const queue: TrieNode[] = [root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    n.id = order.length;
    order.push(n);
    for (const c of n.children) if (c && !("leaf" in c)) queue.push(c);
  }
  const nodeCount = order.length;
  const value = (c: TrieNode | Leaf | null): number => (c === null ? nodeCount : "leaf" in c ? nodeCount + 16 + c.leaf : c.id!);
  const nodeBytes = (recordSize * 2) / 8;
  const tree = Buffer.alloc(nodeBytes * nodeCount);
  for (const n of order) {
    const l = value(n.children[0]);
    const r = value(n.children[1]);
    const o = n.id! * nodeBytes;
    if (recordSize === 24) {
      tree.writeUIntBE(l, o, 3);
      tree.writeUIntBE(r, o + 3, 3);
    } else if (recordSize === 28) {
      tree.writeUIntBE(l & 0xffffff, o, 3);
      tree[o + 3] = (((l >>> 24) & 0x0f) << 4) | ((r >>> 24) & 0x0f);
      tree.writeUIntBE(r & 0xffffff, o + 4, 3);
    } else {
      tree.writeUInt32BE(l, o);
      tree.writeUInt32BE(r, o + 4);
    }
  }

  const meta = new Encoder(style, false);
  meta.write({
    binary_format_major_version: mmdbType.uint16(2),
    binary_format_minor_version: mmdbType.uint16(0),
    build_epoch: mmdbType.uint64(1_700_000_000n),
    database_type: opts.databaseType ?? "IPNetDB-Test",
    description: { en: "synthetic test database (documentation ranges only)" },
    ip_version: mmdbType.uint16(ipVersion),
    languages: ["en"],
    node_count: mmdbType.uint32(nodeCount),
    record_size: mmdbType.uint16(recordSize),
    ...(opts.metadata ?? {}),
  });

  const dataBytes = data.bytes();
  const file = Buffer.concat([tree, Buffer.alloc(16), dataBytes, opts.omitMarker ? Buffer.alloc(0) : MARKER, meta.bytes()]);
  return { file, nodeCount, pointers: data.pointers, dataBytes: dataBytes.length };
}

/** An IPNetDB-like record (field names of the real prefix file; synthetic values). */
export function ipnetdbRecord(fields: { prefix: string; prefixEntity: string; asEntity: string; as: number; bogon?: boolean }): MmdbValue {
  return {
    allocation: fields.prefix,
    allocation_cc: "XA",
    allocation_registry: "test",
    allocation_status: "assigned",
    as: mmdbType.uint32(fields.as),
    as_cc: "XA",
    as_entity: fields.asEntity,
    as_name: "EXAMPLE-AS",
    as_private: false,
    as_registry: "test",
    ix: false,
    prefix: fields.prefix,
    prefix_asset: [],
    prefix_assignment: "assigned",
    prefix_bogon: fields.bogon ?? false,
    prefix_cc: "XA",
    prefix_entity: fields.prefixEntity,
    prefix_name: "EXAMPLE-NET",
    prefix_origins: [mmdbType.uint32(fields.as)],
    prefix_registry: "test",
    rpki_status: "valid",
  };
}
