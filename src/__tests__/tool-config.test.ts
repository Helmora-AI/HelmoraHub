import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_RUNTIME_CONFIG,
  maskConnectorCredential,
  normalizeToolRuntimeConfig,
  validateToolRuntimeConfigDraft,
} from '../services/tool-config.js';
import { REGISTERED_CONNECTORS, REGISTERED_TOOLS } from '../tools/registry.js';

describe('tool runtime registry and configuration', () => {
  it('owns an immutable TinyFish Search and Fetch registry', () => {
    expect(REGISTERED_CONNECTORS).toEqual([
      { id: 'tinyfish', capabilities: ['search', 'fetch'] },
    ]);
    expect(REGISTERED_TOOLS.map((tool) => ({
      id: tool.id,
      connectorId: tool.connectorId,
      risk: tool.risk,
      immutable: tool.immutable,
    }))).toEqual([
      { id: 'web_search', connectorId: 'tinyfish', risk: 'read', immutable: true },
      { id: 'web_fetch', connectorId: 'tinyfish', risk: 'read', immutable: true },
    ]);
    expect(Object.isFrozen(REGISTERED_CONNECTORS)).toBe(true);
    expect(Object.isFrozen(REGISTERED_TOOLS)).toBe(true);
    expect(Object.isFrozen(REGISTERED_TOOLS[0]?.inputSchema)).toBe(true);
  });

  it('defaults the runtime and connector to disabled with conservative Free limits', () => {
    expect(DEFAULT_TOOL_RUNTIME_CONFIG).toEqual({
      version: 1,
      enabled: false,
      orchestrator: {
        primaryCatalogId: null,
        fallbackCatalogId: null,
      },
      connectors: {
        tinyfish: {
          enabled: false,
          searchRequestsPerMinute: 25,
          fetchUrlsPerMinute: 120,
          searchCacheSeconds: 60,
          fetchCacheSeconds: 300,
        },
      },
      toolOverrides: [
        {
          toolId: 'web_search',
          enabled: true,
          scopes: { mini: true, catalog: true, mode: true, direct: true },
        },
        {
          toolId: 'web_fetch',
          enabled: true,
          scopes: { mini: true, catalog: true, mode: true, direct: true },
        },
      ],
    });
  });

  it('normalizes persisted partial data into the complete canonical shape', () => {
    const normalized = normalizeToolRuntimeConfig({
      version: 1,
      enabled: true,
      orchestrator: {
        primaryCatalogId: ' mdl_primary ',
        fallbackCatalogId: '',
      },
      connectors: {
        tinyfish: {
          enabled: true,
          searchRequestsPerMinute: 20,
        },
      },
      toolOverrides: [
        {
          toolId: 'web_fetch',
          enabled: false,
          scopes: { mini: false, direct: false },
        },
      ],
    });

    expect(normalized).toEqual({
      ...DEFAULT_TOOL_RUNTIME_CONFIG,
      enabled: true,
      orchestrator: {
        primaryCatalogId: 'mdl_primary',
        fallbackCatalogId: null,
      },
      connectors: {
        tinyfish: {
          ...DEFAULT_TOOL_RUNTIME_CONFIG.connectors.tinyfish,
          enabled: true,
          searchRequestsPerMinute: 20,
        },
      },
      toolOverrides: [
        DEFAULT_TOOL_RUNTIME_CONFIG.toolOverrides[0],
        {
          toolId: 'web_fetch',
          enabled: false,
          scopes: { mini: false, catalog: true, mode: true, direct: false },
        },
      ],
    });
  });

  it('rejects mutable registry fields, secrets, unknown tools, duplicates, and invalid limits', () => {
    const result = validateToolRuntimeConfigDraft({
      version: 1,
      enabled: true,
      orchestrator: {
        primaryCatalogId: 'mdl_same',
        fallbackCatalogId: 'mdl_same',
      },
      connectors: {
        tinyfish: {
          enabled: true,
          apiKey: 'must-not-be-in-settings',
          searchRequestsPerMinute: 31,
          fetchUrlsPerMinute: 0,
          searchCacheSeconds: -1,
          fetchCacheSeconds: 300,
        },
        http: {
          enabled: true,
        },
      },
      toolOverrides: [
        {
          toolId: 'web_search',
          enabled: true,
          connectorId: 'http',
          risk: 'write',
          inputSchema: {},
          scopes: { mini: true, catalog: true, mode: true, direct: true, office: true },
        },
        {
          toolId: 'web_search',
          enabled: false,
          scopes: { mini: true, catalog: true, mode: true, direct: true },
        },
        {
          toolId: 'unknown_tool',
          enabled: true,
          scopes: { mini: true, catalog: true, mode: true, direct: true },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'orchestrator.fallbackCatalogId', code: 'duplicate_orchestrator_model' }),
      expect.objectContaining({ path: 'connectors.tinyfish.apiKey', code: 'secret_not_allowed' }),
      expect.objectContaining({ path: 'connectors.tinyfish.searchRequestsPerMinute', code: 'out_of_range' }),
      expect.objectContaining({ path: 'connectors.tinyfish.fetchUrlsPerMinute', code: 'out_of_range' }),
      expect.objectContaining({ path: 'connectors.tinyfish.searchCacheSeconds', code: 'out_of_range' }),
      expect.objectContaining({ path: 'connectors.http', code: 'unknown_connector' }),
      expect.objectContaining({ path: 'toolOverrides.0.connectorId', code: 'server_owned_field' }),
      expect.objectContaining({ path: 'toolOverrides.0.risk', code: 'server_owned_field' }),
      expect.objectContaining({ path: 'toolOverrides.0.inputSchema', code: 'server_owned_field' }),
      expect.objectContaining({ path: 'toolOverrides.0.scopes.office', code: 'unknown_scope' }),
      expect.objectContaining({ path: 'toolOverrides.1.toolId', code: 'duplicate_tool_override' }),
      expect.objectContaining({ path: 'toolOverrides.2.toolId', code: 'unknown_tool' }),
    ]));
  });

  it('returns a canonical config for a valid complete draft', () => {
    const result = validateToolRuntimeConfigDraft(DEFAULT_TOOL_RUNTIME_CONFIG);
    expect(result).toEqual({ ok: true, config: DEFAULT_TOOL_RUNTIME_CONFIG });
  });

  it('masks connector credentials without returning the secret', () => {
    expect(maskConnectorCredential(null)).toEqual({
      credentialConfigured: false,
      credentialHint: null,
    });
    const masked = maskConnectorCredential('tinyfish-secret-1234');
    expect(masked).toEqual({
      credentialConfigured: true,
      credentialHint: '…1234',
    });
    expect(JSON.stringify(masked)).not.toContain('tinyfish-secret');
  });
});
