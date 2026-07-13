import type { ModelPricing, TokenUsage } from '../keys/types.js';
// Ported from 9Router open-sse/providers/pricing.js
import {
  MODEL_PRICING,
  PROVIDER_PRICING,
  PATTERN_PRICING,
  matchPattern,
  getPricingForModel as rawGetPricing,
  calculateCostFromTokens as rawCalculate,
  formatCost,
} from './catalog-raw.mjs';

export { MODEL_PRICING, PROVIDER_PRICING, PATTERN_PRICING, matchPattern, formatCost };

export type PricingOverrideMap = Record<string, ModelPricing>;

/** In-memory overrides (also persisted via settings JSON). */
let runtimeOverrides: PricingOverrideMap = {};

export function setPricingOverrides(map: PricingOverrideMap): void {
  runtimeOverrides = { ...map };
}

export function getPricingOverrides(): PricingOverrideMap {
  return { ...runtimeOverrides };
}

export function getPricingForModel(
  model: string,
  provider?: string | null
): ModelPricing | null {
  const base = model.includes('/') ? model.split('/').pop()! : model;
  if (runtimeOverrides[model]) return runtimeOverrides[model];
  if (runtimeOverrides[base]) return runtimeOverrides[base];
  return (rawGetPricing(provider ?? '', model) as ModelPricing | null) ?? null;
}

export function calculateCostFromTokens(
  tokens: TokenUsage | null | undefined,
  pricing: ModelPricing | null | undefined
): number {
  if (!tokens || !pricing) return 0;
  return Number(rawCalculate(tokens, pricing)) || 0;
}

/** Estimate tokens when upstream/demo does not return usage. */
export function estimateTokensFromText(promptChars: number, completionChars: number): TokenUsage {
  // ~4 chars/token heuristic
  return {
    prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
    completion_tokens: Math.max(1, Math.ceil(completionChars / 4)),
  };
}

export function costForModel(
  model: string,
  tokens: TokenUsage,
  provider?: string | null
): number {
  const pricing = getPricingForModel(model, provider);
  return calculateCostFromTokens(tokens, pricing);
}

/** Meta route: average of per-model costs (missing pricing → 0). */
export function averageModelCosts(
  models: string[],
  tokens: TokenUsage,
  providerByModel?: Record<string, string>
): number {
  if (models.length === 0) return 0;
  const sum = models.reduce((acc, m) => {
    const provider = providerByModel?.[m];
    return acc + costForModel(m, tokens, provider);
  }, 0);
  return sum / models.length;
}

export function listCatalogModels(limit = 200): Array<{ id: string; pricing: ModelPricing }> {
  const entries = Object.entries(MODEL_PRICING as Record<string, ModelPricing>).slice(0, limit);
  return entries.map(([id, pricing]) => ({ id, pricing }));
}
