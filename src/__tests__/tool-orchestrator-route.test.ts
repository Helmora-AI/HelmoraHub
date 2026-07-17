import { describe, expect, it } from 'vitest';
import type { StoredHubModel } from '../models/types.js';
import type { ProviderToggle } from '../types.js';
import { resolveToolOrchestratorAttempts } from '../services/tool-orchestrator-route.js';
import { normalizeToolRuntimeConfig } from '../services/tool-config.js';

function model(id: string, providerId: string, capabilities: string[] | null): StoredHubModel {
  return {
    id,
    providerId,
    modelId: `${id}-upstream`,
    displayName: id,
    source: 'manual',
    notes: null,
    enabled: true,
    isDefault: false,
    isBenchmark: false,
    billing: null,
    inputPricePerMTok: null,
    outputPricePerMTok: null,
    contextWindow: null,
    capabilities,
    createdAt: 1,
    updatedAt: 1,
  };
}

function provider(id: string): ProviderToggle {
  return {
    id,
    label: id,
    enabled: true,
    baseUrl: `https://${id}.example/v1`,
    apiKey: 'test-key',
    defaultModel: `${id}-default`,
    allowedModes: ['smart'],
    capabilities: ['chat', 'tools'],
    protocol: 'openai',
    authStyle: 'bearer',
    authMode: 'api-key',
    oauthState: 'not_configured',
    benchmarkModel: null,
    pinnedModels: [],
    verifyStatus: 'ok',
    verifyError: null,
    verifiedAt: 1,
    source: 'custom',
    catalogReady: true,
    extraHeaders: null,
    timeoutMs: 60_000,
  };
}

describe('tool orchestrator routing', () => {
  it('skips an explicitly non-tool model and selects the configured fallback', () => {
    const config = normalizeToolRuntimeConfig({
      version: 1,
      enabled: true,
      orchestrator: { primaryCatalogId: 'primary', fallbackCatalogId: 'fallback' },
      connectors: {
        tinyfish: {
          enabled: true,
          searchRequestsPerMinute: 25,
          fetchUrlsPerMinute: 120,
          searchCacheSeconds: 60,
          fetchCacheSeconds: 300,
        },
      },
      toolOverrides: [],
    });

    const resolution = resolveToolOrchestratorAttempts(
      config,
      [model('primary', 'provider-a', []), model('fallback', 'provider-b', ['tools'])],
      [provider('provider-a'), provider('provider-b')],
    );

    expect(resolution.attempts).toMatchObject([
      {
        slot: 'fallback',
        catalogId: 'fallback',
        modelId: 'fallback-upstream',
        provider: { id: 'provider-b' },
      },
    ]);
    expect(resolution.skipped).toContainEqual({
      slot: 'primary',
      catalogId: 'primary',
      reason: 'model_tools_unsupported',
    });
  });

  it('accepts legacy models with unknown capabilities when the provider supports tools', () => {
    const config = normalizeToolRuntimeConfig({
      version: 1,
      enabled: true,
      orchestrator: { primaryCatalogId: 'legacy', fallbackCatalogId: null },
      connectors: {
        tinyfish: {
          enabled: true,
          searchRequestsPerMinute: 25,
          fetchUrlsPerMinute: 120,
          searchCacheSeconds: 60,
          fetchCacheSeconds: 300,
        },
      },
      toolOverrides: [],
    });

    expect(resolveToolOrchestratorAttempts(
      config,
      [model('legacy', 'provider-a', null)],
      [provider('provider-a')],
    ).attempts).toHaveLength(1);
  });
});
