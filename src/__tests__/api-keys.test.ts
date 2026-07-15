import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import { costForModel, averageModelCosts, getPricingForModel } from '../pricing/cost.js';
import type { Express } from 'express';
import { normalizeMiniRoleConfig, setMiniRoleConfig } from '../services/mini-route.js';

let app: Express;
let tmpDir: string;
let adminToken: string;
let clientKey: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-keys-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-api-keys';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.HELMORA_ADMIN_TOKEN;
  delete process.env.CTRLHUB_ADMIN_PASSWORD;
  delete process.env.CTRLHUB_ADMIN_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = 'test-encryption-key-api-keys';
  setActiveConfig(config);
  await initStorage(config);
  const store = getConfigStore();
  await store.updateProvider('paid-upstream', { enabled: true, verifyStatus: 'ok' });
  const miniModel = await store.createHubModel({
    providerId: 'paid-upstream',
    modelId: 'demo/api-keys-mini',
  });
  await setMiniRoleConfig(normalizeMiniRoleConfig({
    version: 2,
    roles: { general: { primaryCatalogId: miniModel.id, fallbackCatalogId: null } },
  }));
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'keys-admin-password' });
  expect(setup.status).toBe(200);
  adminToken = setup.body.adminToken;

  const created = await request(app)
    .post('/api/keys')
    .set('X-Admin-Token', adminToken)
    .send({ name: 'Test dev', keyEnv: 'dev', budgetUsd: 0.01 });
  expect(created.status).toBe(201);
  clientKey = created.body.plaintext;
  expect(clientKey).toMatch(/^hel_dev_/);
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('pricing catalog', () => {
  it('resolves gpt-4o-mini rates', () => {
    const p = getPricingForModel('gpt-4o-mini');
    expect(p?.input).toBe(0.15);
    expect(p?.output).toBe(0.6);
  });

  it('unknown model costs 0', () => {
    expect(costForModel('totally-unknown-free-model', { prompt_tokens: 1000, completion_tokens: 500 })).toBe(0);
  });

  it('averages meta costs', () => {
    const tokens = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    const avg = averageModelCosts(['gpt-4o-mini', 'totally-unknown-free-model'], tokens);
    // only mini contributes: 0.15 $/1M * 1M = 0.15, avg with 0 = 0.075
    expect(avg).toBeCloseTo(0.075, 5);
  });
});

describe('multi-key /v1', () => {
  it('lists keys masked', async () => {
    const res = await request(app).get('/api/keys').set('X-Admin-Token', adminToken);
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBeGreaterThanOrEqual(1);
    expect(res.body.keys.some((k: { keyPreview: string }) => k.keyPreview.includes('…'))).toBe(true);
  });

  it('accepts hel_dev key on /v1', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${clientKey}`)
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(res.status).toBe(200);
    expect(res.headers['x-ctrl-cost']).toBeTruthy();
    expect(res.headers['x-ctrl-key-env']).toBe('dev');
  });

  it('meta model sets header', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${clientKey}`)
      .send({
        model: 'helmora-mini-1.0',
        messages: [{ role: 'user', content: 'meta route' }],
      });
    expect(res.status).toBe(200);
    expect(res.headers['x-ctrl-meta-model']).toBe('helmora-mini-1.0');
  });

  it('rejects invalid Helmora tool policy before routing', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${clientKey}`)
      .set('X-Helmora-Tools', 'always')
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_tools_policy');
  });

  it('rejects client-defined tools and tool-role messages explicitly', async () => {
    const definition = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${clientKey}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      });
    expect(definition.status).toBe(400);
    expect(definition.body.error.type).toBe('client_tools_unsupported');

    const toolMessage = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${clientKey}`)
      .send({
        model: 'auto',
        messages: [{ role: 'tool', content: 'untrusted result' }],
      });
    expect(toolMessage.status).toBe(400);
    expect(toolMessage.body.error.type).toBe('client_tools_unsupported');
  });

  it('allows X-Helmora-Tools in browser preflight', async () => {
    const res = await request(app)
      .options('/v1/chat/completions')
      .set('Origin', 'https://admin.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,x-helmora-tools');
    expect(res.status).toBe(204);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase())
      .toContain('x-helmora-tools');
  });

  it('enforces budget', async () => {
    const store = getConfigStore();
    const keys = await store.listApiKeys();
    const testKey = keys.find((k) => k.name === 'Test dev');
    expect(testKey).toBeTruthy();
    // Drain budget
    await store.addApiKeySpend(testKey!.id, 1);

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${clientKey}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'nope' }],
      });
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe('insufficient_quota');
  });

  it('creates hel_pro key', async () => {
    const res = await request(app)
      .post('/api/keys')
      .set('X-Admin-Token', adminToken)
      .send({ name: 'Prod', keyEnv: 'pro', expiresInDays: 30 });
    expect(res.status).toBe(201);
    expect(res.body.plaintext).toMatch(/^hel_pro_/);
    expect(res.body.key.expiresAt).toBeGreaterThan(Date.now());
  });
});
