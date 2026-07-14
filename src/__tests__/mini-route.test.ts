import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig } from '../lib/config.js';
import { initStorage, closeStorage } from '../storage/index.js';
import { getSetting, getUnifiedApiKey, setSetting, updateProvider } from '../db/index.js';
import { createApp } from '../app.js';
import {
  DEFAULT_MINI_ROUTE,
  DEFAULT_MINI_ROLE_CONFIG,
  getMiniRoleConfigProjection,
  normalizeMiniRouteConfig,
  normalizeMiniRoleConfig,
  projectLegacyMiniRouteConfig,
  resolveMiniRouteChain,
  resolveEffectiveMiniRoleSlots,
  setMiniRouteConfig,
  setMiniRoleConfig,
} from '../services/mini-route.js';
import type { StoredHubModel } from '../models/types.js';
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
  const catalogModel = (
    id: string,
    providerId: string,
    modelId: string,
    isDefault = false
  ): StoredHubModel => ({
    id,
    providerId,
    modelId,
    displayName: modelId,
    source: 'manual',
    notes: null,
    enabled: true,
    isDefault,
    isBenchmark: false,
    billing: null,
    inputPricePerMTok: null,
    outputPricePerMTok: null,
    contextWindow: null,
    capabilities: null,
    createdAt: 1,
    updatedAt: 1,
  });

  it('normalizes version 2 role assignments for every fixed role', () => {
    const config = normalizeMiniRoleConfig({
      version: 2,
      enabled: false,
      roles: {
        general: {
          primaryCatalogId: ' mdl-general ',
          fallbackCatalogId: 'mdl-fallback',
        },
        coding: {
          primaryCatalogId: 'mdl-code',
          fallbackCatalogId: 42,
        },
      },
    });

    expect(config).toEqual({
      ...DEFAULT_MINI_ROLE_CONFIG,
      enabled: false,
      roles: {
        ...DEFAULT_MINI_ROLE_CONFIG.roles,
        general: {
          primaryCatalogId: 'mdl-general',
          fallbackCatalogId: 'mdl-fallback',
        },
        coding: {
          primaryCatalogId: 'mdl-code',
          fallbackCatalogId: null,
        },
      },
    });
  });

  it('projects legacy candidates onto General without persisting the migration', () => {
    const result = projectLegacyMiniRouteConfig(
      {
        enabled: false,
        candidates: [
          { providerId: 'provider-a', modelId: 'model-a' },
          { providerId: 'provider-b', modelId: null },
        ],
      },
      [
        catalogModel('mdl-a', 'provider-a', 'model-a'),
        catalogModel('mdl-b-default', 'provider-b', 'model-b', true),
      ]
    );

    expect(result.config.enabled).toBe(false);
    expect(result.config.roles.general).toEqual({
      primaryCatalogId: 'mdl-a',
      fallbackCatalogId: 'mdl-b-default',
    });
    expect(result.migratedFromLegacy).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('omits unmatched legacy candidates and returns a migration warning', () => {
    const result = projectLegacyMiniRouteConfig(
      {
        enabled: true,
        candidates: [{ providerId: 'missing', modelId: 'gone' }],
      },
      []
    );

    expect(result.config.roles.general.primaryCatalogId).toBeNull();
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'legacy_candidate_unmapped',
        candidateIndex: 0,
      }),
    ]);
  });

  it('reads legacy storage non-destructively and persists v2 only on an explicit save', async () => {
    const legacy = {
      enabled: true,
      mode: 'smart',
      candidates: [{ providerId: 'missing', modelId: 'gone' }],
      fallbackToModeChain: true,
    };
    await setSetting('mini_route_v1', JSON.stringify(legacy));

    const projected = await getMiniRoleConfigProjection();
    expect(projected.migratedFromLegacy).toBe(true);
    expect(JSON.parse((await getSetting('mini_route_v1')) ?? '{}')).toEqual(legacy);

    await setMiniRoleConfig(projected.config);
    expect(JSON.parse((await getSetting('mini_route_v1')) ?? '{}')).toEqual(projected.config);
  });

  it('inherits missing specialist slots independently and removes duplicates', () => {
    const config = normalizeMiniRoleConfig({
      version: 2,
      roles: {
        general: {
          primaryCatalogId: 'mdl-general-primary',
          fallbackCatalogId: 'mdl-general-fallback',
        },
        coding: {
          primaryCatalogId: 'mdl-code-primary',
          fallbackCatalogId: null,
        },
        review: {
          primaryCatalogId: null,
          fallbackCatalogId: 'mdl-review-fallback',
        },
        research: {
          primaryCatalogId: 'mdl-general-fallback',
          fallbackCatalogId: null,
        },
      },
    });

    expect(resolveEffectiveMiniRoleSlots(config, 'coding')).toEqual([
      { slot: 'primary', catalogId: 'mdl-code-primary', inheritedFromGeneral: false },
      { slot: 'fallback', catalogId: 'mdl-general-fallback', inheritedFromGeneral: true },
    ]);
    expect(resolveEffectiveMiniRoleSlots(config, 'review')).toEqual([
      { slot: 'primary', catalogId: 'mdl-general-primary', inheritedFromGeneral: true },
      { slot: 'fallback', catalogId: 'mdl-review-fallback', inheritedFromGeneral: false },
    ]);
    expect(resolveEffectiveMiniRoleSlots(config, 'research')).toEqual([
      { slot: 'primary', catalogId: 'mdl-general-fallback', inheritedFromGeneral: false },
    ]);
    expect(resolveEffectiveMiniRoleSlots(config, 'general')).toHaveLength(2);
  });

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
