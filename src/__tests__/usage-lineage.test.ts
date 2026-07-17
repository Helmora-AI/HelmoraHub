import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../lib/config.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';

function config(): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: '.',
    dbPath: ':memory:',
    apiKeyEnv: null,
    upstreamBaseUrl: null,
    upstreamApiKey: null,
    upstreamModel: null,
    encryptionKey: 'usage-lineage-test-key',
    storageBackend: 'sqlite',
    storageChoice: 'local',
    rateBackend: 'memory',
    supabaseUrl: null,
    supabaseServiceRoleKey: null,
    redisUrl: null,
    publicUrl: null,
    frontendUrl: null,
  };
}

describe('usage lineage', () => {
  const stores: SqliteConfigStore[] = [];
  afterEach(async () => Promise.all(stores.splice(0).map((store) => store.close())));

  it('records multiple model rounds idempotently under one parent request', async () => {
    const store = new SqliteConfigStore(config());
    stores.push(store);
    const base = {
      requestId: 'req_parent:planner:0',
      parentRequestId: 'req_parent',
      toolRunId: 'toolrun_parent',
      source: 'admin_chat' as const,
      apiKeyId: null,
      status: 'complete' as const,
      model: 'planner-model',
      underlyingModels: ['planner-model'],
      providerId: 'planner-provider',
      miniRole: null,
      miniSlot: null,
      miniCatalogId: null,
      usagePhase: 'tool_planner' as const,
      costMicrosUsd: 12,
      promptTokens: 10,
      completionTokens: 2,
      estimated: false,
    };

    const first = await store.recordUsage({ ...base, toolRound: 0 });
    const duplicate = await store.recordUsage({ ...base, toolRound: 0, costMicrosUsd: 999 });
    const second = await store.recordUsage({
      ...base,
      requestId: 'req_parent:planner:1',
      toolRound: 1,
    });

    expect(duplicate.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(await store.listUsage({ limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parentRequestId: 'req_parent',
        toolRunId: 'toolrun_parent',
        usagePhase: 'tool_planner',
        toolRound: 0,
        costMicrosUsd: 12,
      }),
      expect.objectContaining({ toolRound: 1 }),
    ]));
  });
});
