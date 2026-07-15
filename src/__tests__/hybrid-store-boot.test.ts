import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../lib/config.js';
import { createApp } from '../app.js';
import { formatSupabaseControlError } from '../lib/supabase-schema.js';
import {
  closeStorage,
  getConfigStore,
  getControlHealth,
  initStorage,
  startControlPlaneProbe,
  startControlPlaneProbeLoop,
  stopControlPlaneProbeLoop,
} from '../storage/index.js';
import { HybridConfigStore } from '../storage/hybrid-store.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import type { ConfigStore } from '../storage/types.js';
import request from './test-request.js';

function configFor(dir: string): Config {
  const config = loadConfig();
  config.dataDir = dir;
  config.dbPath = path.join(dir, 'helmora.db');
  config.storageChoice = 'sql';
  config.storageBackend = 'supabase';
  config.rateBackend = 'memory';
  config.supabaseUrl = 'https://example.supabase.co';
  config.supabaseServiceRoleKey = 'test-service-role';
  config.encryptionKey = 'test-hybrid-boot-encryption-key';
  config.upstreamBaseUrl = null;
  config.upstreamApiKey = null;
  config.upstreamModel = null;
  return config;
}

function localConfigFor(dir: string): Config {
  const config = configFor(dir);
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  return config;
}

describe('Hybrid storage local-first boot', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    await closeStorage();
    vi.useRealTimers();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
  });

  async function prepareCompleteMirror(dir: string): Promise<void> {
    const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-boot-control-'));
    const control = new SqliteConfigStore(localConfigFor(controlDir));
    const workspace = new SqliteConfigStore(localConfigFor(dir));
    const hybrid = new HybridConfigStore({
      control,
      workspace,
      vault: workspace.getControlVault(),
      hybrid: true,
    });
    await hybrid.refreshVaultFromControl();
    const promoted = workspace.getControlVault().promoteLegacyGenerationZero();
    expect(promoted.ok).toBe(true);
    await hybrid.close();
    fs.rmSync(controlDir, { recursive: true, force: true });
  }

  it('boots from a complete local mirror before probing a missing Supabase table', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-boot-workspace-'));
    await prepareCompleteMirror(tmpDir);
    let remoteCalls = 0;

    await initStorage(configFor(tmpDir), {
      createHybridControl: () => ({
        store: { close: async () => undefined } as ConfigStore,
        bootstrap: async () => {
          remoteCalls += 1;
          throw formatSupabaseControlError(
            'getConnectorCredentialRecord',
            "Could not find the table 'public.helmora_connector_credentials' in the schema cache"
          );
        },
      }),
    });

    expect(remoteCalls).toBe(0);
    expect(getConfigStore()).toBeInstanceOf(HybridConfigStore);
    expect(getControlHealth()).toMatchObject({
      controlPlane: 'probing',
      snapshotAvailable: true,
      servingReady: true,
    });

    const firstProbe = startControlPlaneProbe();
    const overlappingProbe = startControlPlaneProbe();
    await Promise.all([firstProbe, overlappingProbe]);

    expect(remoteCalls).toBe(1);
    expect(getControlHealth()).toMatchObject({
      controlPlane: 'degraded',
      degradedReason: 'schema_incomplete',
      degradedCapability: 'helmora_connector_credentials',
      snapshotAvailable: true,
      servingReady: true,
    });
    expect((await getConfigStore().listProviders()).length).toBeGreaterThan(0);

    const app = createApp(configFor(tmpDir));
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: 'healthy',
      controlState: 'degraded',
      servingReady: true,
      recoveryReady: false,
    });

    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ready', servingReady: true });
  });

  it('stays recovery-only when neither remote control nor a complete snapshot is available', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-boot-empty-'));
    let remoteCalls = 0;
    await initStorage(configFor(tmpDir), {
      createHybridControl: () => ({
        store: { close: async () => undefined } as ConfigStore,
        bootstrap: async () => {
          remoteCalls += 1;
          throw formatSupabaseControlError('bootstrap', 'TypeError: fetch failed');
        },
      }),
    });

    expect(getControlHealth()).toMatchObject({
      controlPlane: 'recovery_only',
      snapshotAvailable: false,
      servingReady: false,
    });
    await startControlPlaneProbe();
    expect(remoteCalls).toBe(1);
    expect(getControlHealth()).toMatchObject({
      controlPlane: 'recovery_only',
      degradedReason: 'unreachable',
      snapshotAvailable: false,
      servingReady: false,
    });

    const app = createApp(configFor(tmpDir));
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: 'healthy',
      controlState: 'recovery_only',
      servingReady: false,
      recoveryReady: false,
    });

    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: 'not_ready', servingReady: false });

    for (const pathName of [
      '/state',
      '/registry',
      '/v1/models',
      '/api/chat/sessions',
      '/api/status',
    ]) {
      const gated = await request(app).get(pathName);
      expect(gated.status).toBe(503);
      expect(gated.body.error).toMatchObject({
        type: 'control_snapshot_unavailable',
        recoveryAvailable: false,
      });
    }

    const authStatus = await request(app).get('/api/auth/status');
    expect(authStatus.status).toBe(200);
  });

  it('starts one probe loop, prevents overlap, and drains it on stop', async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-boot-probe-loop-'));
    let remoteCalls = 0;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    await initStorage(configFor(tmpDir), {
      createHybridControl: () => ({
        store: { close: async () => undefined } as ConfigStore,
        bootstrap: async () => {
          remoteCalls += 1;
          await probeGate;
          throw formatSupabaseControlError('bootstrap', 'TypeError: fetch failed');
        },
      }),
    });

    startControlPlaneProbeLoop({ intervalMs: 10 });
    startControlPlaneProbeLoop({ intervalMs: 10 });
    expect(remoteCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(remoteCalls).toBe(1);

    releaseProbe();
    await stopControlPlaneProbeLoop();
    expect(getControlHealth().controlPlane).toBe('recovery_only');
  });
});
