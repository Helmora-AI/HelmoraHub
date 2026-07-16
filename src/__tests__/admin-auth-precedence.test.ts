import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import {
  hashAdminToken,
  hashPassword,
  hashRecoveryToken,
  isSetupRequired,
  verifyAdminPassword,
  verifyAdminTokenPlain,
  verifyRecoveryCredential,
} from '../lib/admin-auth.js';
import {
  closeAdminAuthStore,
  initializeAdminAuthStore,
} from '../lib/admin-auth-store.js';
import { loadConfig, setActiveConfig, type Config } from '../lib/config.js';
import { closeStorage, initStorage } from '../storage/index.js';
import request from './test-request.js';

const AUTH_ENV_KEYS = [
  'DATA_DIR',
  'HELMORA_ADMIN_PASSWORD',
  'HELMORA_ADMIN_TOKEN',
  'HELMORA_RECOVERY_TOKEN',
  'CTRLHUB_ADMIN_PASSWORD',
  'CTRLHUB_ADMIN_TOKEN',
  'CTRLHUB_RECOVERY_TOKEN',
  'STORAGE_BACKEND',
  'RATE_BACKEND',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

describe('environment and local auth precedence', () => {
  let tmpDir: string;
  let originalEnv: Map<string, string | undefined>;

  beforeEach(() => {
    originalEnv = new Map(
      AUTH_ENV_KEYS.map((key) => [key, process.env[key]] as const)
    );
    for (const key of AUTH_ENV_KEYS) delete process.env[key];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-auth-precedence-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await closeStorage();
    closeAdminAuthStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of AUTH_ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function restartWith(
    env: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>> = {}
  ): Config {
    closeAdminAuthStore();
    for (const key of AUTH_ENV_KEYS) {
      if (key !== 'DATA_DIR') delete process.env[key];
    }
    Object.assign(process.env, env, {
      DATA_DIR: tmpDir,
      STORAGE_BACKEND: 'local',
      RATE_BACKEND: 'memory',
    });
    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    setActiveConfig(config);
    initializeAdminAuthStore(tmpDir);
    return config;
  }

  function seedLocalIdentity(): void {
    const store = initializeAdminAuthStore(tmpDir);
    store.attemptBootstrap({
      passwordHash: hashPassword('local-password'),
      adminTokenHash: hashAdminToken('helmora-admin-local'),
      recoveryTokenHash: hashRecoveryToken('helmora-recovery-token-local'),
      sessions: [],
    });
  }

  it('exclusively shadows each local credential for one process snapshot and restores it after restart', () => {
    restartWith();
    seedLocalIdentity();
    restartWith({
      HELMORA_ADMIN_PASSWORD: 'environment-password',
      HELMORA_ADMIN_TOKEN: 'helmora-admin-environment',
      HELMORA_RECOVERY_TOKEN: 'helmora-recovery-token-environment',
    });

    expect(verifyAdminPassword('environment-password')).toBe(true);
    expect(verifyAdminPassword('local-password')).toBe(false);
    expect(verifyAdminTokenPlain('helmora-admin-environment')).toBe(true);
    expect(verifyAdminTokenPlain('helmora-admin-local')).toBe(false);
    expect(verifyRecoveryCredential('helmora-recovery-token-environment')).toBe(true);
    expect(verifyRecoveryCredential('helmora-recovery-token-local')).toBe(false);

    process.env.HELMORA_ADMIN_PASSWORD = 'mutated-under-running-process';
    process.env.HELMORA_ADMIN_TOKEN = 'helmora-admin-mutated';
    expect(verifyAdminPassword('environment-password')).toBe(true);
    expect(verifyAdminTokenPlain('helmora-admin-environment')).toBe(true);

    restartWith();
    expect(verifyAdminPassword('local-password')).toBe(true);
    expect(verifyAdminTokenPlain('helmora-admin-local')).toBe(true);
    expect(verifyRecoveryCredential('helmora-recovery-token-local')).toBe(true);
  });

  it('does not treat environment admin or recovery tokens as a configured identity', () => {
    restartWith({
      HELMORA_ADMIN_TOKEN: 'helmora-admin-environment',
      HELMORA_RECOVERY_TOKEN: 'helmora-recovery-token-environment',
    });

    expect(isSetupRequired()).toBe(true);
    expect(verifyAdminTokenPlain('helmora-admin-environment')).toBe(false);
    expect(verifyRecoveryCredential('helmora-recovery-token-environment')).toBe(false);
  });

  it('keeps provenance private on status and exposes it only through authenticated /me', async () => {
    restartWith();
    seedLocalIdentity();
    const config = restartWith({
      HELMORA_ADMIN_PASSWORD: 'environment-password',
      HELMORA_ADMIN_TOKEN: 'helmora-admin-environment',
    });
    await initStorage(config);
    const app = createApp(config);

    const status = await request(app).get('/api/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.authSources).toBeUndefined();
    expect(status.body.localAuthShadowed).toBeUndefined();
    expect(status.body.envPassword).toBeUndefined();
    expect(status.body.envAdminToken).toBeUndefined();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer helmora-admin-environment');
    expect(me.status).toBe(200);
    expect(me.body.auth.authSources).toEqual({
      password: 'environment',
      adminToken: 'environment',
      recoveryToken: 'local',
    });
    expect(me.body.auth.localAuthShadowed).toBe(true);
  });
});
