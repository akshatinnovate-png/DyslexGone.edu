import type { GenRequest, GenResponse, LlmProvider, Tier } from '../types.js';
import { coerce, synthesize, validate, type JsonSchema } from '../jsonschema.js';
import { estimateTokens } from '../pricing.js';
import { seededRng, type Rng } from '../../core/mathx.js';
import { keyphrases, sentences, truncate, words } from '../../core/textkit.js';

export interface OfflineContext {
  req: GenRequest;
  rng: Rng;
  prompt: string;
  topic: string;
  keyTerms: string[];
  grade: number;
  extra: Record<string, unknown>;
}

export type OfflineHandler = (ctx: OfflineContext) => unknown | string;

/** The offline cognition engine.
 *
 *  LUMEN never hard-depends on a hosted model. Every purpose can register a
 *  deterministic generator here; the engines do the real pedagogical work with
 *  algorithms and templates, and a hosted model only *upgrades* the prose.
 *  That makes the whole OS runnable with zero API keys - and makes demos
 *  byte-for-byte reproducible. */
class DeterministicProvider implements LlmProvider {
  readonly name = 'deterministic' as const;
  private handlers = new Map<string, OfflineHandler>();

  available(): boolean { return true; }
  modelFor(_tier: Tier): string { void _tier; return 'deterministic'; }

  register(purpose: string, handler: OfflineHandler): void {
    this.handlers.set(purpose, handler);
  }

  registered(): string[] { return [...this.handlers.keys()].sort(); }

  async generate(req: GenRequest): Promise<GenResponse> {
    const t0 = performance.now();
    const prompt = [req.system ?? '', ...req.messages.map((m) => m.content)].join('\n\n');
    const extra = req.offlineContext ?? {};
    const ctx: OfflineContext = {
      req,
      rng: seededRng(req.seed ?? `${req.purpose}:${prompt.length}:${prompt.slice(0, 64)}`),
      prompt,
      topic: String(extra.topic ?? extra.concept ?? inferTopic(prompt)),
      keyTerms: Array.isArray(extra.keyTerms) ? (extra.keyTerms as string[]) : keyphrases(prompt, 6).map((k) => k.phrase),
      grade: Number(extra.grade ?? 6),
      extra,
    };

    const handler = this.handlers.get(req.purpose) ?? this.prefixHandler(req.purpose);
    let out: unknown;
    try {
      out = handler ? handler(ctx) : this.fallback(ctx);
    } catch {
      out = this.fallback(ctx);
    }

    let text: string;
    let json: unknown;
    const issues: string[] = [];

    if (req.schema) {
      const candidate = typeof out === 'string' ? safeParse(out) ?? synthesize(req.schema) : out;
      json = coerce(candidate, req.schema);
      const v = validate(json, req.schema);
      if (v.length) {
        issues.push(...v.map((i) => `${i.path}: ${i.message}`));
        json = coerce(mergeDefaults(json, req.schema), req.schema);
      }
      text = JSON.stringify(json, null, 2);
    } else {
      text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    }

    const tokensIn = estimateTokens(prompt);
    const tokensOut = estimateTokens(text);
    return {
      text,
      json,
      provider: 'deterministic',
      model: 'deterministic',
      usage: { tokensIn, tokensOut, costUsd: 0 },
      cached: false,
      ms: Math.round(performance.now() - t0),
      finishReason: 'offline',
      degraded: true,
      issues: issues.length ? issues : undefined,
    };
  }

  /** 'lesson.compose.visual' falls back to a handler for 'lesson.compose' then 'lesson'. */
  private prefixHandler(purpose: string): OfflineHandler | undefined {
    const parts = purpose.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const h = this.handlers.get(parts.slice(0, i).join('.'));
      if (h) return h;
    }
    return undefined;
  }

  private fallback(ctx: OfflineContext): string {
    const { topic, keyTerms, prompt } = ctx;
    const src = sentences(prompt).filter((s) => words(s).length > 6).slice(0, 3);
    const lines = [
      `${topic} in one line: ${src[0] ? truncate(src[0], 160) : `the core idea behind ${topic}.`}`,
      keyTerms.length ? `Words that matter here: ${keyTerms.slice(0, 4).join(', ')}.` : '',
      src[1] ? `Why it works: ${truncate(src[1], 180)}` : '',
      `Check yourself: can you explain ${topic} to someone two years younger than you?`,
    ].filter(Boolean);
    return lines.join('\n');
  }
}

function inferTopic(prompt: string): string {
  const m = prompt.match(/concept(?:\s*(?:is|:))?\s*["“']?([A-Za-z0-9 \-]{3,48})/i)
    ?? prompt.match(/about\s+["“']?([A-Za-z0-9 \-]{3,48})/i);
  if (m) return m[1].trim();
  const kp = keyphrases(prompt, 1);
  return kp[0]?.phrase ?? 'this idea';
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Fill any missing required keys with synthesized values, recursively. */
function mergeDefaults(value: unknown, schema: JsonSchema): unknown {
  if (schema.type !== 'object') return value ?? synthesize(schema);
  const base = synthesize(schema) as Record<string, unknown>;
  const src = (value && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
  const out: Record<string, unknown> = { ...base };
  for (const [k, sub] of Object.entries(schema.properties)) {
    if (src[k] !== undefined && src[k] !== null) {
      out[k] = sub.type === 'object' ? mergeDefaults(src[k], sub) : src[k];
    }
  }
  return out;
}

export const deterministic = new DeterministicProvider();
