/** Per-million-token prices, used for budget enforcement and cost telemetry.
 *  Prices move; override via LLM_PRICE_OVERRIDES='{"model":{"in":3,"out":15}}'. */
export interface Price { in: number; out: number; }

const DEFAULTS: Record<string, Price> = {
  'claude-opus-5': { in: 15, out: 75 },
  'claude-sonnet-5-5': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-fable-5-1': { in: 3, out: 15 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  deterministic: { in: 0, out: 0 },
};

let overrides: Record<string, Price> = {};
try {
  overrides = JSON.parse(process.env.LLM_PRICE_OVERRIDES ?? '{}');
} catch { overrides = {}; }

export function priceFor(model: string): Price {
  if (overrides[model]) return overrides[model];
  if (DEFAULTS[model]) return DEFAULTS[model];
  const prefix = Object.keys(DEFAULTS).find((k) => model.startsWith(k.split('-').slice(0, 3).join('-')));
  return prefix ? DEFAULTS[prefix] : { in: 3, out: 15 };
}

export function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = priceFor(model);
  return Math.round(((tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out) * 1e6) / 1e6;
}

/** Cheap token estimate (~4 chars/token for English prose, denser for code). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = (text.match(/\S+/g) ?? []).length;
  return Math.max(1, Math.ceil(Math.max(text.length / 4, words * 1.3)));
}
