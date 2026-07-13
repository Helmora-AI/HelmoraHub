import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ControlVault, ensureControlVaultSchema } from '../storage/control-vault.js';
import type { ApiKeyRecord } from '../keys/types.js';

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
});
