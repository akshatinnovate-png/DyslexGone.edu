import { randomUUID, randomBytes, createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Monotonic, lexicographically sortable id with a human-readable prefix. */
export function id(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(8);
  let tail = '';
  for (const b of r) tail += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${t}${tail}`;
}

export const uuid = (): string => randomUUID();

export function shortHash(input: string, len = 12): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

export function stableKey(obj: unknown): string {
  return shortHash(canonicalJson(obj), 24);
}

/** Deterministic JSON: object keys sorted recursively. Used for cache keys + idempotency. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
