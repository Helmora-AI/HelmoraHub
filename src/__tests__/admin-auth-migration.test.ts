import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdminAuthStore,
  closeAdminAuthStore,
  getAdminAuthStoreHealth,
  initializeAdminAuthStore,
  migrateLegacyAuth,
} from '../lib/admin-auth-store.js';
import { hashSessionToken } from '../lib/admin-sessions.js';

let tmpDir: string | null = null;
const directStores: AdminAuthStore[] = [];

function createTempDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-auth-migration-'));
  return tmpDir;
}

function writeLegacyRuntime(dataDir: string): void {
  fs.writeFileSync(
    path.join(dataDir, 'runtime-config.json'),
    JSON.stringify(
      {
        storageChoice: 'local',
        rateBackend: 'memory',
        tunnel: {
          enabled: true,
          autoStart: false,
          token: 'owner-tunnel-token',
          hostname: 'hub.example.test',
        },
        admin: {
          passwordHash: 'legacy-password-hash',
          adminTokenHash: 'legacy-admin-hash',
          recoveryTokenHash: 'legacy-recovery-hash',
          sessionSecret: 'raw-reusable-signing-secret',
        },
      },
      null,
      2
    ),
    'utf8'
  );
}

afterEach(() => {
  closeAdminAuthStore();
  for (const store of directStores.splice(0)) store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('durable legacy auth migration', () => {
  it('imports once, scrubs reusable material, consumes the session file, and restarts from SQLite only', () => {
    const dataDir = createTempDir();
    writeLegacyRuntime(dataDir);
    const legacySpaToken = 'helmora_session_legacy-opaque-token';
    fs.writeFileSync(
      path.join(dataDir, 'admin-sessions.json'),
      JSON.stringify({
        sessions: [
          {
            hash: hashSessionToken(legacySpaToken),
            createdAt: 100,
            expiresAt: Date.now() + 60_000,
          },
        ],
      }),
      'utf8'
    );

    const store = initializeAdminAuthStore(dataDir);

    expect(getAdminAuthStoreHealth()).toEqual({
      ready: true,
      warning: null,
      migrationVersion: 1,
    });
    expect(store.readIdentity()).toMatchObject({
      passwordHash: 'legacy-password-hash',
      adminTokenHash: 'legacy-admin-hash',
      recoveryTokenHash: 'legacy-recovery-hash',
    });
    expect(store.readSession(hashSessionToken(legacySpaToken))).toMatchObject({
      kind: 'spa',
    });
    expect(store.readMigrationState()).toEqual({
      version: 1,
      phase: 'complete',
    });

    const rewritten = fs.readFileSync(
      path.join(dataDir, 'runtime-config.json'),
      'utf8'
    );
    expect(rewritten).toContain('"authStoreMigrationVersion": 1');
    expect(rewritten).toContain('owner-tunnel-token');
    expect(rewritten).not.toContain('legacy-password-hash');
    expect(rewritten).not.toContain('legacy-admin-hash');
    expect(rewritten).not.toContain('legacy-recovery-hash');
    expect(rewritten).not.toContain('raw-reusable-signing-secret');
    expect(rewritten).not.toContain('"admin"');
    expect(fs.existsSync(path.join(dataDir, 'admin-sessions.json'))).toBe(false);
    expect(
      fs.existsSync(path.join(dataDir, 'admin-sessions.consumed-v1.json'))
    ).toBe(true);

    closeAdminAuthStore();
    const restarted = initializeAdminAuthStore(dataDir);
    expect(restarted.readIdentity()?.passwordHash).toBe('legacy-password-hash');
    expect(getAdminAuthStoreHealth().ready).toBe(true);
  });

  it('fails closed after SQLite commit when cleanup fails and safely resumes later', () => {
    const dataDir = createTempDir();
    writeLegacyRuntime(dataDir);
    const store = new AdminAuthStore(dataDir);
    directStores.push(store);

    const interrupted = migrateLegacyAuth(store, dataDir, {
      rewriteRuntimeConfig: () => {
        throw new Error('injected rewrite failure');
      },
    });

    expect(interrupted).toEqual({
      ready: false,
      warning: 'auth_migration_incomplete',
      migrationVersion: 1,
    });
    expect(store.readMigrationState()).toEqual({
      version: 1,
      phase: 'legacy_cleanup_required',
    });
    expect(store.readIdentity()?.passwordHash).toBe('legacy-password-hash');
    expect(
      fs.readFileSync(path.join(dataDir, 'runtime-config.json'), 'utf8')
    ).toContain('raw-reusable-signing-secret');

    const resumed = migrateLegacyAuth(store, dataDir);
    expect(resumed.ready).toBe(true);
    expect(store.readMigrationState()).toEqual({ version: 1, phase: 'complete' });
  });

  it('does not fall back when a consumed runtime marker exists without its SQLite state', () => {
    const dataDir = createTempDir();
    fs.writeFileSync(
      path.join(dataDir, 'runtime-config.json'),
      JSON.stringify({
        authStoreMigrationVersion: 1,
        storageChoice: 'local',
        rateBackend: 'memory',
        tunnel: { enabled: false, autoStart: true, token: null, hostname: null },
      }),
      'utf8'
    );

    initializeAdminAuthStore(dataDir);

    expect(getAdminAuthStoreHealth()).toEqual({
      ready: false,
      warning: 'auth_migration_incomplete',
      migrationVersion: 1,
    });
  });
});
