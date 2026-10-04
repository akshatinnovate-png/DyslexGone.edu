import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader (no dependency) - real env always wins. */
function loadDotEnv(file = '.env'): void {
  const p = resolve(process.cwd(), file);
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const str = (k: string, d: string): string => process.env[k] ?? d;
const num = (k: string, d: number): number => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (k: string, d: boolean): boolean => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v);
};

export type LlmMode = 'auto' | 'anthropic' | 'openai' | 'deterministic';

export const config = {
  env: str('NODE_ENV', 'development'),
  get isProd() { return this.env === 'production'; },

  server: {
    host: str('HOST', '0.0.0.0'),
    port: num('PORT', 8080),
    bodyLimitBytes: num('BODY_LIMIT_BYTES', 24 * 1024 * 1024),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 120_000),
    trustProxy: bool('TRUST_PROXY', false),
  },

  log: {
    level: str('LOG_LEVEL', 'info') as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent',
    pretty: bool('LOG_PRETTY', true),
    redactKeys: str('LOG_REDACT', 'authorization,x-api-key,api_key,apiKey,password,token').split(','),
  },

  db: {
    file: str('DB_FILE', './data/lumen.sqlite'),
    walMode: bool('DB_WAL', true),
    busyTimeoutMs: num('DB_BUSY_TIMEOUT_MS', 5000),
  },

  auth: {
    enabled: bool('AUTH_ENABLED', false),
    rootKey: str('ROOT_API_KEY', ''),
    webhookSecretPepper: str('WEBHOOK_PEPPER', 'lumen-dev-pepper'),
  },

  rateLimit: {
    enabled: bool('RATE_LIMIT_ENABLED', true),
    windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
    max: num('RATE_LIMIT_MAX', 600),
    burst: num('RATE_LIMIT_BURST', 60),
  },

  llm: {
    mode: str('LLM_MODE', 'auto') as LlmMode,
    anthropicKey: str('ANTHROPIC_API_KEY', ''),
    anthropicBaseUrl: str('ANTHROPIC_BASE_URL', ''),
    openaiKey: str('OPENAI_API_KEY', ''),
    openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiModel: str('OPENAI_MODEL', 'gpt-4o-mini'),
    // Tiered routing: the orchestrator asks for a tier, the router picks the model.
    modelFast: str('LLM_MODEL_FAST', 'claude-haiku-4-5-20251001'),
    modelBalanced: str('LLM_MODEL_BALANCED', 'claude-sonnet-5-5'),
    modelDeep: str('LLM_MODEL_DEEP', 'claude-opus-5'),
    maxTokens: num('LLM_MAX_TOKENS', 4096),
    temperature: num('LLM_TEMPERATURE', 0.3),
    timeoutMs: num('LLM_TIMEOUT_MS', 90_000),
    retries: num('LLM_RETRIES', 2),
    cacheEnabled: bool('LLM_CACHE', true),
    cacheTtlMs: num('LLM_CACHE_TTL_MS', 6 * 60 * 60 * 1000),
    // Hard spend ceiling per process lifetime (USD). 0 = unlimited.
    budgetUsd: num('LLM_BUDGET_USD', 0),
    perRequestBudgetUsd: num('LLM_REQUEST_BUDGET_USD', 0.75),
  },

  agents: {
    maxSteps: num('AGENT_MAX_STEPS', 24),
    maxParallel: num('AGENT_MAX_PARALLEL', 4),
    traceRetention: num('AGENT_TRACE_RETENTION', 500),
    qaStrictness: str('QA_STRICTNESS', 'standard') as 'lenient' | 'standard' | 'strict',
  },

  pedagogy: {
    masteryThreshold: num('MASTERY_THRESHOLD', 0.8),
    strugglingThreshold: num('STRUGGLING_THRESHOLD', 0.45),
    maxPrereqTraceDepth: num('MAX_PREREQ_DEPTH', 6),
    sessionMaxItems: num('SESSION_MAX_ITEMS', 40),
    cognitiveLoadCeiling: num('COG_LOAD_CEILING', 0.78),
    defaultGrade: num('DEFAULT_GRADE', 6),
  },

  features: {
    experiments: bool('FEATURE_EXPERIMENTS', true),
    webhooks: bool('FEATURE_WEBHOOKS', true),
    ws: bool('FEATURE_WS', true),
    openapi: bool('FEATURE_OPENAPI', true),
    jobs: bool('FEATURE_JOBS', true),
  },
} as const;

export type Config = typeof config;
