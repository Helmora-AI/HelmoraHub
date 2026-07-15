import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../lib/config.js';
import { formatSupabaseControlError } from '../lib/supabase-schema.js';
import {
  closeStorage,
  getConfigStore,
  getControlHealth,
  initStorage,
  startControlPlaneProbe,
} from '../storage/index.js';
import { HybridConfigStore } from '../storage/hybrid-store.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import type { ConfigStore } from '../storage/types.js';

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

    await startControlPlaneProbe();

    expect(remoteCalls).toBe(1);
    expect(getControlHealth()).toMatchObject({
      controlPlane: 'degraded',
      degradedReason: 'schema_incomplete',
      degradedCapability: 'helmora_connector_credentials',
      snapshotAvailable: true,
      servingReady: true,
    });
    expect((await getConfigStore().listProviders()).length).toBeGreaterThan(0);
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
  });
});
