/** Seedable PRNG (sfc32). State is a plain 4-int tuple so it can be saved with the match. */
export type RngState = [number, number, number, number];

export class Rng {
  s: RngState;

  constructor(seed: number | RngState) {
    if (Array.isArray(seed)) {
      this.s = [seed[0] | 0, seed[1] | 0, seed[2] | 0, seed[3] | 0];
    } else {
      // splitmix32 to spread the seed over the state
      let x = seed | 0;
      const next = () => {
        x = (x + 0x9e3779b9) | 0;
        let z = x;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
        return (z ^ (z >>> 16)) | 0;
      };
      this.s = [next(), next(), next(), next()];
      for (let i = 0; i < 12; i++) this.nextU32();
    }
  }

  nextU32(): number {
    let [a, b, c, d] = this.s;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.s = [a, b, c, d];
    return t >>> 0;
  }

  /** float in [0, 1) */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  /** integer in [0, n) */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** integer in [from, until) */
  range(from: number, until: number): number {
    return from + this.int(until - from);
  }

  bool(): boolean {
    return this.float() < 0.5;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  state(): RngState {
    return [...this.s] as RngState;
  }
}

/** Stable 32-bit hash of a string (FNV-1a), used for date / room seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return (Math.random() * 4294967296) >>> 0;
}
