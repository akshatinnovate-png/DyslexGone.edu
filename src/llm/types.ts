import type { JsonSchema } from './jsonschema.js';

export type Tier = 'fast' | 'balanced' | 'deep';
export type ProviderName = 'anthropic' | 'groq' | 'openai' | 'deterministic';

export interface GenMessage { role: 'user' | 'assistant'; content: string; }

export interface GenRequest {
  /** Dotted purpose tag, e.g. 'lesson.compose' - drives cost accounting + offline handlers. */
  purpose: string;
  tier?: Tier;
  system?: string;
  messages: GenMessage[];
  maxTokens?: number;
  temperature?: number;
  stops?: string[];
  /** Ask for structured output validated against this schema. */
  schema?: JsonSchema;
  schemaName?: string;
  /** Stable seed so offline/deterministic generation is reproducible. */
  seed?: string;
  /** Skip the response cache. */
  noCache?: boolean;
  /** Extra context the offline provider may use to build a sensible answer. */
  offlineContext?: Record<string, unknown>;
}

export interface GenUsage { tokensIn: number; tokensOut: number; costUsd: number; }

export interface GenResponse<T = unknown> {
  text: string;
  json?: T;
  provider: ProviderName;
  model: string;
  usage: GenUsage;
  cached: boolean;
  ms: number;
  finishReason: 'stop' | 'length' | 'tool' | 'error' | 'offline';
  degraded: boolean;
  issues?: string[];
}

export interface LlmProvider {
  readonly name: ProviderName;
  available(): boolean;
  modelFor(tier: Tier): string;
  generate(req: GenRequest): Promise<GenResponse>;
}
