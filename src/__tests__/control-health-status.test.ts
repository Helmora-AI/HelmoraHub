import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig } from '../lib/config.js';
import { initStorage, closeStorage } from '../storage/index.js';
import { setActiveMode } from '../db/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-ctrl-health-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '20801';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-control-health';
  delete process.env.HELMORA_API_KEY;
  delete process.env.UPSTREAM_BASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.HELMORA_ADMIN_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.rateBackend = 'memory';
  config.encryptionKey = 'test-encryption-key-control-health';

  await initStorage(config);
  await setActiveMode('smart');
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'control-health-admin-password' });
  if (setup.status !== 200) {
    throw new Error(`admin setup failed: ${JSON.stringify(setup.body)}`);
  }
  adminToken = setup.body.adminToken;
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore Windows lock
  }
});

describe('control health on /api/status', () => {
  it('exposes online control health without secrets', async () => {
    const res = await request(app).get('/api/status').set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.control).toMatchObject({
      controlPlane: 'online',
      vault: 'fresh',
      outboxPending: 0,
      snapshotAvailable: true,
      servingReady: true,
      recoveryReady: false,
      degradedReason: null,
      degradedCapability: null,
    });
    expect(res.body.control.controlPlane).toBe('online');
    expect(res.body.control.outboxPending).toBe(0);

    const blob = JSON.stringify(res.body.control);
    expect(blob).not.toMatch(/apiKey|serviceRole|password|token|secret|ciphertext|payload/i);
    expect(Object.keys(res.body.control).sort()).toEqual([
      'controlPlane',
      'degradedCapability',
      'degradedReason',
      'outboxPending',
      'recoveryReady',
      'servingReady',
      'snapshotAvailable',
      'vault',
    ]);
  });
});
