import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { createControlPlane, recordRemoteFailure } from '../storage/control-plane.js';
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

function forceDegraded(h: HybridConfigStore): void {
  let plane = createControlPlane();
  plane = recordRemoteFailure(plane, 1);
  plane = recordRemoteFailure(plane, 2);
  h.setPlaneForTests(plane);
}

describe('HybridConfigStore reconcile', () => {
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
    const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-rctrl-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-rws-'));
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

  it('replays degraded create+modify+delete and provider change then returns online', async () => {
    const h = await openSyncedHybrid();
    forceDegraded(h);

    const created = await h.createApiKey({ name: 'offline', keyEnv: 'dev' });
    await h.updateApiKey(created.record.id, { name: 'offline-renamed' });
    await h.deleteApiKey(created.record.id);
    await h.updateProvider('groq', { label: 'Groq Reconciled' });

    expect(h.getControlHealth().outboxPending).toBeGreaterThanOrEqual(4);
    expect(await controlInner!.getApiKeyById(created.record.id)).toBeNull();
    expect((await controlInner!.getProvider('groq'))?.label).not.toBe('Groq Reconciled');

    const health = await h.reconcile();
    expect(health.controlPlane).toBe('online');
    expect(health.vault).toBe('fresh');
    expect(health.outboxPending).toBe(0);
    expect(h.getPlane().state).toBe('online');

    expect(await controlInner!.getApiKeyById(created.record.id)).toBeNull();
    expect((await controlInner!.getProvider('groq'))?.label).toBe('Groq Reconciled');
    expect(workspace!.getControlVault().getProvider('groq')?.label).toBe('Groq Reconciled');
    expect(workspace!.getControlVault().getApiKey(created.record.id)).toBeNull();
  });

  it('replays create+modify+delete when Date.now is sticky (monotonic outbox)', async () => {
    const h = await openSyncedHybrid();
    forceDegraded(h);

    const fixed = 1_720_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixed);
    let createdId = '';
    try {
      const created = await h.createApiKey({ name: 'sticky', keyEnv: 'dev' });
      createdId = created.record.id;
      await h.updateApiKey(createdId, { name: 'sticky-renamed' });
      await h.deleteApiKey(createdId);
    } finally {
      nowSpy.mockRestore();
    }

    const pending = workspace!.getControlVault().listPendingOutbox();
    const keyOps = pending.filter((o) => o.entityId === createdId);
    expect(keyOps.map((o) => o.action)).toEqual(['add', 'modify', 'delete']);
    expect(keyOps[0]!.createdAt).toBeLessThan(keyOps[1]!.createdAt);
    expect(keyOps[1]!.createdAt).toBeLessThan(keyOps[2]!.createdAt);

    const health = await h.reconcile();
    expect(health.controlPlane).toBe('online');
    expect(health.outboxPending).toBe(0);
    expect(await controlInner!.getApiKeyById(createdId)).toBeNull();
    expect(workspace!.getControlVault().getApiKey(createdId)).toBeNull();
  });

  it('calling reconcile twice is idempotent', async () => {
    const h = await openSyncedHybrid();
    forceDegraded(h);

    await h.updateProvider('groq', { label: 'Twice' });
    const first = await h.reconcile();
    expect(first.controlPlane).toBe('online');
    expect(first.outboxPending).toBe(0);

    const second = await h.reconcile();
    expect(second.controlPlane).toBe('online');
    expect(second.outboxPending).toBe(0);
    expect(h.getPlane().state).toBe('online');
    expect((await controlInner!.getProvider('groq'))?.label).toBe('Twice');
  });

  it('rejects updateProvider while reconciling', async () => {
    const h = await openSyncedHybrid();
    h.setPlaneForTests({
      ...h.getPlane(),
      state: 'reconciling',
      vault: 'replaying',
    });

    await expect(h.updateProvider('groq', { label: 'Blocked' })).rejects.toThrow(
      /reconciling|temporarily locked/i
    );
  });
});
