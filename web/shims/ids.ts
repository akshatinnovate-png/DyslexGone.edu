/** Browser-safe stand-in for src/core/ids.ts.
 *  Same contracts, no node:crypto: the demo bundle needs ids and canonical
 *  JSON for cache keys, never cryptographic strength. */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function id(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  let tail = '';
  for (const b of randomBytes(8)) tail += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${t}${tail}`;
}

export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** FNV-1a, 64 bits of avalanche by two independent 32-bit lanes. */
export function shortHash(input: string, len = 12): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    a = Math.imul(a ^ ch, 0x01000193) >>> 0;
    b = Math.imul(b ^ (ch + i), 0x85ebca6b) >>> 0;
  }
  const hex = a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  return hex.repeat(Math.ceil(len / 16) || 1).slice(0, len);
}

export function stableKey(obj: unknown): string {
  return shortHash(canonicalJson(obj), 24);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
