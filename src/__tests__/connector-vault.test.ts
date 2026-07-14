import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from '../lib/config.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import { SupabaseConfigStore } from '../storage/supabase-store.js';

describe('SQLite connector credential vault', () => {
  const stores: SqliteConfigStore[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function openStore(encryptionKey: string | null = 'connector-vault-test-key') {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-connector-vault-'));
    directories.push(dataDir);
    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      dbPath: path.join(dataDir, 'helmora.db'),
      apiKeyEnv: null,
      upstreamBaseUrl: null,
      upstreamApiKey: null,
      upstreamModel: null,
      encryptionKey,
      storageBackend: 'sqlite',
      storageChoice: 'local',
      rateBackend: 'memory',
      supabaseUrl: null,
      supabaseServiceRoleKey: null,
      redisUrl: null,
      publicUrl: null,
      frontendUrl: null,
    };
    const store = new SqliteConfigStore(config);
    stores.push(store);
    return { store, dbPath: config.dbPath };
  }

  it('sets, rotates, retains on omission, and explicitly clears TinyFish credentials', async () => {
    const { store } = openStore();

    const created = await store.updateConnectorCredential('tinyfish', { secret: 'tf-first-1234' });
    expect(created).toMatchObject({ connectorId: 'tinyfish', credentialConfigured: true });
    expect(created.credentialHint).toBe('…1234');
    expect(await store.getConnectorCredentialSecret('tinyfish')).toBe('tf-first-1234');

    const retained = await store.updateConnectorCredential('tinyfish', {});
    expect(retained.updatedAt).toBe(created.updatedAt);
    expect(await store.getConnectorCredentialSecret('tinyfish')).toBe('tf-first-1234');

    const rotated = await store.updateConnectorCredential('tinyfish', { secret: 'tf-rotated-9876' });
    expect(rotated.configuredAt).toBe(created.configuredAt);
    expect(rotated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(await store.getConnectorCredentialSecret('tinyfish')).toBe('tf-rotated-9876');

    const cleared = await store.updateConnectorCredential('tinyfish', { secret: null });
    expect(cleared).toMatchObject({
      connectorId: 'tinyfish',
      credentialConfigured: false,
      credentialHint: null,
      configuredAt: null,
      updatedAt: null,
    });
    expect(await store.getConnectorCredentialSecret('tinyfish')).toBeNull();
  });

  it('stores only encrypted material and keeps plaintext out of settings and vault rows', async () => {
    const { store, dbPath } = openStore();
    const secret = 'tf-never-store-plaintext';
    await store.updateConnectorCredential('tinyfish', { secret });
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const bytes = fs.readFileSync(dbPath).toString('utf8');
    expect(bytes).not.toContain(secret);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      'SELECT connector_id, encrypted_secret, encryption_version FROM control_vault_connector_credentials'
    ).get() as Record<string, unknown>;
    const settings = db.prepare('SELECT value FROM settings').all() as Array<{ value: string }>;
    db.close();

    expect(row.connector_id).toBe('tinyfish');
    expect(String(row.encrypted_secret)).toMatch(/^enc:v1:/);
    expect(row.encryption_version).toBe(1);
    expect(JSON.stringify(settings)).not.toContain(secret);
  });

  it('fails closed when encryption is unavailable and never persists plaintext', async () => {
    const { store, dbPath } = openStore(null);
    await expect(
      store.updateConnectorCredential('tinyfish', { secret: 'must-not-persist' })
    ).rejects.toThrow('ENCRYPTION_KEY is required for connector credential vault');
    await expect(store.getConnectorCredentialSecret('tinyfish')).rejects.toThrow(
      'ENCRYPTION_KEY is required for connector credential vault'
    );
    expect(fs.readFileSync(dbPath).toString('utf8')).not.toContain('must-not-persist');
  });

  it('rejects an unencrypted connector-vault record instead of accepting legacy plaintext', async () => {
    const { store } = openStore();
    store.getControlVault().upsertConnectorCredential({
      connectorId: 'tinyfish',
      encryptedSecret: 'legacy-plaintext-must-be-rejected',
      encryptionVersion: 1,
      configuredAt: 1,
      updatedAt: 1,
    });

    await expect(store.getConnectorCredentialSecret('tinyfish')).rejects.toThrow(
      'Connector credential is not encrypted'
    );
  });
});

describe('Supabase connector credential vault', () => {
  it('persists ciphertext, returns masked state, rotates, and clears through the dedicated table', async () => {
    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      dataDir: '.',
      dbPath: ':memory:',
      apiKeyEnv: null,
      upstreamBaseUrl: null,
      upstreamApiKey: null,
      upstreamModel: null,
      encryptionKey: 'supabase-connector-vault-test-key',
      storageBackend: 'supabase',
      storageChoice: 'sql',
      rateBackend: 'memory',
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-role-test-only',
      redisUrl: null,
      publicUrl: null,
      frontendUrl: null,
    };
    const store = new SupabaseConfigStore(config);
    let row: Record<string, unknown> | null = null;
    const client = {
      from: (table: string) => {
        expect(table).toBe('helmora_connector_credentials');
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
          }),
          upsert: async (value: Record<string, unknown>) => {
            row = value;
            return { error: null };
          },
          delete: () => ({
            eq: async () => {
              row = null;
              return { error: null };
            },
          }),
        };
      },
    };
    (store as unknown as { client: typeof client }).client = client;

    const created = await store.updateConnectorCredential('tinyfish', {
      secret: 'tf-supabase-first-1111',
    });
    expect(created).toMatchObject({ credentialConfigured: true, credentialHint: '…1111' });
    expect(JSON.stringify(row)).not.toContain('tf-supabase-first-1111');
    expect(String(row?.encrypted_secret)).toMatch(/^enc:v1:/);
    expect(await store.getConnectorCredentialSecret('tinyfish')).toBe('tf-supabase-first-1111');

    const rotated = await store.updateConnectorCredential('tinyfish', {
      secret: 'tf-supabase-next-2222',
    });
    expect(rotated.credentialHint).toBe('…2222');
    expect(JSON.stringify(row)).not.toContain('tf-supabase-next-2222');

    const cleared = await store.updateConnectorCredential('tinyfish', { secret: null });
    expect(cleared.credentialConfigured).toBe(false);
    expect(row).toBeNull();
  });
});
