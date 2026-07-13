import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig } from '../lib/config.js';
import { initStorage, closeStorage } from '../storage/index.js';
import { getUnifiedApiKey, updateProvider } from '../db/index.js';
import { createApp } from '../app.js';
import {
  DEFAULT_MINI_ROUTE,
  normalizeMiniRouteConfig,
  resolveMiniRouteChain,
  setMiniRouteConfig,
} from '../services/mini-route.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-mini-route-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '20811';
  process.env.STORAGE_BACKEND = 'sqlite';
  process.env.RATE_BACKEND = 'memory';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-mini-route';
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.HELMORA_ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  delete process.env.CTRLHUB_API_KEY;
  delete process.env.UPSTREAM_BASE_URL;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'ctrlhub.db');
  await initStorage(config);
  await getUnifiedApiKey();
  app = createApp(config);
  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'mini-route-admin-password' });
  if (setup.status !== 200) {
    throw new Error(`admin setup failed: ${JSON.stringify(setup.body)}`);
  }
  adminToken = setup.body.adminToken;
});

afterAll(async () => {
  await closeStorage();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mini-route config', () => {
  it('normalizes defaults and dedupes candidates', () => {
    const cfg = normalizeMiniRouteConfig({
      enabled: true,
      mode: 'economy',
      fallbackToModeChain: false,
      candidates: [
        { providerId: 'paid-upstream', modelId: 'gpt-4o-mini' },
        { providerId: 'paid-upstream', modelId: 'ignored-dup' },
        { providerId: '  ', modelId: 'x' },
        { providerId: 'free-pool' },
      ],
    });
    expect(cfg.mode).toBe('economy');
    expect(cfg.fallbackToModeChain).toBe(false);
    expect(cfg.candidates).toEqual([
      { providerId: 'paid-upstream', modelId: 'gpt-4o-mini' },
      { providerId: 'free-pool', modelId: null },
    ]);
  });

  it('falls back to mode chain when candidates empty', async () => {
    await setMiniRouteConfig({ ...DEFAULT_MINI_ROUTE, mode: 'smart', candidates: [] });
    const resolved = await resolveMiniRouteChain();
    expect(resolved.mode).toBe('smart');
    expect(resolved.chain.length).toBeGreaterThan(0);
  });

  it('GET/PUT /api/mini-route persists candidates', async () => {
    await updateProvider('paid-upstream', { enabled: true });

    const put = await request(app)
      .put('/api/mini-route')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        enabled: true,
        mode: 'economy',
        fallbackToModeChain: true,
        candidates: [{ providerId: 'paid-upstream', modelId: 'demo/paid' }],
      });
    expect(put.status).toBe(200);
    expect(put.body.config.mode).toBe('economy');
    expect(put.body.config.candidates).toEqual([
      { providerId: 'paid-upstream', modelId: 'demo/paid' },
    ]);
    expect(put.body.resolved.providerIds[0]).toBe('paid-upstream');
    expect(put.body.resolved.modelByProvider['paid-upstream']).toBe('demo/paid');
    expect(put.body.displayName).toBe('Helmora Mini 1.0');

    const get = await request(app)
      .get('/api/mini-route')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.status).toBe(200);
    expect(get.body.config.candidates[0].providerId).toBe('paid-upstream');
  });

  it('orders enabled candidates first then mode fallback', async () => {
    await updateProvider('paid-upstream', { enabled: true });
    await updateProvider('free-pool', { enabled: true });

    await setMiniRouteConfig({
      enabled: true,
      mode: 'smart',
      fallbackToModeChain: true,
      candidates: [
        { providerId: 'free-pool', modelId: 'demo/free' },
        { providerId: 'paid-upstream', modelId: 'demo/paid' },
      ],
    });

    const resolved = await resolveMiniRouteChain();
    expect(resolved.chain[0]?.id).toBe('free-pool');
    expect(resolved.chain[1]?.id).toBe('paid-upstream');
    expect(resolved.modelByProvider['free-pool']).toBe('demo/free');
    expect(resolved.modelByProvider['paid-upstream']).toBe('demo/paid');
    // Mode fallback appends remaining enabled providers not already in candidates
    expect(resolved.chain.length).toBeGreaterThanOrEqual(2);
  });

  it('skips disabled candidates and can avoid mode fallback', async () => {
    await updateProvider('paid-upstream', { enabled: false });
    await updateProvider('free-pool', { enabled: true });

    await setMiniRouteConfig({
      enabled: true,
      mode: 'smart',
      fallbackToModeChain: false,
      candidates: [
        { providerId: 'paid-upstream', modelId: 'demo/paid' },
        { providerId: 'free-pool', modelId: null },
      ],
    });

    const resolved = await resolveMiniRouteChain();
    expect(resolved.chain.map((p) => p.id)).toEqual(['free-pool']);
    expect(resolved.modelByProvider['free-pool']).toBeUndefined();
  });
});
