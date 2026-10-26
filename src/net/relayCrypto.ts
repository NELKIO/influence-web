/**
 * Room keys for the MQTT relay. Everything the relay carries is AES-GCM encrypted with a key derived
 * from the room code, so the (third-party, public) broker and anybody else subscribed to its topics
 * only see ciphertext. The topic id is derived with the same slow KDF, so mapping a topic back to its
 * room code costs a PBKDF2 run per guess.
 *
 * Note: room codes are short (4-5 characters), so this protects against casual observers, not against
 * a determined attacker who brute-forces the code space — and anyone who knows the code can join anyway.
 */

export interface RoomKeys {
  /** hex id used in topic names */
  roomId: string;
  key: CryptoKey;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const cache = new Map<string, Promise<RoomKeys>>();

export const DEFAULT_KDF_ITERATIONS = 30000;

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available (needs a secure context)');
  return s;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Topic id + AES-GCM key of room `code` of `kind` ('duel' | 'battle'). Cached per process. */
export function roomKeys(kind: string, code: string, iterations = DEFAULT_KDF_ITERATIONS): Promise<RoomKeys> {
  const id = `${kind}|${code}|${iterations}`;
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      const s = subtle();
      const base = await s.importKey('raw', enc.encode(code.toUpperCase()), 'PBKDF2', false, ['deriveBits']);
      const bits = new Uint8Array(
        await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`influence-web/relay/v1/${kind}`), iterations }, base, 44 * 8),
      );
      const key = await s.importKey('raw', bits.slice(12, 44), 'AES-GCM', false, ['encrypt', 'decrypt']);
      return { roomId: hex(bits.slice(0, 12)), key };
    })();
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}

/** IV (12 bytes) + AES-GCM ciphertext of the UTF-8 JSON of `value`. */
export function seal(key: CryptoKey, value: unknown): Promise<Uint8Array> {
  return sealText(key, JSON.stringify(value));
}

/**
 * Same for an already serialised JSON text. Senders serialise synchronously (at send time) and
 * encrypt later: the objects they send may change right after `send()` returns.
 */
export async function sealText(key: CryptoKey, text: string): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

/** Decrypt and parse a sealed blob; null if it is not ours (wrong key, tampered, garbage). */
export async function open(key: CryptoKey, blob: Uint8Array): Promise<unknown> {
  if (blob.length < 13) return null;
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- framing / chunking

/** Frames: [1, ...blob] for a whole message, [2, id(4), index(2), count(2), ...part] for chunks. */
export function toFrames(blob: Uint8Array, chunkSize: number, id: number): Uint8Array[] {
  if (blob.length + 1 <= chunkSize) {
    const f = new Uint8Array(blob.length + 1);
    f[0] = 1;
    f.set(blob, 1);
    return [f];
  }
  const part = Math.max(1, chunkSize - 9);
  const count = Math.ceil(blob.length / part);
  if (count > 0xffff) throw new Error('message too large');
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const slice = blob.subarray(i * part, (i + 1) * part);
    const f = new Uint8Array(9 + slice.length);
    const dv = new DataView(f.buffer);
    f[0] = 2;
    dv.setUint32(1, id >>> 0);
    dv.setUint16(5, i);
    dv.setUint16(7, count);
    f.set(slice, 9);
    frames.push(f);
  }
  return frames;
}

/** Reassembles chunked frames (per sender topic); incomplete messages are dropped after a while. */
export class Reassembler {
  private parts = new Map<number, { got: (Uint8Array | undefined)[]; left: number; at: number }>();

  constructor(private maxPending = 16, private maxAgeMs = 60_000) {}

  /** a complete blob, or null (chunk stored / malformed frame) */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length < 1) return null;
    if (frame[0] === 1) return frame.subarray(1);
    if (frame[0] !== 2 || frame.length < 9) return null;
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = dv.getUint32(1);
    const index = dv.getUint16(5);
    const count = dv.getUint16(7);
    if (!count || index >= count) return null;
    const now = Date.now();
    for (const [k, v] of this.parts) if (now - v.at > this.maxAgeMs) this.parts.delete(k);
    let m = this.parts.get(id);
    if (!m || m.got.length !== count) {
      m = { got: new Array(count), left: count, at: now };
      this.parts.set(id, m);
      if (this.parts.size > this.maxPending) this.parts.delete(this.parts.keys().next().value!);
    }
    if (!m.got[index]) {
      m.got[index] = frame.slice(9);
      m.left--;
    }
    if (m.left > 0) return null;
    this.parts.delete(id);
    const total = m.got.reduce((n, p) => n + p!.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of m.got) {
      out.set(p!, o);
      o += p!.length;
    }
    return out;
  }
}

// ---------------------------------------------------------------- text-safe frames

/** Standard base64 of bytes (for relays that carry text only). */
export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bytes of a base64 string; null if it is not valid base64. */
export function fromB64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- compressed packets

/** IV + AES-GCM ciphertext of raw bytes. */
export async function sealBytes(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

/** Plain bytes of a sealed blob; null if it is not ours. */
export async function openBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array | null> {
  if (blob.length < 13) return null;
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12)));
  } catch {
    return null;
  }
}

async function pipeBytes(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * A JSON text as a packet: [1, ...deflate-raw] when that is smaller (game states shrink 3-6×), else
 * [0, ...utf8]. Small packets matter on networks that freeze a connection after a few kilobytes.
 */
export async function packText(text: string): Promise<Uint8Array> {
  const raw = enc.encode(text);
  if (raw.length > 200 && typeof CompressionStream !== 'undefined') {
    try {
      const z = await pipeBytes(raw, new CompressionStream('deflate-raw'));
      if (z.length + 1 < raw.length) {
        const out = new Uint8Array(z.length + 1);
        out[0] = 1;
        out.set(z, 1);
        return out;
      }
    } catch {
      /* send it uncompressed */
    }
  }
  const out = new Uint8Array(raw.length + 1);
  out.set(raw, 1);
  return out;
}

/** The JSON value of a packet; null if malformed. */
export async function unpackText(p: Uint8Array): Promise<unknown> {
  try {
    if (p[0] === 0) return JSON.parse(dec.decode(p.subarray(1)));
    if (p[0] === 1 && typeof DecompressionStream !== 'undefined') return JSON.parse(dec.decode(await pipeBytes(p.subarray(1), new DecompressionStream('deflate-raw'))));
  } catch {
    /* fall through */
  }
  return null;
}
