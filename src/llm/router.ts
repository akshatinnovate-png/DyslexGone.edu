import type { GenRequest, GenResponse, LlmProvider, ProviderName, Tier } from './types.js';
import { deterministic } from './providers/deterministic.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { groqProvider, openAiProvider } from './providers/openai.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { LruCache, SingleFlight } from '../core/cache.js';
import { CircuitBreaker, withRetry, withTimeout } from '../core/circuit.js';
import { metrics } from '../core/metrics.js';
import { bus } from '../core/events.js';
import { canonicalJson, id as newId, stableKey } from '../core/ids.js';
import { AppError, isAppError } from '../core/errors.js';
import type { Db } from '../db/sqlite.js';

export interface RouterStats {
  mode: string;
  providers: { name: ProviderName; available: boolean; circuit: string }[];
  calls: number;
  cacheHits: number;
  degradedCalls: number;
  spendUsd: number;
  budgetUsd: number;
  cache: { hits: number; misses: number; size: number };
}

/** One gateway for every model call in the OS.
 *  Tiered model choice, response cache, single-flight dedupe, retries with
 *  backoff, per-provider circuit breakers, hard spend ceiling, and automatic
 *  graceful degradation to the offline engine. */
export class ModelRouter {
  private readonly anthropic = new AnthropicProvider();
  private readonly groq = groqProvider;
  private readonly openai = openAiProvider;
  private readonly breakers = new Map<ProviderName, CircuitBreaker>();
  private readonly cache = new LruCache<GenResponse>(2000, config.llm.cacheTtlMs);
  private readonly flight = new SingleFlight<GenResponse>();
  private spendUsd = 0;
  private calls = 0;
  private cacheHits = 0;
  private degradedCalls = 0;
  private db: Db | null = null;

  constructor() {
    for (const n of ['anthropic', 'groq', 'openai', 'deterministic'] as ProviderName[]) {
      this.breakers.set(n, new CircuitBreaker({ name: `llm:${n}`, failureThreshold: 4, openMs: 15_000 }));
    }
  }

  attachDb(db: Db): void { this.db = db; }

  /** Order of providers to try for this request. */
  chain(): LlmProvider[] {
    const mode = config.llm.mode;
    if (mode === 'deterministic') return [deterministic];
    if (mode === 'anthropic') return [this.anthropic, deterministic];
    if (mode === 'groq') return [this.groq, deterministic];
    if (mode === 'openai') return [this.openai, deterministic];
    const auto: LlmProvider[] = [];
    if (this.anthropic.available()) auto.push(this.anthropic);
    if (this.groq.available()) auto.push(this.groq);
    if (this.openai.available()) auto.push(this.openai);
    auto.push(deterministic);
    return auto;
  }

  /** True when a hosted model is actually reachable. Callers use this to decide
   *  whether to attempt an "enhancement" pass at all. */
  hasHostedModel(): boolean {
    if (config.llm.mode === 'deterministic') return false;
    return this.chain().some((p) => p.name !== 'deterministic' && p.available());
  }

  private budgetRemaining(): number {
    return config.llm.budgetUsd > 0 ? config.llm.budgetUsd - this.spendUsd : Infinity;
  }

  async generate<T = unknown>(req: GenRequest): Promise<GenResponse<T>> {
    const tier: Tier = req.tier ?? 'balanced';
    const cacheKey = stableKey({
      purpose: req.purpose, tier, system: req.system, messages: req.messages,
      schema: req.schema ? canonicalJson(req.schema) : null,
      temperature: req.temperature ?? config.llm.temperature, seed: req.seed ?? null,
    });

    if (config.llm.cacheEnabled && !req.noCache) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        this.cacheHits++;
        metrics.counter('lumen_llm_calls_total').inc({ provider: hit.provider, purpose: req.purpose, cached: 'true' });
        bus.emit('llm.call', {
          provider: hit.provider, model: hit.model, tokensIn: 0, tokensOut: 0, costUsd: 0, cached: true,
        });
        return { ...hit, cached: true } as GenResponse<T>;
      }
    }

    const run = async (): Promise<GenResponse> => {
      const errors: string[] = [];
      for (const provider of this.chain()) {
        if (provider.name !== 'deterministic') {
          if (!provider.available()) { errors.push(`${provider.name}: unavailable`); continue; }
          if (this.budgetRemaining() <= 0) { errors.push(`${provider.name}: budget exhausted`); continue; }
          const breaker = this.breakers.get(provider.name)!;
          if (breaker.state === 'open') { errors.push(`${provider.name}: circuit open`); continue; }
        }
        try {
          const res = await this.callProvider(provider, req, tier);
          if (errors.length) res.issues = [...(res.issues ?? []), ...errors];
          return res;
        } catch (e) {
          const msg = isAppError(e) ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
          errors.push(`${provider.name}: ${msg}`);
          logger.warn('model provider failed, falling through', { provider: provider.name, purpose: req.purpose, err: msg });
        }
      }
      throw new AppError('upstream_failed', `all model providers failed for ${req.purpose}`, { details: errors });
    };

    const res = await this.flight.run(cacheKey, run);
    if (config.llm.cacheEnabled && !req.noCache && res.finishReason !== 'error') {
      this.cache.set(cacheKey, res);
    }
    return res as GenResponse<T>;
  }

  private async callProvider(provider: LlmProvider, req: GenRequest, tier: Tier): Promise<GenResponse> {
    const breaker = this.breakers.get(provider.name)!;
    const t0 = performance.now();
    const res = await breaker.exec(() => withRetry(
      () => withTimeout(provider.generate({ ...req, tier }), config.llm.timeoutMs, `${provider.name}.generate`),
      {
        retries: provider.name === 'deterministic' ? 0 : config.llm.retries,
        retryOn: (e) => !isAppError(e) || e.retryable,
        onRetry: (attempt, e, delay) =>
          logger.debug('retrying model call', { provider: provider.name, attempt, delay, err: String(e) }),
      },
    ));

    this.calls++;
    this.spendUsd += res.usage.costUsd;
    if (res.degraded) this.degradedCalls++;

    metrics.counter('lumen_llm_calls_total').inc({ provider: provider.name, purpose: req.purpose, cached: 'false' });
    metrics.counter('lumen_llm_tokens_total').inc({ provider: provider.name, dir: 'in' }, res.usage.tokensIn);
    metrics.counter('lumen_llm_tokens_total').inc({ provider: provider.name, dir: 'out' }, res.usage.tokensOut);
    metrics.gauge('lumen_llm_spend_usd').set(this.spendUsd);
    metrics.histogram('lumen_llm_latency_ms').observe(performance.now() - t0, { provider: provider.name, tier });

    bus.emit('llm.call', {
      provider: provider.name, model: res.model, tokensIn: res.usage.tokensIn,
      tokensOut: res.usage.tokensOut, costUsd: res.usage.costUsd, cached: false,
    });

    if (this.db) {
      try {
        this.db.insert('llm_calls', {
          id: newId('llm'), at: new Date().toISOString(), provider: provider.name, model: res.model,
          purpose: req.purpose, tokens_in: res.usage.tokensIn, tokens_out: res.usage.tokensOut,
          cost_usd: res.usage.costUsd, cached: 0, ms: res.ms, ok: 1, error: null,
        });
      } catch (e) {
        logger.debug('llm call log failed', { err: String(e) });
      }
    }
    return res;
  }

  /** Structured generation with validation; falls back to the offline engine if
   *  a hosted model produces something unusable. */
  async structured<T>(req: GenRequest & { schema: NonNullable<GenRequest['schema']> }): Promise<{ value: T; res: GenResponse }> {
    const res = await this.generate<T>(req);
    if (res.json !== undefined && !(res.issues ?? []).some((i) => i.includes('missing required'))) {
      return { value: res.json as T, res };
    }
    const offline = await deterministic.generate(req);
    return { value: offline.json as T, res: { ...offline, issues: [...(res.issues ?? []), 'fell back to offline engine'] } };
  }

  stats(): RouterStats {
    return {
      mode: config.llm.mode,
      providers: ([this.anthropic, this.groq, this.openai, deterministic] as LlmProvider[]).map((p) => ({
        name: p.name,
        available: p.available(),
        circuit: this.breakers.get(p.name)!.state,
      })),
      calls: this.calls,
      cacheHits: this.cacheHits,
      degradedCalls: this.degradedCalls,
      spendUsd: Math.round(this.spendUsd * 1e6) / 1e6,
      budgetUsd: config.llm.budgetUsd,
      cache: {
        hits: this.cache.stats.hits,
        misses: this.cache.stats.misses,
        size: this.cache.stats.size,
      },
    };
  }

  clearCache(): void { this.cache.clear(); }
}

export const router = new ModelRouter();
