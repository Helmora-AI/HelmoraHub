import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ControlVault, ensureControlVaultSchema } from '../storage/control-vault.js';
import type { ApiKeyRecord } from '../keys/types.js';
import { DEFAULT_AGENTS, DEFAULT_PROVIDERS } from '../storage/defaults.js';
import { encryptSecret } from '../lib/crypto.js';

describe('control vault', () => {
  let tmpDir: string;
  let db: Database.Database;

  afterEach(() => {
    db?.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function openVault(): ControlVault {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-vault-'));
    db = new Database(path.join(tmpDir, 'vault.db'));
    ensureControlVaultSchema(db);
    return new ControlVault(db);
  }

  function seedCompleteLegacyMirror(vault: ControlVault, syncedAt = 10_000): void {
    vault.upsertProvider(DEFAULT_PROVIDERS[0]!, syncedAt - 40);
    vault.upsertApiKey({
      id: 'legacy-key',
      name: 'legacy',
      keyEnv: 'dev',
      keyPrefix: 'hel_dev_',
      keyHash: 'legacy-hash',
      keyHint: 'hint',
      budgetUsd: null,
      spentUsd: 0,
      expiresAt: null,
      enabled: true,
      createdAt: syncedAt - 100,
      lastUsedAt: null,
    }, syncedAt - 30);
    vault.upsertAgent(DEFAULT_AGENTS[0]!, syncedAt - 20);
    vault.setSetting('active_mode', 'smart', syncedAt - 10);
    vault.setMeta({ lastSyncAt: syncedAt, generation: 7 });
  }

  it('upserts api keys and finds by hash', () => {
    const vault = openVault();
    const record: ApiKeyRecord = {
      id: 'k1',
      name: 'dev',
      keyEnv: 'dev',
      keyPrefix: 'hel_dev_',
      keyHash: 'hash-abc',
      keyHint: 'abcd',
      budgetUsd: null,
      spentUsd: 0,
      expiresAt: null,
      enabled: true,
      createdAt: 1,
      lastUsedAt: null,
    };
    vault.upsertApiKey(record);
    expect(vault.getApiKey('k1')?.name).toBe('dev');
    expect(vault.findApiKeyByHash('hash-abc')?.id).toBe('k1');
    vault.deleteApiKey('k1');
    expect(vault.getApiKey('k1')).toBeNull();
  });

  it('enqueues outbox and lists pending in createdAt order', () => {
    const vault = openVault();
    vault.enqueueOutbox({
      opId: 'b',
      entity: 'api_key',
      action: 'modify',
      entityId: 'k1',
      payload: { name: 'x' },
      createdAt: 200,
      appliedAt: null,
    });
    vault.enqueueOutbox({
      opId: 'a',
      entity: 'api_key',
      action: 'add',
      entityId: 'k1',
      payload: { name: 'y' },
      createdAt: 100,
      appliedAt: null,
    });
    const pending = vault.listPendingOutbox();
    expect(pending.map((o) => o.opId)).toEqual(['a', 'b']);
    expect(vault.pendingOutboxCount()).toBe(2);

    expect(vault.markOutboxApplied('a', 9_000)).toBe(true);
    expect(vault.markOutboxApplied('a', 9_999)).toBe(true);
    expect(vault.listPendingOutbox().map((o) => o.opId)).toEqual(['b']);
    expect(vault.pendingOutboxCount()).toBe(1);
  });

  it('stores settings and meta', () => {
    const vault = openVault();
    vault.setSetting('active_mode', 'smart');
    expect(vault.getSetting('active_mode')).toBe('smart');
    vault.setMeta({ lastSyncAt: 42, generation: 3 });
    expect(vault.getMeta()).toMatchObject({ lastSyncAt: 42, generation: 3 });
  });

  it('atomically promotes a complete trusted legacy mirror to generation zero', () => {
    const vault = openVault();
    seedCompleteLegacyMirror(vault);

    const result = vault.promoteLegacyGenerationZero(20_000);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.manifest).toMatchObject({
      generation: 0,
      formatVersion: 1,
      buildSchemaVersion: 1,
      createdAt: 20_000,
      completedAt: 20_000,
      complete: true,
      entityCounts: { providers: 1, apiKeys: 1, agents: 1 },
    });
    expect(result.manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.capabilities).toEqual(
      expect.arrayContaining([
        { id: 'providers', tier: 'core_serving', present: true },
        { id: 'api_keys', tier: 'core_serving', present: true },
        { id: 'agents', tier: 'core_serving', present: true },
        { id: 'active_mode', tier: 'core_serving', present: true },
      ])
    );
    expect(vault.getMeta().activeGeneration).toBe(0);
    expect(vault.getActiveSnapshotManifest()).toEqual(result.manifest);
  });

  it('rejects legacy rows without a trusted completed sync marker', () => {
    const vault = openVault();
    vault.upsertProvider(DEFAULT_PROVIDERS[0]!);
    vault.upsertAgent(DEFAULT_AGENTS[0]!);
    vault.setSetting('active_mode', 'smart');

    expect(vault.promoteLegacyGenerationZero()).toMatchObject({
      ok: false,
      reason: 'trusted_sync_marker_missing',
    });
    expect(vault.getMeta().activeGeneration).toBeNull();
  });

  it('rejects a partial pull that changed required rows after the last sync marker', () => {
    const vault = openVault();
    seedCompleteLegacyMirror(vault, 10_000);
    vault.upsertProvider(DEFAULT_PROVIDERS[0]!, 10_001);

    expect(vault.promoteLegacyGenerationZero()).toMatchObject({
      ok: false,
      reason: 'untrusted_legacy_rows',
    });
    expect(vault.getActiveSnapshotManifest()).toBeNull();
  });

  it('rejects incomplete core capabilities and an in-progress migration', () => {
    const vault = openVault();
    seedCompleteLegacyMirror(vault);
    vault.deleteApiKey('legacy-key');
    expect(vault.promoteLegacyGenerationZero()).toMatchObject({
      ok: false,
      reason: 'required_capability_missing',
      missingCapabilities: ['api_keys'],
    });

    seedCompleteLegacyMirror(vault);
    vault.setMeta({ migrationState: 'running' });
    expect(vault.promoteLegacyGenerationZero()).toMatchObject({
      ok: false,
      reason: 'migration_in_progress',
    });
  });

  it('requires an encrypted TinyFish credential only when the feature is enabled', () => {
    const vault = openVault();
    seedCompleteLegacyMirror(vault);
    vault.setSetting(
      'tool_runtime_v1',
      JSON.stringify({ enabled: true, connectors: { tinyfish: { enabled: true } } }),
      9_999
    );

    expect(vault.promoteLegacyGenerationZero()).toMatchObject({
      ok: false,
      reason: 'required_capability_missing',
      missingCapabilities: ['tinyfish_connector_credential'],
    });

    vault.upsertConnectorCredential({
      connectorId: 'tinyfish',
      encryptedSecret: encryptSecret('tf-test', 'vault-test-key'),
      encryptionVersion: 1,
      configuredAt: 9_998,
      updatedAt: 9_999,
    });
    const result = vault.promoteLegacyGenerationZero(20_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.manifest.capabilities).toContainEqual({
      id: 'tinyfish_connector_credential',
      tier: 'enabled_feature',
      present: true,
    });
  });
});
