import Anthropic from '@anthropic-ai/sdk';
import type { GenRequest, GenResponse, LlmProvider, Tier } from '../types.js';
import { config } from '../../core/config.js';
import { costUsd, estimateTokens } from '../pricing.js';
import { coerce, describeSchema, extractJson, validate } from '../jsonschema.js';
import { upstream } from '../../core/errors.js';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic | null = null;

  available(): boolean { return Boolean(config.llm.anthropicKey); }

  modelFor(tier: Tier): string {
    return tier === 'fast' ? config.llm.modelFast
      : tier === 'deep' ? config.llm.modelDeep
      : config.llm.modelBalanced;
  }

  private sdk(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: config.llm.anthropicKey,
        ...(config.llm.anthropicBaseUrl ? { baseURL: config.llm.anthropicBaseUrl } : {}),
        timeout: config.llm.timeoutMs,
        maxRetries: 0, // the router owns retry policy
      });
    }
    return this.client;
  }

  async generate(req: GenRequest): Promise<GenResponse> {
    const t0 = performance.now();
    const model = this.modelFor(req.tier ?? 'balanced');
    const system = buildSystem(req);

    let res: Anthropic.Message;
    try {
      res = await this.sdk().messages.create({
        model,
        max_tokens: req.maxTokens ?? config.llm.maxTokens,
        temperature: req.schema ? 0 : (req.temperature ?? config.llm.temperature),
        ...(system ? { system } : {}),
        ...(req.stops?.length ? { stop_sequences: req.stops } : {}),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (e) {
      throw upstream(`anthropic request failed: ${e instanceof Error ? e.message : String(e)}`, e);
    }

    const text = res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    const tokensIn = res.usage?.input_tokens ?? estimateTokens(system + JSON.stringify(req.messages));
    const tokensOut = res.usage?.output_tokens ?? estimateTokens(text);

    const out: GenResponse = {
      text,
      provider: 'anthropic',
      model,
      usage: { tokensIn, tokensOut, costUsd: costUsd(model, tokensIn, tokensOut) },
      cached: false,
      ms: Math.round(performance.now() - t0),
      finishReason: res.stop_reason === 'max_tokens' ? 'length' : 'stop',
      degraded: false,
    };

    if (req.schema) {
      const parsed = extractJson(text);
      if (parsed === undefined) throw upstream('anthropic returned no parseable JSON for a structured request');
      const shaped = coerce(parsed, req.schema);
      const issues = validate(shaped, req.schema);
      out.json = shaped;
      if (issues.length) out.issues = issues.map((i) => `${i.path}: ${i.message}`);
    }
    return out;
  }
}

export function buildSystem(req: GenRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(req.system);
  if (req.schema) {
    parts.push(
      'Respond with a single JSON value and nothing else - no prose, no code fences.',
      `It must match this shape (keys marked ? are optional):\n${describeSchema(req.schema)}`,
    );
  }
  return parts.join('\n\n');
}
