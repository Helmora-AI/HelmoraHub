import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';
import { normalizeMiniRoleConfig, setMiniRoleConfig } from '../services/mini-route.js';

let app: Express;
let tmpDir: string;
let apiKey: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-sse-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-sse';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  delete process.env.HELMORA_API_KEY;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = 'test-encryption-key-sse';
  setActiveConfig(config);
  await initStorage(config);
  app = createApp(config);

  // bootstrap key from storage
  const { getConfigStore } = await import('../storage/index.js');
  const store = getConfigStore();
  apiKey = await store.getUnifiedApiKey();
  await store.updateProvider('paid-upstream', {
    enabled: true,
    verifyStatus: 'ok',
  });
  const model = await store.createHubModel({
    providerId: 'paid-upstream',
    modelId: 'demo/sse-mini',
  });
  await setMiniRoleConfig(normalizeMiniRoleConfig({
    version: 2,
    enabled: true,
    roles: {
      general: { primaryCatalogId: model.id, fallbackCatalogId: null },
    },
  }));
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('SSE streaming', () => {
  it('streams demo chunks then [DONE]', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'stream please' }],
      });

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'] || '')).toContain('text/event-stream');
    const raw = typeof res.body === 'string' ? res.body : String(res.body);
    // test-request may parse JSON — if so, SSE came as string body
    const text =
      typeof res.body === 'string'
        ? res.body
        : raw.includes('data:')
          ? raw
          : JSON.stringify(res.body);

    // Our test helper JSON-parses body; for SSE it keeps raw string when parse fails
    expect(text).toContain('data:');
    expect(text).toContain('[DONE]');
    expect(text).toContain('chat.completion.chunk');
    expect(res.headers['x-routed-via']).toBeTruthy();
  });

  it('non-stream still works', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toContain('Helmora AI demo');
    expect(res.body.model).toBe('demo/sse-mini');
  });

  it('keeps auto as an alias for the canonical Mini route', async () => {
    const canonical = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'helmora-mini-1.0',
        stream: false,
        messages: [{ role: 'user', content: 'hello canonical Mini' }],
      });
    const alias = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hello alias Mini' }],
      });

    expect(canonical.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(canonical.body.model).toBe('demo/sse-mini');
    expect(alias.body.model).toBe('demo/sse-mini');
  });

  it('sets SSE headers used by proxies / coding clients', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'headers' }],
      });
    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'] || '')).toMatch(/no-cache/i);
    expect(String(res.headers['x-accel-buffering'] || '')).toBe('no');
    expect(res.headers['x-ctrl-mode']).toBeTruthy();
  });
});
