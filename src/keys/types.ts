export type ModelPricing = {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
  cache_creation?: number;
};

export type TokenUsage = {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
};

export type ApiKeyEnv = 'dev' | 'pro';

export type ApiKeyRecord = {
  id: string;
  name: string;
  keyEnv: ApiKeyEnv;
  keyPrefix: string;
  keyHash: string;
  keyHint: string;
  budgetUsd: number | null;
  spentUsd: number;
  expiresAt: number | null;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

export type ApiKeyPublic = Omit<ApiKeyRecord, 'keyHash'> & {
  keyPreview: string;
  remainingUsd: number | null;
  expired: boolean;
  overBudget: boolean;
};

export type CreateApiKeyInput = {
  name: string;
  keyEnv: ApiKeyEnv;
  budgetUsd?: number | null;
  expiresAt?: number | null;
  plaintext?: string;
  /** When set (e.g. outbox replay), preserve this id instead of generating one. */
  id?: string;
};

export type UsageEventStatus = 'complete' | 'stopped' | 'error';
export type UsageEventSource = 'api' | 'admin_chat';

export type UsageEvent = {
  id: string;
  requestId: string;
  source: UsageEventSource;
  /** null for admin_chat — never a sentinel key id */
  apiKeyId: string | null;
  status: UsageEventStatus;
  model: string;
  underlyingModels: string[];
  providerId: string | null;
  /** Integer micros of USD (1e-6). Source of truth for cost. */
  costMicrosUsd: number;
  promptTokens: number | null;
  completionTokens: number | null;
  estimated: boolean;
  createdAt: number;
};

/** Display helper — float USD from micros. */
export function usageCostUsd(event: Pick<UsageEvent, 'costMicrosUsd'>): number {
  return (Number(event.costMicrosUsd) || 0) / 1_000_000;
}

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * 1_000_000);
}

/** Canonical id returned in /v1/models and response headers. */
export const META_MODEL_ID = 'helmora-mini-1.0';

export const META_MODEL_IDS = new Set([
  META_MODEL_ID,
  'helmora_mini_1.0',
  'helmora-mini',
  'helmora_mini',
  // Legacy aliases (still resolve as meta routing)
  'control_mini_1.0',
  'control-mini-1.0',
  'ctrl-mini',
  'ctrl_mini',
  'control-mini',
]);

export function isMetaModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return META_MODEL_IDS.has(model.trim().toLowerCase());
}
