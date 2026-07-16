import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { closeStorage, initStorage } from '../storage/index.js';
import request from './test-request.js';
import { setupAttemptLimiter } from '../lib/setup-token.js';

const ENV_KEYS = [
  'DATA_DIR',
  'PORT',
  'STORAGE_BACKEND',
  'RATE_BACKEND',
  'ENCRYPTION_KEY',
  'HELMORA_SETUP_TOKEN',
  'HELMORA_ADMIN_PASSWORD',
  'HELMORA_ADMIN_TOKEN',
  'HELMORA_RECOVERY_TOKEN',
  'CTRLHUB_SETUP_TOKEN',
  'CTRLHUB_ADMIN_PASSWORD',
  'CTRLHUB_ADMIN_TOKEN',
  'CTRLHUB_RECOVERY_TOKEN',
] as const;

const originalEnv = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]] as const)
);

let tmpDir: string | null = null;

type BootstrapEnv = {
  setupToken?: string;
  adminToken?: string;
  recoveryToken?: string;
};

async function createUnconfiguredApp(env: BootstrapEnv = {}): Promise<Express> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-bootstrap-'));

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '20800';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-bootstrap';
  if (env.setupToken !== undefined) {
    process.env.HELMORA_SETUP_TOKEN = env.setupToken;
  }
  if (env.adminToken !== undefined) {
    process.env.HELMORA_ADMIN_TOKEN = env.adminToken;
  }
  if (env.recoveryToken !== undefined) {
    process.env.HELMORA_RECOVERY_TOKEN = env.recoveryToken;
  }

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.rateBackend = 'memory';
  config.encryptionKey = 'test-encryption-key-bootstrap';
  setActiveConfig(config);

  await initStorage(config);
  return createApp(config);
}

afterEach(async () => {
  setupAttemptLimiter.clear();
  await closeStorage();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;

  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('mandatory bootstrap-token policy', () => {
  it('keeps an unconfigured Hub live but makes setup unavailable without a configured token', async () => {
    const app = await createUnconfiguredApp();

    const health = await request(app).get('/health');
    const ready = await request(app).get('/ready');
    const status = await request(app).get('/api/auth/status');
    const setup = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password' });

    expect(health.status).toBe(200);
    expect(health.body.warnings).toContain('setup_token_missing');
    expect(ready.status).toBe(503);
    expect(ready.body.error.type).toBe('setup_unavailable');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      setupRequired: true,
      setupTokenRequired: true,
      setupAvailable: false,
      setupUnavailableReason: 'setup_token_not_configured',
    });
    expect(setup.status).toBe(503);
    expect(setup.body.error.type).toBe('setup_token_not_configured');
  });

  it('rejects a missing or incorrect submitted token when configuration is valid', async () => {
    const configuredToken = 'a'.repeat(64);
    const app = await createUnconfiguredApp({ setupToken: configuredToken });

    const missing = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password' });
    const incorrect = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password', setupToken: 'b'.repeat(64) });

    expect(missing.status).toBe(403);
    expect(missing.body.error.type).toBe('setup_token_invalid');
    expect(incorrect.status).toBe(403);
    expect(incorrect.body.error.type).toBe('setup_token_invalid');
  });

  it('uses one repair-friendly unavailable path for weak environment configuration', async () => {
    const app = await createUnconfiguredApp({ setupToken: 'too-short' });

    const health = await request(app).get('/health');
    const ready = await request(app).get('/ready');
    const status = await request(app).get('/api/auth/status');
    const setup = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password', setupToken: 'too-short' });

    expect(health.status).toBe(200);
    expect(health.body.warnings).toContain('setup_token_invalid');
    expect(ready.status).toBe(503);
    expect(ready.body.error.type).toBe('setup_unavailable');
    expect(status.body.setupAvailable).toBe(false);
    expect(status.body.setupUnavailableReason).toBe(
      'setup_token_not_configured'
    );
    expect(setup.status).toBe(503);
    expect(setup.body.error.type).toBe('setup_token_not_configured');
  });

  it('does not let listener or proxy metadata waive the token requirement', async () => {
    const app = await createUnconfiguredApp({ setupToken: 'c'.repeat(64) });

    const response = await request(app)
      .post('/api/auth/setup')
      .set('Host', '127.0.0.1:20800')
      .set('Forwarded', 'for=127.0.0.1;proto=http;host=localhost')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('X-Forwarded-Host', 'localhost')
      .set('X-Forwarded-Proto', 'http')
      .send({ password: 'test-admin-password' });

    expect(response.status).toBe(403);
    expect(response.body.error.type).toBe('setup_token_invalid');
  });

  it('accepts the correct token once and returns both local credential handoffs', async () => {
    const setupToken = 'd'.repeat(64);
    const app = await createUnconfiguredApp({ setupToken });

    const response = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password', setupToken });

    expect(response.status).toBe(200);
    expect(response.body.adminToken).toMatch(/^helmora-admin-/);
    expect(response.body.recoveryToken).toMatch(/^helmora-recovery-token-/);
    expect(response.body.adminTokenEnvManaged).toBeUndefined();
    expect(response.body.recoveryTokenEnvManaged).toBeUndefined();

    const second = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'another-password', setupToken });
    expect(second.status).toBe(409);
    expect(second.body.error.type).toBe('already_configured');
  });

  it('rate-limits the eleventh parsed attempt from one socket source', async () => {
    const app = await createUnconfiguredApp({ setupToken: 'f'.repeat(64) });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(app)
        .post('/api/auth/setup')
        .send({
          password: 'test-admin-password',
          setupToken: `wrong-${attempt}`.padEnd(64, 'x'),
        });
      expect(response.status).toBe(403);
    }

    const throttled = await request(app)
      .post('/api/auth/setup')
      .send({
        password: 'test-admin-password',
        setupToken: 'another-wrong-token'.padEnd(64, 'x'),
      });
    expect(throttled.status).toBe(429);
    expect(throttled.body.error.type).toBe('setup_rate_limited');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('returns independent environment-managed admin and recovery discriminators', async () => {
    const setupToken = 'e'.repeat(64);
    const app = await createUnconfiguredApp({
      setupToken,
      adminToken: 'helmora-admin-environment',
      recoveryToken: 'helmora-recovery-token-environment',
    });

    const beforeSetup = await request(app)
      .get('/api/status')
      .set('Authorization', 'Bearer helmora-admin-environment');
    expect(beforeSetup.status).toBe(403);
    expect(beforeSetup.body.error.type).toBe('setup_required');

    const response = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password', setupToken });

    expect(response.status).toBe(200);
    expect(response.body.adminToken).toBeUndefined();
    expect(response.body.adminTokenEnvManaged).toBe(true);
    expect(response.body.recoveryToken).toBeUndefined();
    expect(response.body.recoveryTokenEnvManaged).toBe(true);
  });

  it('recovers a committed setup whose response transport is lost through password login and rotation', async () => {
    const setupToken = 'g'.repeat(64);
    const inner = await createUnconfiguredApp({ setupToken });
    const transport = express();
    transport.use((req, res, next) => {
      if (req.method === 'POST' && req.path === '/api/auth/setup') {
        res.json = (() => {
          res.socket?.destroy();
          return res;
        }) as typeof res.json;
      }
      next();
    });
    transport.use(inner);

    await expect(
      request(transport)
        .post('/api/auth/setup')
        .send({ password: 'ambiguous-password', setupToken })
    ).rejects.toThrow();

    const status = await request(inner).get('/api/auth/status');
    expect(status.body.setupRequired).toBe(false);

    const login = await request(inner)
      .post('/api/auth/login')
      .send({ password: 'ambiguous-password' });
    expect(login.status).toBe(200);

    const adminRotation = await request(inner)
      .post('/api/auth/rotate-token')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(adminRotation.status).toBe(200);
    expect(adminRotation.body.adminToken).toMatch(/^helmora-admin-/);

    const recoveryRotation = await request(inner)
      .post('/api/auth/rotate-recovery-token')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(recoveryRotation.status).toBe(200);
    expect(recoveryRotation.body.recoveryToken).toMatch(
      /^helmora-recovery-token-/
    );
  });
});
