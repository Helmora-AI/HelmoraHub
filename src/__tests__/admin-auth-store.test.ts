import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminAuthStore } from '../lib/admin-auth-store.js';

let tmpDir: string | null = null;
const openStores: AdminAuthStore[] = [];

function createStore(): AdminAuthStore {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-auth-store-'));
  const store = new AdminAuthStore(tmpDir);
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('AdminAuthStore bootstrap CAS', () => {
  it('atomically inserts the singleton identity and initial opaque sessions', () => {
    const store = createStore();

    const result = store.attemptBootstrap({
      passwordHash: 'password-hash',
      adminTokenHash: 'admin-token-hash',
      recoveryTokenHash: 'recovery-token-hash',
      sessions: [
        {
          hash: 'cookie-session-hash',
          kind: 'cookie',
          createdAt: 100,
          expiresAt: 200,
        },
        {
          hash: 'spa-session-hash',
          kind: 'spa',
          createdAt: 100,
          expiresAt: 200,
        },
      ],
    });

    expect(result).toEqual({ created: true });
    expect(store.readIdentity()).toMatchObject({
      passwordHash: 'password-hash',
      adminTokenHash: 'admin-token-hash',
      recoveryTokenHash: 'recovery-token-hash',
    });
    expect(store.findSession('cookie-session-hash', 150)).toMatchObject({
      kind: 'cookie',
      expiresAt: 200,
    });
    expect(store.findSession('spa-session-hash', 150)).toMatchObject({
      kind: 'spa',
      expiresAt: 200,
    });
  });

  it('selects exactly one winner across independent store instances', () => {
    const first = createStore();
    const second = createStore();

    const winner = first.attemptBootstrap({
      passwordHash: 'winner-password',
      adminTokenHash: 'winner-admin',
      recoveryTokenHash: 'winner-recovery',
      sessions: [],
    });
    const loser = second.attemptBootstrap({
      passwordHash: 'loser-password',
      adminTokenHash: 'loser-admin',
      recoveryTokenHash: 'loser-recovery',
      sessions: [],
    });

    expect([winner, loser]).toEqual([{ created: true }, { created: false }]);
    expect(second.readIdentity()).toMatchObject({
      passwordHash: 'winner-password',
      adminTokenHash: 'winner-admin',
      recoveryTokenHash: 'winner-recovery',
    });
  });

  it('rolls back the identity if any initial session insert fails', () => {
    const store = createStore();

    expect(() =>
      store.attemptBootstrap({
        passwordHash: 'password-hash',
        adminTokenHash: null,
        recoveryTokenHash: null,
        sessions: [
          { hash: 'duplicate', kind: 'cookie', createdAt: 100, expiresAt: 200 },
          { hash: 'duplicate', kind: 'spa', createdAt: 100, expiresAt: 200 },
        ],
      })
    ).toThrow();
    expect(store.readIdentity()).toBeNull();
  });
});

describe('AdminAuthStore credential and session persistence', () => {
  it('updates local credential hashes without changing the password implicitly', () => {
    const store = createStore();
    store.attemptBootstrap({
      passwordHash: 'password-hash',
      adminTokenHash: null,
      recoveryTokenHash: null,
      sessions: [],
    });

    store.updateIdentity({
      adminTokenHash: 'rotated-admin-hash',
      recoveryTokenHash: 'rotated-recovery-hash',
    });

    expect(store.readIdentity()).toMatchObject({
      passwordHash: 'password-hash',
      adminTokenHash: 'rotated-admin-hash',
      recoveryTokenHash: 'rotated-recovery-hash',
    });
  });

  it('looks up one exact session hash and revokes only the presented hashes', () => {
    const store = createStore();
    store.insertSession({
      hash: 'cookie-hash',
      kind: 'cookie',
      createdAt: 100,
      expiresAt: 300,
    });
    store.insertSession({
      hash: 'spa-hash',
      kind: 'spa',
      createdAt: 100,
      expiresAt: 300,
    });

    expect(store.readSession('cookie-hash')).toMatchObject({ kind: 'cookie' });
    expect(store.readSession('spa-hash')).toMatchObject({ kind: 'spa' });
    expect(store.deleteSessions(['cookie-hash'])).toBe(1);
    expect(store.readSession('cookie-hash')).toBeNull();
    expect(store.readSession('spa-hash')).not.toBeNull();
  });

  it('prunes expired sessions in bounded batches', () => {
    const store = createStore();
    for (let index = 0; index < 105; index += 1) {
      store.insertSession({
        hash: `expired-${index}`,
        kind: 'spa',
        createdAt: 100,
        expiresAt: 200,
      });
    }
    store.insertSession({
      hash: 'active',
      kind: 'spa',
      createdAt: 100,
      expiresAt: 400,
    });

    expect(store.pruneExpired(300, 100)).toBe(100);
    expect(store.countSessions()).toBe(6);
    expect(store.pruneExpired(300, 100)).toBe(5);
    expect(store.countSessions()).toBe(1);
    expect(store.readSession('active')).not.toBeNull();
  });
});
