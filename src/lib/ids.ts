import { randomBytes } from 'node:crypto';

// Crockford base32 (lowercase), as used by ULID: no i, l, o, u.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RANDOM_CHARS = 16;

export type IdPrefix = 'pol' | 'snp' | 'chk' | 'evt' | 'obx' | 'sub' | 'dlv' | 'att' | 'req';

let lastTime = -1;
let lastRandom: number[] = [];

function freshRandom(): number[] {
  const digits: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const byte of randomBytes(10)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      digits.push((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return digits;
}

/** Increment the base32 random component by one (ULID "monotonic" mode). */
function increment(digits: number[]): number[] | null {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]! += 1;
      return next;
    }
    next[i] = 0;
  }
  return null; // overflow (2^80 IDs in one millisecond) — practically unreachable
}

/**
 * Prefixed, time-sortable identifier: `<prefix>_<10 chars of ms timestamp><16 chars of randomness>`.
 * Within one process, IDs are strictly increasing even inside the same millisecond, so ordering by
 * primary key reproduces creation order (events from one check keep their detection order) and list
 * endpoints can use the key alone for stable keyset pagination.
 */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  let random: number[] | null = null;
  if (now <= lastTime) {
    random = increment(lastRandom);
    now = lastTime;
  }
  if (!random) random = freshRandom();
  lastTime = now;
  lastRandom = random;

  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${time}${random.map((d) => ALPHABET[d]).join('')}`;
}

const ID_PATTERN = new RegExp(`^[a-z]{3}_[0-9a-hjkmnp-tv-z]{${10 + RANDOM_CHARS}}$`);

export function isValidId(value: string, prefix?: IdPrefix): boolean {
  if (!ID_PATTERN.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}
