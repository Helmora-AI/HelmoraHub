import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { loadConfig, setActiveConfig, type Config } from '../lib/config.js';
import {
  hashRecoveryToken,
  hashAdminToken,
  recoveryCredentialAvailable,
  verifyAdminTokenPlain,
  verifyRecoveryCredential,
  verifySessionToken,
} from '../lib/admin-auth.js';
import { verifyAdminSession } from '../lib/admin-sessions.js';
import {
  issueRecoverySession,
  verifyRecoverySession,
} from '../lib/recovery-sessions.js';
import { updateAdminConfig } from '../lib/runtime-config.js';
import request from './test-request.js';

describe('recovery authentication primitives', () => {
  let tmpDir: string;
  let config: Config;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    previousEnv = {};
    for (const name of [
      'HELMORA_RECOVERY_TOKEN',
      'HELMORA_ADMIN_PASSWORD',
      'HELMORA_ADMIN_TOKEN',
      'CTRLHUB_ADMIN_PASSWORD',
      'CTRLHUB_ADMIN_TOKEN',
    ]) {
      previousEnv[name] = process.env[name];
      delete process.env[name];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-recovery-auth-'));
    config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.rateBackend = 'memory';
    config.encryptionKey = 'test-recovery-auth-encryption-key';
    setActiveConfig(config);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the environment recovery token instead of a matching local hash', () => {
    const localToken = 'helmora-recovery-token-local-value';
    updateAdminConfig(tmpDir, {
      recoveryTokenHash: hashRecoveryToken(localToken),
    });
    expect(recoveryCredentialAvailable()).toBe(true);
    expect(verifyRecoveryCredential(localToken)).toBe(true);

    process.env.HELMORA_RECOVERY_TOKEN = 'environment-recovery-token-value';
    expect(verifyRecoveryCredential(localToken)).toBe(false);
    expect(verifyRecoveryCredential('environment-recovery-token-value')).toBe(true);

    const sharedToken = 'shared-admin-and-recovery-token';
    updateAdminConfig(tmpDir, { adminTokenHash: hashAdminToken(sharedToken) });
    process.env.HELMORA_RECOVERY_TOKEN = sharedToken;
    expect(verifyAdminTokenPlain(sharedToken)).toBe(false);
  });

  it('issues a 15-minute recovery-only session with a distinct audience', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));

    const session = issueRecoverySession();
    expect(session.token).toMatch(/^helmora_recovery_session_/);
    expect(session.scope).toBe('recovery');
    expect(verifyRecoverySession(session.token)).toEqual({ ok: true });
    expect(verifyAdminSession(session.token)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyAdminTokenPlain(session.token)).toBe(false);
    expect(verifySessionToken(session.token)).toBe(false);
    const sessionFile = fs.readFileSync(
      path.join(tmpDir, 'recovery-sessions.json'),
      'utf8'
    );
    expect(sessionFile).not.toContain(session.token);
    expect(sessionFile).toContain('helmora-recovery');

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(verifyRecoverySession(session.token)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('creates and rotates a local recovery token once through full admin auth', async () => {
    const app = createApp(config);
    const setup = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'recovery-admin-password' });
    expect(setup.status).toBe(200);
    expect(setup.body.recoveryToken).toMatch(/^helmora-recovery-token-/);
    expect(verifyRecoveryCredential(setup.body.recoveryToken)).toBe(true);
    const runtimeConfig = fs.readFileSync(
      path.join(tmpDir, 'runtime-config.json'),
      'utf8'
    );
    expect(runtimeConfig).not.toContain(setup.body.recoveryToken);

    const previousToken = setup.body.recoveryToken as string;
    const rotated = await request(app)
      .post('/api/auth/rotate-recovery-token')
      .set('Authorization', `Bearer ${setup.body.adminToken}`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.recoveryToken).toMatch(/^helmora-recovery-token-/);
    expect(rotated.body.recoveryToken).not.toBe(previousToken);
    expect(verifyRecoveryCredential(previousToken)).toBe(false);
    expect(verifyRecoveryCredential(rotated.body.recoveryToken)).toBe(true);

    process.env.HELMORA_RECOVERY_TOKEN = 'environment-recovery-token-value';
    const envManaged = await request(app)
      .post('/api/auth/rotate-recovery-token')
      .set('Authorization', `Bearer ${setup.body.adminToken}`);
    expect(envManaged.status).toBe(409);
    expect(envManaged.body.error.type).toBe('recovery_token_env_managed');
  });
});
