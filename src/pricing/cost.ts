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

/** Demo / echo builtins — not market models. */
const ZERO_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  cache_creation: 0,
};

function pricingCandidates(model: string): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    const t = v?.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  push(model);
  // org/model:tag → try without :tag (OpenRouter :free / Ollama tags)
  if (model.includes(':')) push(model.slice(0, model.indexOf(':')));
  for (const c of [...out]) {
    if (c.includes('/')) push(c.split('/').pop());
  }
  return out;
}

export function getPricingForModel(
  model: string,
  provider?: string | null
): ModelPricing | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;

  // Hub demo / echo paths stay $0.
  if (/^demo\//i.test(trimmed)) {
    return ZERO_PRICING;
  }

  // Free-tier suffixes (:free) still estimate at market rates for the base model id.
  const freeTier = /:free$/i.test(trimmed);

  for (const candidate of pricingCandidates(trimmed)) {
    if (freeTier) {
      // Don't ask raw pricing with the `:free` suffix (it strips to `auto` for auto:free).
      if (/:free$/i.test(candidate)) continue;
      // Avoid the generic OpenRouter `auto` placeholder rate.
      if (candidate.toLowerCase() === 'auto') continue;
    }

    if (runtimeOverrides[candidate]) return runtimeOverrides[candidate];
    const hit = (rawGetPricing(provider ?? '', candidate) as ModelPricing | null) ?? null;
    if (hit) return hit;
  }
  return null;
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

/**
 * Label stored on usage events. Prefer the concrete upstream id (e.g. gemma3:27b)
 * over opaque catalog refs (catalog/mdl_…).
 */
export function usageModelLabel(args: {
  requestedModel: string;
  routedModel: string;
}): string {
  const routed = args.routedModel?.trim();
  if (routed && routed !== 'auto') return routed;
  return args.requestedModel;
}

/**
 * Model id used for pricing. Prefer the model actually routed — never let a stale
 * provider.defaultModel mask the selected catalog/upstream id.
 */
export function billingModelId(args: {
  requestedModel: string;
  routedModel: string;
  defaultModel?: string | null;
}): string {
  const routed = args.routedModel?.trim();
  if (routed && routed !== 'auto') return routed;
  const def = args.defaultModel?.trim();
  if (def) return def;
  return args.requestedModel;
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
