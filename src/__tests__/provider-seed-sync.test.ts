import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { getCatalogEntry } from '../providers/catalog/index.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import {
  buildProviderSeedPatch,
  isUnset,
  normalizeExtraHeadersKey,
  shouldForceCatalogOwned,
  type SeedExistingSnapshot,
} from '../storage/provider-seed-sync.js';

function snapFrom(
  over: Partial<SeedExistingSnapshot> & Pick<SeedExistingSnapshot, 'label'>
): SeedExistingSnapshot {
  return {
    baseUrl: null,
    authStyle: 'bearer',
    protocol: 'openai',
    source: 'freellmapi',
    extraHeaders: null,
    catalogReady: true,
    capabilities: [],
    timeoutMs: null,
    defaultModel: null,
    benchmarkModel: null,
    ...over,
  };
}

describe('buildProviderSeedPatch (unit)', () => {
  it('treats null / empty / whitespace as unset', () => {
    expect(isUnset(null)).toBe(true);
    expect(isUnset('')).toBe(true);
    expect(isUnset('   ')).toBe(true);
    expect(isUnset('gpt')).toBe(false);
  });

  it('force-syncs catalog-owned fields for priority ids', () => {
    const catalog = getCatalogEntry('gemini')!;
    const existing = snapFrom({
      label: 'Stale Gemini',
      baseUrl: 'https://wrong.example/v1',
      authStyle: 'bearer',
      protocol: 'openai',
      catalogReady: false,
      capabilities: ['streaming'],
      source: '9router',
      defaultModel: 'keep-me',
      benchmarkModel: 'keep-bench',
    });
    const result = buildProviderSeedPatch(catalog, existing, {
      forceCatalogOwned: true,
      providerId: 'gemini',
    });
    expect(result).toBeTruthy();
    expect(result!.changedKeys).toEqual(
      expect.arrayContaining(['label', 'baseUrl', 'authStyle', 'protocol', 'catalogReady'])
    );
    expect(result!.patch.baseUrl).toBe(catalog.baseUrl);
    expect(result!.patch.label).toBe(catalog.label);
    expect(result!.patch.defaultModel).toBeUndefined();
    expect(result!.patch.benchmarkModel).toBeUndefined();
  });

  it('does not force baseUrl for non-priority when already set', () => {
    const catalog = getCatalogEntry('cohere')!;
    const custom = 'https://custom.example/v1';
    const result = buildProviderSeedPatch(
      catalog,
      snapFrom({
        label: catalog.label,
        baseUrl: custom,
        authStyle: catalog.authStyle,
        protocol: catalog.protocol,
        source: catalog.source,
        catalogReady: catalog.catalogReady,
        capabilities: catalog.capabilities,
        timeoutMs: catalog.timeoutMs ?? null,
        extraHeaders: catalog.extraHeaders ?? null,
        defaultModel: catalog.defaultModel,
        benchmarkModel: catalog.defaultModel,
      }),
      { forceCatalogOwned: false, providerId: 'cohere' }
    );
    expect(result).toBeNull();
    expect(custom).not.toBe(catalog.baseUrl);
  });

  it('fills unset models and leaves set models alone', () => {
    const catalog = getCatalogEntry('groq')!;
    const fill = buildProviderSeedPatch(
      catalog,
      snapFrom({
        label: catalog.label,
        baseUrl: catalog.baseUrl,
        authStyle: catalog.authStyle,
        protocol: catalog.protocol,
        source: catalog.source,
        catalogReady: catalog.catalogReady,
        capabilities: catalog.capabilities,
        defaultModel: '  ',
        benchmarkModel: null,
      }),
      { forceCatalogOwned: true, providerId: 'groq' }
    );
    expect(fill?.patch.defaultModel).toBe(catalog.defaultModel);
    expect(fill?.patch.benchmarkModel).toBe(catalog.defaultModel);

    const keep = buildProviderSeedPatch(
      catalog,
      snapFrom({
        label: catalog.label,
        baseUrl: catalog.baseUrl,
        authStyle: catalog.authStyle,
        protocol: catalog.protocol,
        source: catalog.source,
        catalogReady: catalog.catalogReady,
        capabilities: catalog.capabilities,
        defaultModel: 'user-model',
        benchmarkModel: 'user-bench',
      }),
      { forceCatalogOwned: true, providerId: 'groq' }
    );
    expect(keep).toBeNull();
  });

  it('replaces drifted extraHeaders as catalog-owned', () => {
    const catalog = getCatalogEntry('openrouter')!;
    expect(catalog.extraHeaders).toBeTruthy();
    const result = buildProviderSeedPatch(
      catalog,
      snapFrom({
        label: catalog.label,
        baseUrl: catalog.baseUrl,
        authStyle: catalog.authStyle,
        protocol: catalog.protocol,
        source: catalog.source,
        catalogReady: catalog.catalogReady,
        capabilities: catalog.capabilities,
        extraHeaders: { 'x-title': 'stale' },
        timeoutMs: catalog.timeoutMs ?? null,
        defaultModel: catalog.defaultModel,
        benchmarkModel: catalog.defaultModel,
      }),
      { forceCatalogOwned: true, providerId: 'openrouter' }
    );
    expect(result?.changedKeys).toContain('extraHeaders');
    expect(normalizeExtraHeadersKey(result!.patch.extraHeaders)).toBe(
      normalizeExtraHeadersKey(catalog.extraHeaders)
    );
  });

  it('never force-patches paid-upstream baseUrl from catalog', () => {
    const catalog = getCatalogEntry('paid-upstream')!;
    const result = buildProviderSeedPatch(
      catalog,
      snapFrom({
        label: 'Paid / custom upstream',
        baseUrl: 'https://my-upstream.example/v1',
        authStyle: 'bearer',
        protocol: 'custom',
        source: 'builtin',
        catalogReady: true,
        capabilities: catalog.capabilities,
        defaultModel: 'x',
        benchmarkModel: 'x',
      }),
      { forceCatalogOwned: true, providerId: 'paid-upstream' }
    );
    expect(result?.patch.baseUrl).toBeUndefined();
  });

  it('marks only priority ids for force catalog ownership', () => {
    expect(shouldForceCatalogOwned('gemini')).toBe(true);
    expect(shouldForceCatalogOwned('cohere')).toBe(false);
    expect(shouldForceCatalogOwned('paid-upstream')).toBe(false);
  });
});

describe('SQLite provider seed sync (integration)', () => {
  let tmpDir: string;
  let store: SqliteConfigStore | null = null;

  afterEach(async () => {
    if (store) {
      await store.close();
      store = null;
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function openStore(): SqliteConfigStore {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-seed-'));
    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.rateBackend = 'memory';
    config.encryptionKey = 'test-seed-sync-encryption-key';
    config.upstreamBaseUrl = null;
    config.upstreamApiKey = null;
    config.upstreamModel = null;
    store = new SqliteConfigStore(config);
    return store;
  }

  async function reopenSameDb(): Promise<SqliteConfigStore> {
    const dbPath = path.join(tmpDir, 'helmora.db');
    if (store) {
      await store.close();
      store = null;
    }
    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = dbPath;
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.rateBackend = 'memory';
    config.encryptionKey = 'test-seed-sync-encryption-key';
    config.upstreamBaseUrl = null;
    config.upstreamApiKey = null;
    config.upstreamModel = null;
    store = new SqliteConfigStore(config);
    return store;
  }

  it('force-syncs stale priority provider on boot', async () => {
    const s = openStore();
    await s.updateProvider('glm-cn', {
      label: 'Stale GLM',
      baseUrl: 'https://stale.example/v1',
    });
    const before = await s.getProvider('glm-cn');
    expect(before?.label).toBe('Stale GLM');

    const s2 = await reopenSameDb();
    const after = await s2.getProvider('glm-cn');
    const catalog = getCatalogEntry('glm-cn')!;
    expect(after?.label).toBe(catalog.label);
    expect(after?.baseUrl).toBe(catalog.baseUrl);
  });

  it('preserves custom baseUrl for non-priority providers', async () => {
    const s = openStore();
    const custom = 'https://custom-cohere.example/v1';
    await s.updateProvider('cohere', { baseUrl: custom });
    const s2 = await reopenSameDb();
    expect((await s2.getProvider('cohere'))?.baseUrl).toBe(custom);
  });

  it('does not force-sync paid-upstream baseUrl from catalog', async () => {
    const s = openStore();
    const custom = 'https://paid.example/v1';
    await s.updateProvider('paid-upstream', { baseUrl: custom });
    const s2 = await reopenSameDb();
    expect((await s2.getProvider('paid-upstream'))?.baseUrl).toBe(custom);
  });

  it('preserves secrets, enabled, and verify state for priority', async () => {
    const s = openStore();
    await s.updateProvider('groq', {
      apiKey: 'gsk-secret-keep',
      enabled: true,
      verifyStatus: 'ok',
      verifyError: null,
      verifiedAt: 1_700_000_000_000,
    });
    const s2 = await reopenSameDb();
    const groq = await s2.getProvider('groq');
    expect(groq?.apiKey).toBe('gsk-secret-keep');
    expect(groq?.enabled).toBe(true);
    expect(groq?.verifyStatus).toBe('ok');
    expect(groq?.verifiedAt).toBe(1_700_000_000_000);
  });

  it('fills unset models but keeps user models', async () => {
    const s = openStore();
    await s.updateProvider('mistral', {
      defaultModel: '',
      benchmarkModel: '   ',
    });
    await s.updateProvider('cerebras', {
      defaultModel: 'user-cerebras',
      benchmarkModel: 'user-bench',
    });

    const s2 = await reopenSameDb();
    const mistral = await s2.getProvider('mistral');
    const cerebras = await s2.getProvider('cerebras');
    expect(mistral?.defaultModel).toBe(getCatalogEntry('mistral')!.defaultModel);
    expect(mistral?.benchmarkModel).toBe(getCatalogEntry('mistral')!.defaultModel);
    expect(cerebras?.defaultModel).toBe('user-cerebras');
    expect(cerebras?.benchmarkModel).toBe('user-bench');
  });

  it('is idempotent on a second boot with no drift', async () => {
    openStore();
    const s2 = await reopenSameDb();
    const gemini = await s2.getProvider('gemini');
    expect(gemini?.label).toBe(getCatalogEntry('gemini')!.label);
    const s3 = await reopenSameDb();
    const again = await s3.getProvider('gemini');
    expect(again?.label).toBe(gemini?.label);
    expect(again?.baseUrl).toBe(gemini?.baseUrl);
    expect(again?.authStyle).toBe(gemini?.authStyle);
  });
});
