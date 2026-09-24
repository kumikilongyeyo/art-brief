// Seeded PRNG: cyrb128 string hash feeding sfc32. The engine never uses the platform RNG.

export type Rng = () => number;

export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function rngFrom(seed: string): Rng {
  const rng = sfc32(...cyrb128(seed));
  for (let i = 0; i < 12; i++) rng(); // warm up
  return rng;
}

/** A single deterministic number in [0, 1) for a seed string. */
export function hashUnit(seed: string): number {
  return rngFrom(seed)();
}

// Crockford base32 — no I, L, O, U, so seeds are easy to read aloud.
export const SEED_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SEED_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

/** Build a 6-char base32 seed from random bytes (UI passes crypto.getRandomValues output). */
export function seedFromBytes(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += SEED_ALPHABET[(bytes[i] ?? 0) & 31];
  return s;
}

/** Derive a 6-char base32 seed deterministically from another string. */
export function seedFromString(str: string): string {
  const r = rngFrom(str);
  let s = '';
  for (let i = 0; i < 6; i++) s += SEED_ALPHABET[Math.floor(r() * 32)];
  return s;
}

export function isBaseSeed(s: unknown): s is string {
  return typeof s === 'string' && SEED_RE.test(s);
}
