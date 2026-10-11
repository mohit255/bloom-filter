import { readFileSync, writeFileSync, renameSync } from 'node:fs';

// MurmurHash3 (x86, 32-bit) over a UTF-8 byte array.
function murmur3(bytes, len, seed) {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const tail = len & ~3;

  for (let i = 0; i < tail; i += 4) {
    let k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let k = 0;
  switch (len & 3) {
    case 3: k ^= bytes[tail + 2] << 16; // falls through
    case 2: k ^= bytes[tail + 1] << 8;  // falls through
    case 1:
      k ^= bytes[tail];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const encoder = new TextEncoder();
const scratch = new Uint8Array(512);

function toBytes(str) {
  const { read, written } = encoder.encodeInto(str, scratch);
  if (read === str.length) return [scratch, written];
  const bytes = encoder.encode(str);
  return [bytes, bytes.length];
}

const MAGIC = 0x424c4d31; // "BLM1"
const HEADER_BYTES = 16;

export class BloomFilter {
  /**
   * Size a filter for `capacity` items at false-positive rate `fpRate`.
   *   m = -n·ln(p) / (ln 2)²     (bits)
   *   k = (m / n)·ln 2           (hash functions)
   */
  static forCapacity(capacity, fpRate) {
    const bits = Math.ceil((-capacity * Math.log(fpRate)) / Math.LN2 ** 2);
    const hashes = Math.max(1, Math.round((bits / capacity) * Math.LN2));
    return new BloomFilter(bits, hashes);
  }

  constructor(bits, hashes, data = new Uint8Array(Math.ceil(bits / 8)), count = 0) {
    if (bits >= 2 ** 32) throw new RangeError('bloom filter larger than 2^32 bits is not supported');
    this.bits = bits;
    this.hashes = hashes;
    this.data = data;
    this.count = count;
    this.positions = new Uint32Array(hashes);
  }

  // Kirsch–Mitzenmacher: k positions from two hashes, g_i = h1 + i·h2 (enhanced variant).
  #fillPositions(item) {
    const [bytes, len] = toBytes(item);
    let a = murmur3(bytes, len, 0);
    let b = murmur3(bytes, len, 0x9747b28c);
    for (let i = 0; i < this.hashes; i++) {
      this.positions[i] = a % this.bits;
      a = (a + b) >>> 0;
      b = (b + i + 1) >>> 0;
    }
  }

  add(item) {
    this.#fillPositions(item);
    for (let i = 0; i < this.hashes; i++) {
      const p = this.positions[i];
      this.data[p >>> 3] |= 1 << (p & 7);
    }
    this.count++;
  }

  /** false → definitely never added. true → probably added. */
  mightContain(item) {
    this.#fillPositions(item);
    for (let i = 0; i < this.hashes; i++) {
      const p = this.positions[i];
      if ((this.data[p >>> 3] & (1 << (p & 7))) === 0) return false;
    }
    return true;
  }

  /** (1 - e^(-k·n/m))^k for the current number of items. */
  estimatedFpRate() {
    return (1 - Math.exp((-this.hashes * this.count) / this.bits)) ** this.hashes;
  }

  get sizeBytes() {
    return this.data.byteLength;
  }

  save(path) {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(this.bits, 4);
    header.writeUInt32LE(this.hashes, 8);
    header.writeUInt32LE(this.count, 12);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, Buffer.concat([header, this.data]));
    renameSync(tmp, path);
  }

  static load(path) {
    const buf = readFileSync(path);
    if (buf.length < HEADER_BYTES || buf.readUInt32LE(0) !== MAGIC) {
      throw new Error(`${path} is not a bloom filter snapshot`);
    }
    const bits = buf.readUInt32LE(4);
    const hashes = buf.readUInt32LE(8);
    const count = buf.readUInt32LE(12);
    const data = new Uint8Array(buf.buffer, buf.byteOffset + HEADER_BYTES, Math.ceil(bits / 8));
    return new BloomFilter(bits, hashes, data, count);
  }
}
