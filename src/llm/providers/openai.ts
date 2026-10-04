import type { GenRequest, GenResponse, LlmProvider, ProviderName, Tier } from '../types.js';
import { config } from '../../core/config.js';
import { costUsd, estimateTokens } from '../pricing.js';
import { coerce, extractJson, validate } from '../jsonschema.js';
import { upstream } from '../../core/errors.js';
import { buildSystem } from './anthropic.js';

/** Any OpenAI-compatible endpoint: OpenAI itself, Groq, vLLM, Ollama, Together.
 *  One wire format, one client, different base URLs and model names. */
export interface VendorConfig {
  name: ProviderName;
  baseUrl: () => string;
  apiKey: () => string;
  models: () => { fast: string; balanced: string; deep: string };
  /** Vendor-specific body fields (e.g. gpt-oss reasoning effort on Groq). */
  extraBody?: (req: GenRequest) => Record<string, unknown>;
  /** Some gateways reject response_format; opt out per vendor. */
  supportsJsonMode?: boolean;
}

export class OpenAiCompatProvider implements LlmProvider {
  readonly name: ProviderName;

  constructor(private vendor: VendorConfig) {
    this.name = vendor.name;
  }

  available(): boolean { return Boolean(this.vendor.apiKey()); }

  modelFor(tier: Tier): string {
    const m = this.vendor.models();
    return tier === 'fast' ? (m.fast || m.balanced) : tier === 'deep' ? (m.deep || m.balanced) : m.balanced;
  }

  async generate(req: GenRequest): Promise<GenResponse> {
    const t0 = performance.now();
    const model = this.modelFor(req.tier ?? 'balanced');
    const system = buildSystem(req);

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? config.llm.maxTokens,
      temperature: req.schema ? 0 : (req.temperature ?? config.llm.temperature),
      ...(req.stops?.length ? { stop: req.stops } : {}),
      ...(req.schema && this.vendor.supportsJsonMode !== false ? { response_format: { type: 'json_object' } } : {}),
      ...(this.vendor.extraBody?.(req) ?? {}),
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llm.timeoutMs);
    let payload: {
      choices?: { message?: { content?: string; reasoning?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      const res = await fetch(`${this.vendor.baseUrl().replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.vendor.apiKey()}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
      payload = await res.json() as typeof payload;
      if (payload.error) throw new Error(payload.error.message ?? 'upstream returned an error object');
    } catch (e) {
      throw upstream(`${this.vendor.name} request failed: ${e instanceof Error ? e.message : String(e)}`, e);
    } finally {
      clearTimeout(timer);
    }

    const text = (payload.choices?.[0]?.message?.content ?? '').trim();
    const tokensIn = payload.usage?.prompt_tokens ?? estimateTokens(system + JSON.stringify(req.messages));
    const tokensOut = payload.usage?.completion_tokens ?? estimateTokens(text);

    const out: GenResponse = {
      text,
      provider: this.vendor.name,
      model,
      usage: { tokensIn, tokensOut, costUsd: costUsd(model, tokensIn, tokensOut) },
      cached: false,
      ms: Math.round(performance.now() - t0),
      finishReason: payload.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop',
      degraded: false,
    };

    if (req.schema) {
      const parsed = extractJson(text);
      if (parsed === undefined) throw upstream(`${this.vendor.name} returned no parseable JSON`);
      out.json = coerce(parsed, req.schema);
      const issues = validate(out.json, req.schema);
      if (issues.length) out.issues = issues.map((i) => `${i.path}: ${i.message}`);
    }
    return out;
  }
}

export const openAiProvider = new OpenAiCompatProvider({
  name: 'openai',
  baseUrl: () => config.llm.openaiBaseUrl,
  apiKey: () => config.llm.openaiKey,
  models: () => ({
    fast: config.llm.openaiModelFast || config.llm.openaiModel,
    balanced: config.llm.openaiModel,
    deep: config.llm.openaiModel,
  }),
});

export const groqProvider = new OpenAiCompatProvider({
  name: 'groq',
  baseUrl: () => config.llm.groqBaseUrl,
  apiKey: () => config.llm.groqKey,
  models: () => ({
    fast: config.llm.groqModelFast,
    balanced: config.llm.groqModel,
    deep: config.llm.groqModelDeep,
  }),
  extraBody: (req) => (/^openai\/gpt-oss/.test(config.llm.groqModel)
    ? { reasoning_effort: req.tier === 'deep' ? 'high' : config.llm.groqReasoningEffort }
    : {}),
});
