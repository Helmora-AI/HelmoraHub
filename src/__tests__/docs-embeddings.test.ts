import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';

let app: Express;
let tmpDir: string;
let clientKey: string;
let adminToken: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-docs-emb-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-docs-emb';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = 'test-encryption-key-docs-emb';
  setActiveConfig(config);
  await initStorage(config);
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'docs-emb-password' });
  adminToken = setup.body.adminToken;

  const created = await request(app)
    .post('/api/keys')
    .set('X-Admin-Token', adminToken)
    .send({ name: 'Docs emb', keyEnv: 'dev' });
  clientKey = created.body.plaintext;
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('public docs', () => {
  it('GET /docs without auth', async () => {
    const res = await request(app).get('/docs');
    expect(res.status).toBe(200);
    const text = typeof res.text === 'string' ? res.text : String(res.body);
    expect(text).toContain('Helmora AI');
    expect(text).toContain('/v1/embeddings');
  });

  it('GET /docs.json without auth', async () => {
    const res = await request(app).get('/docs.json');
    expect(res.status).toBe(200);
    expect(res.body.endpoints?.length).toBeGreaterThan(3);
    expect(res.body.authentication).toBeTruthy();
  });
});

describe('POST /v1/embeddings', () => {
  it('rejects missing key', async () => {
    const res = await request(app)
      .post('/v1/embeddings')
      .send({ input: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns vectors with API key (demo fallback ok)', async () => {
    const res = await request(app)
      .post('/v1/embeddings')
      .set('Authorization', `Bearer ${clientKey}`)
      .send({
        model: 'text-embedding-3-small',
        input: ['alpha', 'beta'],
      });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('list');
    expect(res.body.data).toHaveLength(2);
    expect(Array.isArray(res.body.data[0].embedding)).toBe(true);
    expect(res.body.data[0].embedding.length).toBeGreaterThan(0);
    expect(res.headers['x-routed-via']).toBeTruthy();

    const events = await getConfigStore().listUsage({ limit: 10 });
    expect(events.some((e) => e.source === 'api' && e.apiKeyId)).toBe(true);
  });
});
