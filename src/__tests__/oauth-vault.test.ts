import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  backfillAuthMode,
  deleteBundle,
  ensureOAuthVaultSchema,
  getBundle,
  getCredentialVersion,
  putBundle,
  putBundleIfVersion,
} from '../oauth/vault.js';
import {
  consumePending,
  createPending,
  PENDING_OAUTH_TTL_MS,
  purgeExpired,
} from '../oauth/pending-state.js';
import type { OAuthTokenBundle } from '../oauth/types.js';
import { createOAuthState, createPkcePair } from '../oauth/pkce.js';

describe('oauth vault', () => {
  let tmpDir: string;
  let db: Database.Database;
  const key = 'test-encryption-key-for-oauth-vault!!';

  afterEach(() => {
    db?.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function openDb(): Database.Database {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-oauth-vault-'));
    db = new Database(path.join(tmpDir, 'oauth.db'));
    ensureOAuthVaultSchema(db);
    return db;
  }

  const sampleBundle = (overrides?: Partial<OAuthTokenBundle>): OAuthTokenBundle => ({
    accessToken: 'access-tok',
    refreshToken: 'refresh-tok',
    expiresAt: Date.now() + 3600_000,
    tokenType: 'Bearer',
    schemaVersion: 1,
    ...overrides,
  });

  it('put/get/delete bundle', () => {
    openDb();
    const bundle = sampleBundle();
    expect(putBundle(db, 'claude', bundle, key)).toBe(1);
    expect(getBundle(db, 'claude', key)).toEqual(bundle);
    expect(getCredentialVersion(db, 'claude')).toBe(1);

    const updated = sampleBundle({ accessToken: 'access-2' });
    expect(putBundle(db, 'claude', updated, key)).toBe(2);
    expect(getBundle(db, 'claude', key)?.accessToken).toBe('access-2');
    expect(getCredentialVersion(db, 'claude')).toBe(2);

    expect(deleteBundle(db, 'claude')).toBe(true);
    expect(getBundle(db, 'claude', key)).toBeNull();
    expect(deleteBundle(db, 'claude')).toBe(false);
  });

  it('get for other provider id returns null (AAD bound per row)', () => {
    openDb();
    putBundle(db, 'claude', sampleBundle(), key);
    expect(getBundle(db, 'claude', key)?.accessToken).toBe('access-tok');
    expect(getBundle(db, 'codex', key)).toBeNull();
  });

  it('putBundleIfVersion CAS succeeds and fails on mismatch', () => {
    openDb();
    expect(putBundleIfVersion(db, 'claude', sampleBundle(), 0, key)).toBe(true);
    expect(getCredentialVersion(db, 'claude')).toBe(1);
    expect(putBundleIfVersion(db, 'claude', sampleBundle({ accessToken: 'v2' }), 1, key)).toBe(
      true
    );
    expect(getCredentialVersion(db, 'claude')).toBe(2);
    expect(putBundleIfVersion(db, 'claude', sampleBundle({ accessToken: 'stale' }), 1, key)).toBe(
      false
    );
    expect(getBundle(db, 'claude', key)?.accessToken).toBe('v2');
  });
});

describe('oauth pending state', () => {
  let tmpDir: string;
  let db: Database.Database;
  const key = 'test-encryption-key-for-oauth-pending!';

  afterEach(() => {
    db?.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function openDb(): Database.Database {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-oauth-pending-'));
    db = new Database(path.join(tmpDir, 'oauth.db'));
    ensureOAuthVaultSchema(db);
    return db;
  }

  it('create + consume once; second consume is null', () => {
    openDb();
    const state = createOAuthState();
    const { verifier } = createPkcePair();
    const created = createPending(db, {
      statePlain: state,
      providerId: 'claude',
      codeVerifier: verifier,
      initiatingSessionId: 'sess-1',
      encryptionKey: key,
    });
    expect(created.providerId).toBe('claude');
    expect(created.codeVerifier).toBe(verifier);
    expect(created.expiresAt - created.createdAt).toBe(PENDING_OAUTH_TTL_MS);
    expect(created.returnPath).toBe('/providers');

    const first = consumePending(db, state, key);
    expect(first?.codeVerifier).toBe(verifier);
    expect(first?.providerId).toBe('claude');
    expect(first?.consumedAt).not.toBeNull();

    expect(consumePending(db, state, key)).toBeNull();
  });

  it('expired pending is not consumable', () => {
    openDb();
    const state = createOAuthState();
    const { verifier } = createPkcePair();
    const now = 1_000_000;
    createPending(db, {
      statePlain: state,
      providerId: 'codex',
      codeVerifier: verifier,
      initiatingSessionId: 'sess-2',
      encryptionKey: key,
      ttlMs: 60_000,
      now,
    });
    expect(consumePending(db, state, key, now + 60_000)).toBeNull();
    expect(consumePending(db, state, key, now + 59_999)?.codeVerifier).toBe(verifier);
  });

  it('purgeExpired removes expired rows', () => {
    openDb();
    const state = createOAuthState();
    const { verifier } = createPkcePair();
    const now = 5_000_000;
    createPending(db, {
      statePlain: state,
      providerId: 'claude',
      codeVerifier: verifier,
      initiatingSessionId: 'sess-3',
      encryptionKey: key,
      ttlMs: 1_000,
      now,
    });
    expect(purgeExpired(db, now + 2_000)).toBeGreaterThanOrEqual(1);
    expect(consumePending(db, state, key, now + 2_000)).toBeNull();
  });
});

describe('auth_mode backfill', () => {
  let tmpDir: string;
  let db: Database.Database;

  afterEach(() => {
    db?.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('sets api_key only when non-empty api_key and auth_mode is none', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-auth-mode-'));
    db = new Database(path.join(tmpDir, 'auth.db'));
    db.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        api_key TEXT,
        auth_mode TEXT NOT NULL DEFAULT 'none'
      );
    `);
    db.prepare(`INSERT INTO providers (id, label, api_key, auth_mode) VALUES (?, ?, ?, ?)`).run(
      'groq',
      'Groq',
      'sk-test-key',
      'none'
    );
    db.prepare(`INSERT INTO providers (id, label, api_key, auth_mode) VALUES (?, ?, ?, ?)`).run(
      'empty',
      'Empty',
      '',
      'none'
    );
    db.prepare(`INSERT INTO providers (id, label, api_key, auth_mode) VALUES (?, ?, ?, ?)`).run(
      'nullkey',
      'Null',
      null,
      'none'
    );
    db.prepare(`INSERT INTO providers (id, label, api_key, auth_mode) VALUES (?, ?, ?, ?)`).run(
      'already',
      'Already',
      'sk-x',
      'oauth'
    );

    backfillAuthMode(db);

    const rows = db
      .prepare('SELECT id, auth_mode FROM providers ORDER BY id')
      .all() as Array<{ id: string; auth_mode: string }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.auth_mode]));
    expect(byId.groq).toBe('api_key');
    expect(byId.empty).toBe('none');
    expect(byId.nullkey).toBe('none');
    expect(byId.already).toBe('oauth');
  });
});
