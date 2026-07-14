import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';
import { normalizeMiniRoleConfig, setMiniRoleConfig } from '../services/mini-route.js';

let app: Express;
let tmpDir: string;
let spaToken: string;
let adminToken: string;
let v1Key: string;
let catalogId: string;
let codingCatalogId: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-chat-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-chat';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = 'test-encryption-key-chat';
  setActiveConfig(config);
  await initStorage(config);
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'chat-admin-password' });
  spaToken = setup.body.token;
  adminToken = setup.body.adminToken;
  v1Key = await getConfigStore().getUnifiedApiKey();

  // Mark paid-upstream verified so catalog models can be routable when enabled
  const store = getConfigStore();
  await store.updateProvider('paid-upstream', {
    enabled: true,
    verifyStatus: 'ok',
  });
  const created = await store.createHubModel({
    providerId: 'paid-upstream',
    modelId: 'demo/chat-test',
    displayName: 'Chat Test Model',
  });
  catalogId = created.id;
  const coding = await store.createHubModel({
    providerId: 'paid-upstream',
    modelId: 'demo/chat-coding',
    displayName: 'Chat Coding Model',
  });
  codingCatalogId = coding.id;
  const miniConfig = normalizeMiniRoleConfig({
    version: 2,
    enabled: true,
    roles: {
      general: { primaryCatalogId: catalogId, fallbackCatalogId: null },
      coding: { primaryCatalogId: codingCatalogId, fallbackCatalogId: null },
    },
  });
  await setMiniRoleConfig(miniConfig);
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('POST /api/chat/completions', () => {
  it('rejects /v1 consumer key', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${v1Key}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
    expect(res.status).toBe(401);
  });

  it('rejects long-lived admin token', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
    expect(res.status).toBe(401);
  });

  it('streams with SPA session + metadata event', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello stream' }],
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'] || '')).toContain('text/event-stream');
    const text =
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(text).toContain('event: metadata');
    expect(text).toContain('requestId');
    expect(text).toContain('[DONE]');
  });

  it('non-stream JSON with auto', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello json' }],
        stream: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.choices?.[0]?.message?.content).toBeTruthy();
    expect(res.body.model).toBe('helmora-mini-1.0');
    expect(res.headers['x-helmora-mini-role']).toBe('general');
    expect(res.headers['x-helmora-mini-slot']).toBe('primary');
  });

  it('classifies coding prompts and dispatches the coding catalog model', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'helmora-mini-1.0',
        messages: [{ role: 'user', content: 'Implement and debug this TypeScript function.' }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('helmora-mini-1.0');
    expect(res.headers['x-helmora-mini-role']).toBe('coding');
    expect(res.headers['x-helmora-mini-slot']).toBe('primary');
  });

  it('resolves catalog model ref', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: `catalog/${catalogId}`,
        messages: [{ role: 'user', content: 'catalog hi' }],
        stream: false,
      });
    expect(res.status).toBe(200);
  });

  it('rejects bare upstream model id', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'demo/chat-test',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.type).toBe('invalid_model_ref');
  });

  it('records admin_chat usage with null apiKeyId', async () => {
    await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'usage check' }],
        stream: false,
      });

    const events = await getConfigStore().listUsage({ limit: 20 });
    const admin = events.find(
      (e) => e.source === 'admin_chat' && e.miniRole === 'general'
    );
    expect(admin).toBeTruthy();
    expect(admin!.apiKeyId).toBeNull();
    expect(admin!.requestId).toMatch(/^req_/);
    expect(typeof admin!.costMicrosUsd).toBe('number');
    expect(admin!.miniSlot).toBe('primary');
    expect(admin!.miniCatalogId).toBe(catalogId);
  });

  it('records catalog usage under upstream model id', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: `catalog/${catalogId}`,
        messages: [{ role: 'user', content: 'label check' }],
        stream: false,
      });
    expect(res.status).toBe(200);

    const events = await getConfigStore().listUsage({ limit: 20 });
    const hit = events.find(
      (e) => e.source === 'admin_chat' && e.model === 'demo/chat-test'
    );
    expect(hit).toBeTruthy();
    expect(hit!.model).not.toMatch(/^catalog\//);
  });
});
