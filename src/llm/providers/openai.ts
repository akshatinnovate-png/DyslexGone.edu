import type { GenRequest, GenResponse, LlmProvider, Tier } from '../types.js';
import { config } from '../../core/config.js';
import { costUsd, estimateTokens } from '../pricing.js';
import { coerce, extractJson, validate } from '../jsonschema.js';
import { upstream } from '../../core/errors.js';
import { buildSystem } from './anthropic.js';

/** Works against OpenAI and any OpenAI-compatible endpoint (vLLM, Ollama, Groq...). */
export class OpenAiCompatProvider implements LlmProvider {
  readonly name = 'openai' as const;

  available(): boolean { return Boolean(config.llm.openaiKey); }
  modelFor(_tier: Tier): string { void _tier; return config.llm.openaiModel; }

  async generate(req: GenRequest): Promise<GenResponse> {
    const t0 = performance.now();
    const model = this.modelFor(req.tier ?? 'balanced');
    const system = buildSystem(req);
    const body = {
      model,
      max_tokens: req.maxTokens ?? config.llm.maxTokens,
      temperature: req.schema ? 0 : (req.temperature ?? config.llm.temperature),
      ...(req.stops?.length ? { stop: req.stops } : {}),
      ...(req.schema ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llm.timeoutMs);
    let payload: {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      const res = await fetch(`${config.llm.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llm.openaiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
      payload = await res.json() as typeof payload;
    } catch (e) {
      throw upstream(`openai-compatible request failed: ${e instanceof Error ? e.message : String(e)}`, e);
    } finally {
      clearTimeout(timer);
    }

    const text = (payload.choices?.[0]?.message?.content ?? '').trim();
    const tokensIn = payload.usage?.prompt_tokens ?? estimateTokens(system + JSON.stringify(req.messages));
    const tokensOut = payload.usage?.completion_tokens ?? estimateTokens(text);

    const out: GenResponse = {
      text,
      provider: 'openai',
      model,
      usage: { tokensIn, tokensOut, costUsd: costUsd(model, tokensIn, tokensOut) },
      cached: false,
      ms: Math.round(performance.now() - t0),
      finishReason: payload.choices?.[0]?.finish_reason === 'length' ? 'length' : 'stop',
      degraded: false,
    };

    if (req.schema) {
      const parsed = extractJson(text);
      if (parsed === undefined) throw upstream('openai-compatible provider returned no parseable JSON');
      out.json = coerce(parsed, req.schema);
      const issues = validate(out.json, req.schema);
      if (issues.length) out.issues = issues.map((i) => `${i.path}: ${i.message}`);
    }
    return out;
  }
}
