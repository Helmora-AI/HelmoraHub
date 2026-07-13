import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { hashApiKey } from '../keys/generate.js';
import { HybridConfigStore } from '../storage/hybrid-store.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';

function makeSqlite(dir: string): SqliteConfigStore {
  const config = loadConfig();
  config.dataDir = dir;
  config.dbPath = path.join(dir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.rateBackend = 'memory';
  config.encryptionKey = 'test-hybrid-encryption-key-32ch!!';
  config.upstreamBaseUrl = null;
  config.upstreamApiKey = null;
  config.upstreamModel = null;
  return new SqliteConfigStore(config);
}

describe('HybridConfigStore online', () => {
  const dirs: string[] = [];
  let hybrid: HybridConfigStore | null = null;
  let control: SqliteConfigStore | null = null;
  let workspace: SqliteConfigStore | null = null;

  afterEach(async () => {
    if (hybrid) await hybrid.close();
    hybrid = null;
    control = null;
    workspace = null;
    for (const d of dirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function openHybrid(): HybridConfigStore {
    const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-ctrl-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-ws-'));
    dirs.push(controlDir, workspaceDir);
    control = makeSqlite(controlDir);
    workspace = makeSqlite(workspaceDir);
    hybrid = new HybridConfigStore({
      control,
      workspace,
      vault: workspace.getControlVault(),
      hybrid: true,
    });
    return hybrid;
  }

  it('mirrors createApiKey to vault after control write', async () => {
    const h = openHybrid();
    const created = await h.createApiKey({ name: 't', keyEnv: 'dev' });
    expect(created.plaintext.startsWith('hel_dev_')).toBe(true);

    const vaultRow = workspace!.getControlVault().getApiKey(created.record.id);
    expect(vaultRow?.keyHash).toBe(hashApiKey(created.plaintext));
    expect(await control!.getApiKeyById(created.record.id)).toBeTruthy();
  });

  it('mirrors provider updates to vault', async () => {
    const h = openHybrid();
    const updated = await h.updateProvider('groq', {
      label: 'Groq Mirror',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    expect(updated?.label).toBe('Groq Mirror');
    expect(workspace!.getControlVault().getProvider('groq')?.label).toBe('Groq Mirror');
  });

  it('keeps usage on workspace only (never control remote)', async () => {
    const h = openHybrid();
    await h.recordUsage({
      requestId: 'req-1',
      source: 'api',
      apiKeyId: null,
      status: 'complete',
      model: 'test',
      underlyingModels: [],
      providerId: 'groq',
      costMicrosUsd: 1000,
      promptTokens: 1,
      completionTokens: 1,
      estimated: false,
    });
    const wsUsage = await workspace!.listUsage({ limit: 10 });
    expect(wsUsage).toHaveLength(1);
    const ctrlUsage = await control!.listUsage({ limit: 10 });
    expect(ctrlUsage).toHaveLength(0);
  });

  it('local-only hybrid=false delegates to workspace without requiring control', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-local-'));
    dirs.push(workspaceDir);
    workspace = makeSqlite(workspaceDir);
    hybrid = new HybridConfigStore({
      control: workspace,
      workspace,
      vault: workspace.getControlVault(),
      hybrid: false,
    });
    const created = await hybrid.createApiKey({ name: 'local', keyEnv: 'dev' });
    expect(created.record.name).toBe('local');
    expect(await workspace.getApiKeyById(created.record.id)).toBeTruthy();
  });
});
