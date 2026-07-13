import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig } from '../lib/config.js';
import { initStorage, closeStorage } from '../storage/index.js';
import { getUnifiedApiKey, setActiveMode } from '../db/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';

/**
 * Routes the Helmora-Frontend SPA calls. Each must exist on Hub (401/403 OK;
 * Express default HTML 404 is not).
 */
const SPA_ROUTES: Array<{
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  auth?: boolean;
  body?: Record<string, unknown>;
}> = [
  { method: 'get', path: '/api/auth/status', auth: false },
  { method: 'get', path: '/health', auth: false },
  { method: 'get', path: '/api/health', auth: false },
  { method: 'get', path: '/api/status' },
  { method: 'get', path: '/api/providers' },
  { method: 'get', path: '/api/models' },
  { method: 'get', path: '/api/settings' },
  { method: 'get', path: '/api/settings/storage/schema' },
  { method: 'get', path: '/api/agents' },
  { method: 'get', path: '/api/mini-route' },
  { method: 'get', path: '/api/office/runtime' },
  { method: 'get', path: '/api/keys' },
  { method: 'get', path: '/api/usage' },
  { method: 'get', path: '/api/chat/sessions' },
  { method: 'get', path: '/api/chat/active-session' },
  { method: 'post', path: '/api/chat/completions', body: { model: 'auto', messages: [] } },
];

let app: Express;
let adminToken: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-spa-routes-'));
  process.env.DATA_DIR = tmpDir;
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-spa-routes';
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.HELMORA_ADMIN_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.rateBackend = 'memory';
  config.encryptionKey = 'test-encryption-key-spa-routes';

  await initStorage(config);
  await setActiveMode('smart');
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'spa-routes-admin-password' });
  adminToken = setup.body.token;
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore Windows lock
  }
});

describe('SPA route contract', () => {
  for (const route of SPA_ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path} is registered`, async () => {
      let req = request(app)[route.method](route.path);
      if (route.auth !== false && adminToken) {
        req = req.set('Authorization', `Bearer ${adminToken}`);
      }
      if (route.body !== undefined) {
        req = req.send(route.body);
      }
      const res = await req;
      expect(res.status).not.toBe(404);
      const contentType = String(res.headers['content-type'] ?? '');
      expect(contentType).not.toMatch(/text\/html/);
    });
  }

  it('unknown /api path returns JSON not_found when authenticated', async () => {
    const res = await request(app)
      .get('/api/does-not-exist-xyz')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.type).toBe('not_found');
    expect(String(res.headers['content-type'] ?? '')).toMatch(/json/);
  });
});
