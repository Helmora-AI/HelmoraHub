import type { StoredHubModel } from '../models/types.js';
import { nativeToolCapabilityFor } from '../providers/native-tools.js';
import type { ProviderToggle } from '../types.js';
import type { ToolRuntimeConfig } from '../tools/types.js';

export type ToolOrchestratorSlot = 'primary' | 'fallback';

export type ToolOrchestratorAttempt = {
  slot: ToolOrchestratorSlot;
  catalogId: string;
  provider: ProviderToggle;
  modelId: string;
};

export type ToolOrchestratorSkipReason =
  | 'catalog_missing'
  | 'provider_missing'
  | 'model_disabled'
  | 'provider_disabled'
  | 'provider_degraded'
  | 'credentials_required'
  | 'native_tool_calling_unsupported'
  | 'model_tools_unsupported';

export type ToolOrchestratorResolution = {
  configured: boolean;
  attempts: ToolOrchestratorAttempt[];
  skipped: Array<{
    slot: ToolOrchestratorSlot;
    catalogId: string;
    reason: ToolOrchestratorSkipReason;
  }>;
};

function providerNeedsCredentials(provider: ProviderToggle): boolean {
  if (!provider.baseUrl) return true;
  if (provider.authStyle === 'none' || provider.protocol === 'keyless') return false;
  if (provider.authMode === 'oauth') return provider.oauthState !== 'connected';
  return !provider.apiKey;
}

export function resolveToolOrchestratorAttempts(
  config: ToolRuntimeConfig,
  catalog: readonly StoredHubModel[],
  providers: readonly ProviderToggle[],
): ToolOrchestratorResolution {
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const attempts: ToolOrchestratorAttempt[] = [];
  const skipped: ToolOrchestratorResolution['skipped'] = [];
  const slots: Array<[ToolOrchestratorSlot, string | null]> = [
    ['primary', config.orchestrator.primaryCatalogId],
    ['fallback', config.orchestrator.fallbackCatalogId],
  ];

  for (const [slot, catalogId] of slots) {
    if (!catalogId) continue;
    const model = catalogById.get(catalogId);
    if (!model) {
      skipped.push({ slot, catalogId, reason: 'catalog_missing' });
      continue;
    }
    const provider = providersById.get(model.providerId);
    if (!provider) {
      skipped.push({ slot, catalogId, reason: 'provider_missing' });
      continue;
    }
    if (!model.enabled) {
      skipped.push({ slot, catalogId, reason: 'model_disabled' });
      continue;
    }
    if (!provider.enabled) {
      skipped.push({ slot, catalogId, reason: 'provider_disabled' });
      continue;
    }
    if (provider.verifyStatus !== 'ok' || !provider.catalogReady) {
      skipped.push({ slot, catalogId, reason: 'provider_degraded' });
      continue;
    }
    if (providerNeedsCredentials(provider)) {
      skipped.push({ slot, catalogId, reason: 'credentials_required' });
      continue;
    }
    if (!nativeToolCapabilityFor(provider)) {
      skipped.push({ slot, catalogId, reason: 'native_tool_calling_unsupported' });
      continue;
    }
    if (model.capabilities != null && !model.capabilities.includes('tools')) {
      skipped.push({ slot, catalogId, reason: 'model_tools_unsupported' });
      continue;
    }
    attempts.push({ slot, catalogId, provider, modelId: model.modelId });
  }

  return {
    configured: slots.some(([, catalogId]) => Boolean(catalogId)),
    attempts,
    skipped,
  };
}
