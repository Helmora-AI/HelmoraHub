import type { AgentConfig, ProviderToggle } from '../types.js';
import type { StoredHubModel } from './types.js';

export type CatalogModelKind = 'provider' | 'meta' | 'agent';

export type CatalogModelPublicSource =
  | 'manual'
  | 'discovered'
  | 'seed'
  | 'builtin'
  | 'agent_reference';

export type CatalogModelResponse = {
  catalogId: string | null;
  key: string;
  /** @deprecated Prefer modelId — upstream id for older clients */
  id: string;
  modelId: string;
  displayName: string;
  providerId: string | null;
  providerLabel: string | null;
  kind: CatalogModelKind;
  source: CatalogModelPublicSource;
  notes: string | null;
  enabled: boolean;
  isDefault: boolean;
  isBenchmark: boolean;
  routable: boolean;
  mutable: boolean;
  canDelete: boolean;
  canRename: boolean;
  lockReasons: string[];
  createdAt: string | null;
  updatedAt: string | null;
  billing: string;
  inputPricePerMTok: string | null;
  outputPricePerMTok: string | null;
  poolEligible: boolean;
  health: string;
  contextWindow: number | null;
  capabilities: string[];
  tier: number | null;
  protocol: string | null;
  catalogReady: boolean | null;
  deprecated: boolean;
  lastCheckedAt: string | null;
};

function iso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function lockReasonsForModel(
  model: StoredHubModel,
  agents: AgentConfig[]
): string[] {
  const reasons: string[] = [];
  if (model.isDefault) reasons.push('default_model');
  if (model.isBenchmark) reasons.push('benchmark_model');
  // Conservative: agents store bare modelId (no provider) — may over-block.
  if (agents.some((a) => a.model === model.modelId)) reasons.push('agent_reference');
  return reasons;
}

export function toCatalogModelResponse(
  model: StoredHubModel,
  provider: ProviderToggle | undefined,
  agents: AgentConfig[]
): CatalogModelResponse {
  const lockReasons = lockReasonsForModel(model, agents);
  const canRename = !lockReasons.includes('default_model') &&
    !lockReasons.includes('benchmark_model') &&
    !lockReasons.includes('agent_reference');
  const canDelete = !lockReasons.includes('agent_reference');
  const routable = Boolean(
    model.enabled && provider?.enabled && provider.verifyStatus === 'ok'
  );
  return {
    catalogId: model.id,
    key: model.id,
    id: model.modelId,
    modelId: model.modelId,
    displayName: model.displayName,
    providerId: model.providerId,
    providerLabel: provider?.label ?? null,
    kind: 'provider',
    source: model.source,
    notes: model.notes,
    enabled: model.enabled,
    isDefault: model.isDefault,
    isBenchmark: model.isBenchmark,
    routable,
    mutable: true,
    canDelete,
    canRename,
    lockReasons,
    createdAt: iso(model.createdAt),
    updatedAt: iso(model.updatedAt),
    billing: model.billing ?? 'unknown',
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    poolEligible: Boolean(provider && provider.tier === 3),
    health: 'unknown',
    contextWindow: model.contextWindow,
    capabilities: model.capabilities ?? [],
    tier: provider?.tier ?? null,
    protocol: provider?.protocol ?? null,
    catalogReady: provider?.catalogReady ?? null,
    deprecated: false,
    lastCheckedAt: null,
  };
}

export function metaCatalogRow(args: {
  modelId: string;
  displayName?: string;
}): CatalogModelResponse {
  return {
    catalogId: null,
    key: `meta:${args.modelId}`,
    id: args.modelId,
    modelId: args.modelId,
    displayName: args.displayName ?? args.modelId,
    providerId: 'helmora',
    providerLabel: 'Helmora AI',
    kind: 'meta',
    source: 'builtin',
    notes: null,
    enabled: true,
    isDefault: false,
    isBenchmark: false,
    routable: true,
    mutable: false,
    canDelete: false,
    canRename: false,
    lockReasons: ['builtin'],
    createdAt: null,
    updatedAt: null,
    billing: 'unknown',
    inputPricePerMTok: null,
    outputPricePerMTok: null,
    poolEligible: false,
    health: 'unknown',
    contextWindow: null,
    capabilities: [],
    tier: 0,
    protocol: 'meta',
    catalogReady: true,
    deprecated: false,
    lastCheckedAt: null,
  };
}

export function agentCatalogRow(args: {
  agentId: string;
  nickname: string;
  modelId: string;
  mode: string;
}): CatalogModelResponse {
  return {
    catalogId: null,
    key: `agent:${args.agentId}:${args.modelId}`,
    id: args.modelId,
    modelId: args.modelId,
    displayName: args.modelId,
    providerId: `agent/${args.agentId}`,
    providerLabel: args.nickname,
    kind: 'agent',
    source: 'agent_reference',
    notes: null,
    enabled: true,
    isDefault: false,
    isBenchmark: false,
    routable: true,
    mutable: false,
    canDelete: false,
    canRename: false,
    lockReasons: ['agent_reference'],
    createdAt: null,
    updatedAt: null,
    billing: 'unknown',
    inputPricePerMTok: null,
    outputPricePerMTok: null,
    poolEligible: false,
    health: 'unknown',
    contextWindow: null,
    capabilities: [],
    tier: null,
    protocol: args.mode,
    catalogReady: true,
    deprecated: false,
    lastCheckedAt: null,
  };
}
