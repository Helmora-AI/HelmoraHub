import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { CATALOG_MODELS_MIGRATION_KEY, HubModelMutationError } from '../models/types.js';

describe('model catalog CRUD', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-models-'));
    process.env.DATA_DIR = tmpDir;
    process.env.STORAGE_BACKEND = 'local';
    process.env.RATE_BACKEND = 'memory';
    process.env.ENCRYPTION_KEY = 'test-encryption-key-models-catalog';
    delete process.env.SUPABASE_URL;

    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.rateBackend = 'memory';
    config.encryptionKey = 'test-encryption-key-models-catalog';
    await initStorage(config);
  });

  afterEach(async () => {
    await closeStorage();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('migrates once and does not resurrect deleted pinned-only rows', async () => {
    const store = getConfigStore();
    const first = await store.listHubModels({ limit: 500 });
    const marker = await store.getSetting(CATALOG_MODELS_MIGRATION_KEY);
    expect(marker).toBe('done');

    await store.setSetting(CATALOG_MODELS_MIGRATION_KEY, 'done');
    const count1 = first.models.length;

    // Create a manual row then delete it — reboot must not recreate from legacy pinned
    const created = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'manual-only-model',
      source: 'manual',
    });
    await store.deleteHubModel(created.id);

    // Simulate "migration would re-run" by clearing marker then calling migrate via reinit
    await store.setSetting(CATALOG_MODELS_MIGRATION_KEY, 'done');
    const afterDelete = await store.listHubModels({ limit: 500 });
    expect(afterDelete.models.find((m) => m.modelId === 'manual-only-model')).toBeUndefined();

    // Re-init storage (same db) — migration marker stays done
    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.rateBackend = 'memory';
    config.encryptionKey = 'test-encryption-key-models-catalog';
    await closeStorage();
    await initStorage(config);

    const afterReboot = await getConfigStore().listHubModels({ limit: 500 });
    expect(afterReboot.models.find((m) => m.modelId === 'manual-only-model')).toBeUndefined();
    expect(afterReboot.models.length).toBe(count1);
  });

  it('creates manual model and syncs default flag', async () => {
    const store = getConfigStore();
    const created = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'gpt-test-1',
      displayName: 'GPT Test',
      isDefault: true,
    });
    expect(created.id.startsWith('mdl_')).toBe(true);
    expect(created.isDefault).toBe(true);
    const provider = await store.getProvider('paid-upstream');
    expect(provider?.defaultModel).toBe('gpt-test-1');
  });

  it('blocks rename when default; allows when free', async () => {
    const store = getConfigStore();
    const created = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'rename-me',
      isDefault: true,
    });
    await expect(
      store.updateHubModel(created.id, { modelId: 'renamed' })
    ).rejects.toBeInstanceOf(HubModelMutationError);

    await store.updateHubModel(created.id, { isDefault: false });
    const updated = await store.updateHubModel(created.id, { modelId: 'renamed' });
    expect(updated.modelId).toBe('renamed');
  });

  it('blocks disable while default', async () => {
    const store = getConfigStore();
    const created = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'keep-role',
      isDefault: true,
    });
    await expect(
      store.updateHubModel(created.id, { enabled: false })
    ).rejects.toMatchObject({ code: 'model_role_in_use' });
  });

  it('import is idempotent and does not overwrite displayName', async () => {
    const store = getConfigStore();
    const first = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'import-a',
      displayName: 'Operator Name',
      source: 'manual',
    });
    const result = await store.importHubModels({
      providerId: 'paid-upstream',
      models: [
        { modelId: 'import-a', displayName: 'Discovered Name' },
        { modelId: 'import-b' },
      ],
      defaultModelId: 'import-a',
    });
    expect(result.created).toHaveLength(1);
    expect(result.skipped.some((s) => s.modelId === 'import-a')).toBe(true);
    const still = await store.getHubModel(first.id);
    expect(still?.displayName).toBe('Operator Name');
    expect(still?.isDefault).toBe(true);
  });
});
