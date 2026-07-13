import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';

let app: Express;
let tmpDir: string;
let adminToken: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-auth-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '20800';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-admin-auth';
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.HELMORA_ADMIN_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.rateBackend = 'memory';
  config.encryptionKey = 'test-encryption-key-admin-auth';
  setActiveConfig(config);

  await initStorage(config);
  app = createApp(config);
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('Admin auth', () => {
  it('blocks /api/status until setup', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('setup_required');
  });

  it('GET /api/auth/status reports setupRequired', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.setupRequired).toBe(true);
    expect(res.body.authenticated).toBe(false);
  });

  it('POST /api/auth/setup creates password + admin token', async () => {
    const res = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password' });
    expect(res.status).toBe(200);
    expect(res.body.adminToken).toMatch(/^helmora-admin-/);
    adminToken = res.body.adminToken;
    expect(res.body.auth.setupRequired).toBe(false);
  });

  it('rejects second setup', async () => {
    const res = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'another-password-xx' });
    expect(res.status).toBe(409);
  });

  it('accepts admin bearer token on /api/status', async () => {
    const res = await request(app)
      .get('/api/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('Helmora AI');
  });

  it('accepts X-Admin-Token on settings', async () => {
    const res = await request(app)
      .get('/api/settings/storage')
      .set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.current.choice).toBe('local');
  });

  it('rejects wrong admin token', async () => {
    const res = await request(app)
      .get('/api/status')
      .set('Authorization', 'Bearer helmora-admin-wrong');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('admin_unauthorized');
  });

  it('login with password sets session cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'test-admin-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'] || '').toContain('helmora_sid=');
  });

  it('keeps /health and /v1 key path open without admin', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    const noKey = await request(app).post('/v1/chat/completions').send({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(noKey.status).toBe(401);
    expect(noKey.body.error?.type).toBe('invalid_api_key');
  });

  it('rotates admin token', async () => {
    const res = await request(app)
      .post('/api/auth/rotate-token')
      .set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.adminToken).toMatch(/^helmora-admin-/);
    expect(res.body.adminToken).not.toBe(adminToken);

    const oldDenied = await request(app)
      .get('/api/status')
      .set('X-Admin-Token', adminToken);
    expect(oldDenied.status).toBe(401);

    adminToken = res.body.adminToken;
    const ok = await request(app)
      .get('/api/status')
      .set('X-Admin-Token', adminToken);
    expect(ok.status).toBe(200);
  });
});
