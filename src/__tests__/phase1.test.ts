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

let app: Express;
let apiKey: string;
let adminToken: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '20800';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-phase1-hybrid';
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
  config.encryptionKey = 'test-encryption-key-phase1-hybrid';

  await initStorage(config);
  await setActiveMode('smart');
  apiKey = await getUnifiedApiKey();
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'phase1-admin-password' });
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

describe('Claw3D runtime contract', () => {
  it('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('Helmora AI');
  });

  it('GET /state exposes office agents', async () => {
    const res = await request(app).get('/state');
    expect(res.status).toBe(200);
    expect(res.body.runtime.name).toBe('Helmora AI');
    expect(res.body.active).toHaveProperty('coordinator');
    expect(res.body.active).toHaveProperty('scout');
    expect(res.body.agents.length).toBeGreaterThanOrEqual(6);
  });

  it('GET /registry lists models', async () => {
    const res = await request(app).get('/registry');
    expect(res.status).toBe(200);
    expect(res.body.models).toHaveProperty('auto');
  });

  it('GET /api/office/runtime (admin)', async () => {
    const res = await request(app)
      .get('/api/office/runtime')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state.identity.name).toBe('Helmora Office');
    expect(res.body.state.agents.length).toBeGreaterThanOrEqual(6);
  });

  it('GET /providers and /models serve HTML', async () => {
    const providers = await request(app).get('/providers');
    expect(providers.status).toBe(200);
    expect(String(providers.type || providers.headers['content-type'] || '')).toMatch(
      /html|text/
    );

    const models = await request(app).get('/models');
    expect(models.status).toBe(200);
    expect(String(models.type || models.headers['content-type'] || '')).toMatch(/html|text/);
  });
});

describe('OpenAI-compatible /v1', () => {
  it('rejects missing API key', async () => {
    const res = await request(app).post('/v1/chat/completions').send({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(401);
  });

  it('returns demo completion via fallback chain', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .set('X-CtrL-Mode', 'economy')
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello office' }],
        session_id: 'test-session-1',
      });
    expect(res.status).toBe(200);
    // model=auto → Helmora Mini route (default mode smart), header mode not used
    expect(res.headers['x-ctrl-mode']).toBe('smart');
    expect(res.body.choices[0].message.content).toContain('Helmora AI demo');
  });

  it('lists models', async () => {
    const res = await request(app)
      .get('/v1/models')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((m: { id: string }) => m.id === 'auto')).toBe(true);
  });
});

describe('Admin API + hybrid storage', () => {
  it('GET /api/status reports storage backends', async () => {
    const res = await request(app).get('/api/status').set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('Helmora AI');
    expect(res.body.storage.choice).toBe('local');
    expect(res.body.storage.backend).toBe('sqlite');
    expect(res.body.storage.rate).toBe('memory');
    expect(res.body.settingsUrl).toBe('/settings');
    expect(res.body.providersUrl).toBe('/providers');
    expect(res.body.modelsUrl).toBe('/models');
    expect(res.body.agents).toHaveLength(6);
    expect(res.body.aggregates).toBeDefined();
    expect(res.body.aggregates.providersByHealth).toBeTypeOf('object');
    expect(res.body.aggregates.providersByTier).toMatchObject({
      '1': expect.any(Number),
      '2': expect.any(Number),
      '3': expect.any(Number),
    });
    expect(res.body.aggregates.modelsRoutable).toMatchObject({
      yes: expect.any(Number),
      no: expect.any(Number),
    });
    expect(typeof res.body.aggregates.computedAt).toBe('string');
  });

  it('GET /api/models returns catalog rows', async () => {
    const res = await request(app).get('/api/models').set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.models.some((m: { id: string }) => m.id === 'auto')).toBe(true);
  });

  it('GET /api/settings/storage defaults to local', async () => {
    const res = await request(app)
      .get('/api/settings/storage')
      .set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.defaults.choice).toBe('local');
    expect(res.body.current.choice).toBe('local');
    expect(res.body.options.map((o: { id: string }) => o.id)).toEqual(['local', 'sql']);
    expect(res.body.schema.path).toBe('sql/supabase-schema.sql');
    expect(res.body.schema.endpoint).toBe('/api/settings/storage/schema');
  });

  it('GET /api/settings/storage/schema returns DDL', async () => {
    const res = await request(app)
      .get('/api/settings/storage/schema')
      .set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('sql/supabase-schema.sql');
    expect(res.body.sql).toContain('create table if not exists public.helmora_settings');
    expect(res.body.applyHint).toMatch(/SQL Editor/i);
  });

  it('GET /api/settings includes schema apply hints', async () => {
    const res = await request(app).get('/api/settings').set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.storage.schema.path).toBe('sql/supabase-schema.sql');
    expect(res.body.storage.migration.note).toMatch(/supabase-schema\.sql/i);
  });

  it('PUT /api/settings/storage keeps local', async () => {
    const res = await request(app)
      .put('/api/settings/storage')
      .set('X-Admin-Token', adminToken)
      .send({ storageChoice: 'local' });
    expect(res.status).toBe(200);
    expect(res.body.current.choice).toBe('local');
  });

  it('PUT /api/settings/storage sql without credentials fails', async () => {
    const res = await request(app)
      .put('/api/settings/storage')
      .set('X-Admin-Token', adminToken)
      .send({ storageChoice: 'sql' });
    expect(res.status).toBe(400);
  });

  it('switches active mode', async () => {
    const res = await request(app)
      .put('/api/modes/active')
      .set('X-Admin-Token', adminToken)
      .send({ mode: 'coding' });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe('coding');
  });

  it('stores provider api key encrypted (masked on read)', async () => {
    const res = await request(app)
      .patch('/api/toggles/paid-upstream')
      .set('X-Admin-Token', adminToken)
      .send({
        enabled: true,
        apiKey: 'sk-test-secret-key-value',
        baseUrl: 'https://example.com/v1',
      });
    expect(res.status).toBe(200);
    expect(res.body.provider.apiKey).toBeUndefined();
    expect(res.body.provider.credentialHint).toBeTruthy();
    expect(res.body.provider.credentialHint).not.toBe('sk-test-secret-key-value');
    expect(String(res.body.provider.credentialHint)).toMatch(/•/);
    expect(res.body.provider.credentialConfigured).toBe(true);
  });

  it('toggles a provider', async () => {
    const res = await request(app)
      .patch('/api/toggles/free-pool')
      .set('X-Admin-Token', adminToken)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.provider.enabled).toBe(false);

    await request(app)
      .patch('/api/toggles/free-pool')
      .set('X-Admin-Token', adminToken)
      .send({ enabled: true });
  });

  it('renames an agent nickname', async () => {
    const res = await request(app)
      .patch('/api/agents/scout')
      .set('X-Admin-Token', adminToken)
      .send({ nickname: 'Radar' });
    expect(res.status).toBe(200);
    expect(res.body.agent.nickname).toBe('Radar');
  });
});

describe('Cloudflare Tunnel settings', () => {
  it('GET /api/settings/tunnel returns status', async () => {
    const res = await request(app)
      .get('/api/settings/tunnel')
      .set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('token');
    expect(res.body.running).toBe(false);
    expect(res.body).toHaveProperty('hasToken');
    expect(res.body.hint.dashboard).toContain('127.0.0.1');
  });

  it('PUT /api/settings/tunnel saves hostname and encrypted token', async () => {
    const fakeToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0dW5uZWwiOiJ0ZXN0In0.signaturepaddingxx';
    const res = await request(app)
      .put('/api/settings/tunnel')
      .set('X-Admin-Token', adminToken)
      .send({
        enabled: true,
        autoStart: true,
        hostname: 'hub.example.com',
        token: fakeToken,
        action: 'none',
      });
    expect(res.status).toBe(200);
    expect(res.body.tunnel.hasToken).toBe(true);
    expect(res.body.tunnel.hostname).toBe('hub.example.com');
    expect(res.body.tunnel.tokenEncryptedAtRest).toBe(true);
    expect(res.body.tunnel.publicUrl).toBe('https://hub.example.com');

    const disk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'runtime-config.json'), 'utf8')
    );
    expect(disk.tunnel.token).toMatch(/^enc:v1:/);
    expect(disk.tunnel.token).not.toContain(fakeToken);
  });

  it('storage save preserves tunnel config', async () => {
    const res = await request(app)
      .put('/api/settings/storage')
      .set('X-Admin-Token', adminToken)
      .send({ storageChoice: 'local' });
    expect(res.status).toBe(200);
    const disk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'runtime-config.json'), 'utf8')
    );
    expect(disk.tunnel.hostname).toBe('hub.example.com');
    expect(disk.tunnel.enabled).toBe(true);
  });
});
