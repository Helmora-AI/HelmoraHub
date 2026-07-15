import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createApp } from '../app.js';
import { loadConfig, setActiveConfig, type Config } from '../lib/config.js';
import {
  hashRecoveryToken,
  hashAdminToken,
  hashPassword,
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
import { closeStorage, initStorage } from '../storage/index.js';
import {
  isRecoveryRouteAllowed,
  requireRecovery,
} from '../middleware/requireRecovery.js';
import request from './test-request.js';

describe('recovery authentication primitives', () => {
  let tmpDir: string;
  let config: Config;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
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
    await initStorage(config);
  });

  afterEach(async () => {
    await closeStorage();
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

  it('logs in with recovery scope and rejects that bearer on admin and model routes', async () => {
    const recoveryToken = 'helmora-recovery-token-login-value';
    updateAdminConfig(tmpDir, {
      recoveryTokenHash: hashRecoveryToken(recoveryToken),
      passwordHash: hashPassword('recovery-login-admin-password'),
    });
    const app = createApp(config);
    const login = await request(app)
      .post('/api/auth/recovery-login')
      .send({ token: recoveryToken });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ ok: true, scope: 'recovery' });
    expect(Date.parse(login.body.expiresAt) - Date.now()).toBeLessThanOrEqual(
      15 * 60 * 1000
    );

    const admin = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(admin.status).toBe(401);
    expect(admin.body.error.type).toBe('admin_unauthorized');

    const model = await request(app)
      .get('/v1/models')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(model.status).toBe(401);
    expect(model.body.error.type).toBe('invalid_api_key');

    const status = await request(app).get('/api/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.recoveryAvailable).toBe(true);
    expect(status.body.recoveryMode).toBe(false);
  });

  it('enforces the exact recovery route allowlist in middleware', async () => {
    const session = issueRecoverySession();
    expect(isRecoveryRouteAllowed('GET', '/api/storage/health')).toBe(true);
    expect(isRecoveryRouteAllowed('PUT', '/api/settings/storage')).toBe(true);
    expect(isRecoveryRouteAllowed('POST', '/api/status')).toBe(false);

    const surface = express();
    surface.get('/api/storage/health', requireRecovery, (req, res) => {
      res.json({ scope: req.recoveryScope });
    });
    surface.get('/api/providers', requireRecovery, (_req, res) => {
      res.json({ shouldNotRun: true });
    });

    const allowed = await request(surface)
      .get('/api/storage/health')
      .set('Authorization', `Bearer ${session.token}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.scope).toBe('recovery');

    const denied = await request(surface)
      .get('/api/providers')
      .set('Authorization', `Bearer ${session.token}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.type).toBe('recovery_scope_denied');

    const wrongHeader = await request(surface)
      .get('/api/storage/health')
      .set('X-Admin-Token', session.token);
    expect(wrongHeader.status).toBe(401);
    expect(wrongHeader.body.error.type).toBe('recovery_unauthorized');
  });

  it('rate-limits repeated recovery login attempts', async () => {
    const recoveryToken = 'helmora-recovery-token-rate-limit-value';
    updateAdminConfig(tmpDir, {
      recoveryTokenHash: hashRecoveryToken(recoveryToken),
    });
    const app = createApp(config);
    let throttled = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(app)
        .post('/api/auth/recovery-login')
        .send({ token: 'wrong-recovery-token-value' });
      if (response.status === 429) {
        throttled = true;
        expect(response.body.error.type).toBe('rate_limited');
        break;
      }
      expect(response.status).toBe(401);
    }
    expect(throttled).toBe(true);
  });
});
