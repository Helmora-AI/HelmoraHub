import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request, { TEST_SETUP_TOKEN } from './test-request.js';
import { loadConfig } from '../lib/config.js';
import { initStorage, closeStorage } from '../storage/index.js';
import { getConfigStore } from '../storage/index.js';
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
  resolveMiniCatalogAttempts,
  resolveEffectiveMiniRoleSlots,
  setMiniRouteConfig,
  setMiniRoleConfig,
} from '../services/mini-route.js';
import type { StoredHubModel } from '../models/types.js';
import type { ProviderToggle } from '../types.js';
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
  process.env.HELMORA_SETUP_TOKEN = TEST_SETUP_TOKEN;
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
    .send({ password: 'mini-route-admin-password', setupToken: TEST_SETUP_TOKEN });
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
  const emptyRoles = () => ({
    general: { primaryCatalogId: null, fallbackCatalogId: null },
    reasoning: { primaryCatalogId: null, fallbackCatalogId: null },
    coding: { primaryCatalogId: null, fallbackCatalogId: null },
    research: { primaryCatalogId: null, fallbackCatalogId: null },
    creative: { primaryCatalogId: null, fallbackCatalogId: null },
    review: { primaryCatalogId: null, fallbackCatalogId: null },
  });

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

  const providerToggle = (
    id: string,
    overrides: Partial<ProviderToggle> = {}
  ): ProviderToggle => ({
    id,
    label: id,
    enabled: true,
    tier: 2,
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    defaultModel: null,
    allowedModes: ['smart'],
    capabilities: ['streaming'],
    protocol: 'openai',
    authStyle: 'bearer',
    benchmarkModel: null,
    pinnedModels: [],
    verifyStatus: 'ok',
    verifyError: null,
    verifiedAt: 1,
    source: 'test',
    catalogReady: true,
    extraHeaders: null,
    timeoutMs: null,
    authMode: 'api_key',
    oauthState: 'none',
    ...overrides,
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

  it('resolves a role to exact catalog attempts and never appends a mode chain', () => {
    const primary = catalogModel('mdl-code', 'provider-code', 'code-model');
    const fallback = catalogModel('mdl-general-fallback', 'provider-backup', 'backup-model');
    const config = normalizeMiniRoleConfig({
      version: 2,
      roles: {
        general: { primaryCatalogId: null, fallbackCatalogId: fallback.id },
        coding: { primaryCatalogId: primary.id, fallbackCatalogId: null },
      },
    });

    const resolved = resolveMiniCatalogAttempts(
      config,
      'coding',
      [primary, fallback],
      [providerToggle('provider-code'), providerToggle('provider-backup')]
    );

    expect(resolved.configured).toBe(true);
    expect(resolved.attempts.map((attempt) => ({
      role: attempt.role,
      slot: attempt.slot,
      catalogId: attempt.catalogId,
      providerId: attempt.provider.id,
      modelId: attempt.modelId,
    }))).toEqual([
      {
        role: 'coding',
        slot: 'primary',
        catalogId: 'mdl-code',
        providerId: 'provider-code',
        modelId: 'code-model',
      },
      {
        role: 'coding',
        slot: 'fallback',
        catalogId: 'mdl-general-fallback',
        providerId: 'provider-backup',
        modelId: 'backup-model',
      },
    ]);
  });

  it('skips unroutable catalog attempts while preserving configured state', () => {
    const primary = { ...catalogModel('mdl-off', 'provider-off', 'off-model'), enabled: false };
    const fallback = catalogModel('mdl-ready', 'provider-ready', 'ready-model');
    const config = normalizeMiniRoleConfig({
      roles: {
        general: { primaryCatalogId: primary.id, fallbackCatalogId: fallback.id },
      },
    });

    const resolved = resolveMiniCatalogAttempts(
      config,
      'general',
      [primary, fallback],
      [providerToggle('provider-off'), providerToggle('provider-ready')]
    );

    expect(resolved.configured).toBe(true);
    expect(resolved.attempts.map((attempt) => attempt.catalogId)).toEqual(['mdl-ready']);
    expect(resolved.skipped).toEqual([
      expect.objectContaining({ slot: 'primary', catalogId: 'mdl-off', reason: 'model_disabled' }),
    ]);
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

  it('GET/PUT /api/mini-route persists the complete v2 role contract', async () => {
    await updateProvider('paid-upstream', { enabled: true });
    const store = getConfigStore();
    const primary = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'mini-general-primary',
    });
    const fallback = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'mini-general-fallback',
    });
    const roles = emptyRoles();
    roles.general = {
      primaryCatalogId: primary.id,
      fallbackCatalogId: fallback.id,
    };

    const put = await request(app)
      .put('/api/mini-route')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        version: 2,
        enabled: true,
        roles,
      });
    expect(put.status).toBe(200);
    expect(put.body.config.version).toBe(2);
    expect(put.body.config.roles.general).toEqual(roles.general);
    expect(put.body.resolved.roles.coding.primary).toMatchObject({
      catalogId: primary.id,
      inheritedFromGeneral: true,
      model: { providerId: 'paid-upstream', modelId: 'mini-general-primary' },
    });
    expect(put.body.classifier.roles.map((role: { id: string }) => role.id)).toEqual([
      'general',
      'reasoning',
      'coding',
      'research',
      'creative',
      'review',
    ]);
    expect(put.body.displayName).toBe('Helmora Mini 1.0');

    const get = await request(app)
      .get('/api/mini-route')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.status).toBe(200);
    expect(get.body.config.roles.general.primaryCatalogId).toBe(primary.id);
  });

  it('PUT returns field-addressable errors for missing and duplicate catalog ids', async () => {
    const roles = emptyRoles();
    roles.general = {
      primaryCatalogId: 'mdl_missing',
      fallbackCatalogId: 'mdl_missing',
    };

    const put = await request(app)
      .put('/api/mini-route')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ version: 2, enabled: true, roles });

    expect(put.status).toBe(400);
    expect(put.body.error.type).toBe('validation_error');
    expect(put.body.error.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'roles.general.fallbackCatalogId', code: 'duplicate_role_model' }),
      expect.objectContaining({ path: 'roles.general.primaryCatalogId', code: 'catalog_model_not_found' }),
    ]));
  });

  it('PUT accepts temporarily unavailable providers and returns warnings', async () => {
    const store = getConfigStore();
    const model = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'mini-temporarily-disabled',
    });
    await updateProvider('paid-upstream', { enabled: false });
    const roles = emptyRoles();
    roles.general.primaryCatalogId = model.id;

    const put = await request(app)
      .put('/api/mini-route')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ version: 2, enabled: true, roles });

    expect(put.status).toBe(200);
    expect(put.body.config.roles.general.primaryCatalogId).toBe(model.id);
    expect(put.body.resolved.roles.general.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'roles.general.primaryCatalogId',
        code: 'provider_disabled',
      }),
    ]));
  });

  it('rejects catalog deletion with every explicit v2 Mini role reference', async () => {
    const store = getConfigStore();
    const model = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'mini-delete-guard-v2',
    });
    const roles = emptyRoles();
    roles.general.primaryCatalogId = model.id;
    roles.coding.fallbackCatalogId = model.id;
    await setMiniRoleConfig({ version: 2, enabled: true, roles });

    const deleted = await request(app)
      .delete(`/api/models/${model.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleted.status).toBe(409);
    expect(deleted.body.error).toMatchObject({
      type: 'model_in_use',
      references: [
        { kind: 'helmora_mini_role', role: 'general', slot: 'primary' },
        { kind: 'helmora_mini_role', role: 'coding', slot: 'fallback' },
      ],
    });
    expect(await store.getHubModel(model.id)).not.toBeNull();
  });

  it('protects legacy candidate references before the first v2 save', async () => {
    const store = getConfigStore();
    const model = await store.createHubModel({
      providerId: 'paid-upstream',
      modelId: 'mini-delete-guard-legacy',
    });
    await setSetting('mini_route_v1', JSON.stringify({
      enabled: true,
      candidates: [{ providerId: model.providerId, modelId: model.modelId }],
    }));

    const deleted = await request(app)
      .delete(`/api/models/${model.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleted.status).toBe(409);
    expect(deleted.body.error.references).toEqual([
      { kind: 'helmora_mini_role', role: 'general', slot: 'primary' },
    ]);
    expect(await store.getHubModel(model.id)).not.toBeNull();
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
