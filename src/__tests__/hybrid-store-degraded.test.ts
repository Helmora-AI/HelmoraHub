import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { hashApiKey } from '../keys/generate.js';
import { createControlPlane, recordRemoteFailure } from '../storage/control-plane.js';
import { HybridConfigStore } from '../storage/hybrid-store.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import type { ConfigStore } from '../storage/types.js';

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

/** Control store that fails every call (simulates Supabase down). */
function failingControl(inner: ConfigStore): ConfigStore {
  const fail = async () => {
    throw new Error('supabase_unreachable');
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'backend') return 'supabase';
      if (prop === 'close') return () => target.close();
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => fail();
      }
      return value;
    },
  }) as ConfigStore;
}

describe('HybridConfigStore degraded', () => {
  const dirs: string[] = [];
  let hybrid: HybridConfigStore | null = null;
  let controlInner: SqliteConfigStore | null = null;
  let workspace: SqliteConfigStore | null = null;

  afterEach(async () => {
    if (hybrid) await hybrid.close();
    hybrid = null;
    controlInner = null;
    workspace = null;
    for (const d of dirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  async function openSyncedHybrid(): Promise<HybridConfigStore> {
    const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-dctrl-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-dws-'));
    dirs.push(controlDir, workspaceDir);
    controlInner = makeSqlite(controlDir);
    workspace = makeSqlite(workspaceDir);
    hybrid = new HybridConfigStore({
      control: controlInner,
      workspace,
      vault: workspace.getControlVault(),
      hybrid: true,
    });
    await hybrid.refreshVaultFromControl();
    return hybrid;
  }

  it('enters degraded after 2 remote failures', async () => {
    const h = await openSyncedHybrid();
    // Swap control to failing after vault is warm
    h.setControlForTests(failingControl(controlInner!));

    await expect(h.listProviders()).rejects.toThrow(/supabase_unreachable/);
    expect(h.getPlane().state).toBe('online');
    expect(h.getPlane().failureCount).toBe(1);

    await expect(h.listProviders()).rejects.toThrow(/supabase_unreachable/);
    expect(h.getPlane().state).toBe('degraded');
    expect(h.getControlHealth().controlPlane).toBe('degraded');
  });

  it('serves providers and api key hash lookup from vault when degraded', async () => {
    const h = await openSyncedHybrid();
    const created = await h.createApiKey({ name: 'live', keyEnv: 'dev' });
    expect(workspace!.getControlVault().getApiKey(created.record.id)).toBeTruthy();

    let plane = createControlPlane();
    plane = recordRemoteFailure(plane, 1);
    plane = recordRemoteFailure(plane, 2);
    h.setPlaneForTests(plane);

    const providers = await h.listProviders();
    expect(providers.some((p) => p.id === 'groq')).toBe(true);

    const found = await h.findApiKeyByHash(hashApiKey(created.plaintext));
    expect(found?.id).toBe(created.record.id);
    expect(h.getControlHealth().outboxPending).toBe(0);
  });

  it('queues create/modify/delete api key on outbox while degraded', async () => {
    const h = await openSyncedHybrid();
    let plane = createControlPlane();
    plane = recordRemoteFailure(plane, 1);
    plane = recordRemoteFailure(plane, 2);
    h.setPlaneForTests(plane);

    const created = await h.createApiKey({ name: 'offline', keyEnv: 'dev' });
    expect(created.plaintext.startsWith('hel_dev_')).toBe(true);
    expect(h.getControlHealth().outboxPending).toBe(1);
    expect(workspace!.getControlVault().listPendingOutbox()[0]?.action).toBe('add');

    await h.updateApiKey(created.record.id, { name: 'offline-renamed' });
    expect(h.getControlHealth().outboxPending).toBe(2);
    expect((await h.listApiKeys()).find((k) => k.id === created.record.id)?.name).toBe(
      'offline-renamed'
    );

    await h.deleteApiKey(created.record.id);
    expect(h.getControlHealth().outboxPending).toBe(3);
    expect(await h.getApiKeyById(created.record.id)).toBeNull();
    const actions = workspace!.getControlVault().listPendingOutbox().map((o) => o.action);
    expect(actions).toEqual(['add', 'modify', 'delete']);
  });

  it('queues provider patch on outbox while degraded', async () => {
    const h = await openSyncedHybrid();
    let plane = createControlPlane();
    plane = recordRemoteFailure(plane, 1);
    plane = recordRemoteFailure(plane, 2);
    h.setPlaneForTests(plane);

    const updated = await h.updateProvider('groq', { label: 'Groq Offline' });
    expect(updated?.label).toBe('Groq Offline');
    expect(workspace!.getControlVault().getProvider('groq')?.label).toBe('Groq Offline');
    expect(h.getControlHealth().outboxPending).toBeGreaterThanOrEqual(1);
    expect(
      workspace!.getControlVault().listPendingOutbox().some((o) => o.entity === 'provider')
    ).toBe(true);
  });
});
