/** Browser-safe stand-in for src/core/config.ts.
 *  Identical shape and identical default values, resolved at build time
 *  instead of read from process.env - the demo bundle has no fs and no env.
 *  Two values differ on purpose, marked inline: the browser holds no API
 *  keys, so the LLM router stays deterministic and the scene author stays
 *  curated rather than failing a network call on every render. */

const BROWSER_LLM_MODE = 'deterministic';
const BROWSER_AUTHOR_MODE = 'curated';

export type LlmMode = 'auto' | 'anthropic' | 'groq' | 'openai' | 'deterministic';

export const config = {
  env: 'production',
  get isProd() { return this.env === 'production'; },

  server: {
    host: '0.0.0.0',
    port: 8080,
    bodyLimitBytes: 24 * 1024 * 1024,
    requestTimeoutMs: 120_000,
    trustProxy: false,
  },

  log: {
    level: 'info' as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent',
    pretty: true,
    redactKeys: 'authorization,x-api-key,api_key,apiKey,password,token'.split(','),
  },

  db: {
    file: './data/lumen.sqlite',
    walMode: true,
    busyTimeoutMs: 5000,
  },

  auth: {
    enabled: false,
    rootKey: '',
    webhookSecretPepper: 'lumen-dev-pepper',
  },

  rateLimit: {
    enabled: true,
    windowMs: 60_000,
    max: 600,
    burst: 60,
  },

  llm: {
    mode: BROWSER_LLM_MODE as LlmMode, // browser override
    anthropicKey: '',
    anthropicBaseUrl: '',
    openaiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-4o-mini',
    openaiModelFast: '',
    // Groq speaks the OpenAI wire format, so it is the same client with a
    // different base URL. gpt-oss-120b is the default author model: it is fast
    // enough to generate a storyboard inside a request, and cheap enough to
    // regenerate on an audit failure.
    groqKey: '',
    groqBaseUrl: 'https://api.groq.com/openai/v1',
    groqModel: 'openai/gpt-oss-120b',
    groqModelFast: 'llama-3.1-8b-instant',
    groqModelDeep: 'openai/gpt-oss-120b',
    /** gpt-oss supports a reasoning budget; ignored by models that do not. */
    groqReasoningEffort: 'medium' as 'low' | 'medium' | 'high',
    // Tiered routing: the orchestrator asks for a tier, the router picks the model.
    modelFast: 'claude-haiku-4-5-20251001',
    modelBalanced: 'claude-sonnet-5-5',
    modelDeep: 'claude-opus-5',
    maxTokens: 4096,
    temperature: 0.3,
    timeoutMs: 90_000,
    retries: 2,
    cacheEnabled: true,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    // Hard spend ceiling per process lifetime (USD). 0 = unlimited.
    budgetUsd: 0,
    perRequestBudgetUsd: 0.75,
  },

  animation: {
    /** 'auto' prefers a hand-tuned builder when one exists, then asks the model.
     *  'model' always asks the model. 'curated' never does. */
    authorMode: BROWSER_AUTHOR_MODE as 'auto' | 'model' | 'curated', // browser override
    maxBeats: 8,
    maxRuntimeSec: 110,
    repairAttempts: 2,
  },

  agents: {
    maxSteps: 24,
    maxParallel: 4,
    traceRetention: 500,
    qaStrictness: 'standard' as 'lenient' | 'standard' | 'strict',
  },

  pedagogy: {
    masteryThreshold: 0.8,
    strugglingThreshold: 0.45,
    maxPrereqTraceDepth: 6,
    sessionMaxItems: 40,
    cognitiveLoadCeiling: 0.78,
    defaultGrade: 6,
  },

  features: {
    experiments: true,
    webhooks: true,
    ws: true,
    openapi: true,
    jobs: true,
  },
} as const;

export type Config = typeof config;
