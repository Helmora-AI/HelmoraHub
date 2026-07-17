import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request, { TEST_SETUP_TOKEN } from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { createApp } from '../app.js';
import { closeStorage, getConfigStore, initStorage } from '../storage/index.js';
import { DEFAULT_TOOL_RUNTIME_CONFIG } from '../services/tool-config.js';

describe('Tools admin API', () => {
  let app: Express;
  let tmpDir: string;
  let adminToken: string;
  let primaryCatalogId: string;
  let fallbackCatalogId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-tools-admin-'));
    process.env.DATA_DIR = tmpDir;
    process.env.STORAGE_BACKEND = 'local';
    process.env.RATE_BACKEND = 'memory';
    process.env.ENCRYPTION_KEY = 'tools-admin-test-encryption-key';
    delete process.env.HELMORA_ADMIN_PASSWORD;
    delete process.env.HELMORA_ADMIN_TOKEN;
    process.env.HELMORA_SETUP_TOKEN = TEST_SETUP_TOKEN;

    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.rateBackend = 'memory';
    config.encryptionKey = 'tools-admin-test-encryption-key';
    setActiveConfig(config);
    await initStorage(config);
    const store = getConfigStore();
    const primary = await store.createHubModel({
      providerId: 'groq',
      modelId: 'tools/planner-primary',
    });
    const fallback = await store.createHubModel({
      providerId: 'openrouter',
      modelId: 'tools/planner-fallback',
    });
    primaryCatalogId = primary.id;
    fallbackCatalogId = fallback.id;
    app = createApp(config);

    const setup = await request(app)
      .post('/api/auth/setup')
      .send({
        password: 'tools-admin-test-password',
        setupToken: TEST_SETUP_TOKEN,
      });
    adminToken = setup.body.adminToken;
  });

  afterAll(async () => {
    await closeStorage();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires admin authentication for every Tools endpoint', async () => {
    expect((await request(app).get('/api/tools')).status).toBe(401);
    expect((await request(app).put('/api/tools/config').send(DEFAULT_TOOL_RUNTIME_CONFIG)).status)
      .toBe(401);
    expect((await request(app).put('/api/tools/connectors/tinyfish/credential').send({})).status)
      .toBe(401);
    expect((await request(app).post('/api/tools/connectors/tinyfish/test')).status).toBe(401);
    expect((await request(app).get('/api/tools/activity')).status).toBe(401);
  });

  it('returns a disabled default, immutable registry, masked credential state, and summaries', async () => {
    const response = await request(app)
      .get('/api/tools')
      .set('X-Admin-Token', adminToken);

    expect(response.status).toBe(200);
    expect(response.body.config).toEqual(DEFAULT_TOOL_RUNTIME_CONFIG);
    expect(response.body.registry.tools.map((tool: { id: string }) => tool.id)).toEqual([
      'web_search',
      'web_fetch',
    ]);
    expect(response.body.connectors.tinyfish).toMatchObject({
      credentialConfigured: false,
      credentialHint: null,
      status: 'disabled',
    });
    expect(response.body.orchestrator).toEqual({ primary: null, fallback: null });
    expect(response.body.runtime).toEqual({
      status: 'disabled',
      executable: false,
      blockingReasons: ['runtime_disabled', 'connector_disabled'],
    });
    expect(response.body.activity).toEqual([]);
  });

  it('rejects secrets, server-owned fields, unknown tools, and invalid catalog references', async () => {
    const invalid = structuredClone(DEFAULT_TOOL_RUNTIME_CONFIG) as Record<string, unknown>;
    (invalid.connectors as Record<string, Record<string, unknown>>).tinyfish.apiKey = 'leak';
    (invalid.toolOverrides as Array<Record<string, unknown>>)[0]!.risk = 'write';
    (invalid.orchestrator as Record<string, unknown>).primaryCatalogId = 'missing_catalog';

    const response = await request(app)
      .put('/api/tools/config')
      .set('X-Admin-Token', adminToken)
      .send(invalid);

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('validation_error');
    expect(response.body.error.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'connectors.tinyfish.apiKey', code: 'secret_not_allowed' }),
      expect.objectContaining({ path: 'toolOverrides.0.risk', code: 'server_owned_field' }),
      expect.objectContaining({
        path: 'orchestrator.primaryCatalogId',
        code: 'catalog_model_not_found',
      }),
    ]));
    expect(await getConfigStore().getSetting('tool_runtime_v1')).toBeNull();
  });

  it('atomically saves a valid config and resolves orchestrator catalog summaries', async () => {
    const draft = structuredClone(DEFAULT_TOOL_RUNTIME_CONFIG);
    draft.enabled = true;
    draft.orchestrator.primaryCatalogId = primaryCatalogId;
    draft.orchestrator.fallbackCatalogId = fallbackCatalogId;

    const response = await request(app)
      .put('/api/tools/config')
      .set('X-Admin-Token', adminToken)
      .send(draft);

    expect(response.status).toBe(200);
    expect(response.body.config.enabled).toBe(true);
    expect(response.body.runtime).toEqual({
      status: 'blocked',
      executable: false,
      blockingReasons: ['connector_disabled', 'tool_orchestrator_unavailable'],
    });
    expect(response.body.orchestrator.primary.catalogId).toBe(primaryCatalogId);
    expect(response.body.orchestrator.fallback.catalogId).toBe(fallbackCatalogId);
    expect(JSON.parse((await getConfigStore().getSetting('tool_runtime_v1'))!)).toEqual(draft);
  });

  it('sets, retains, rotates, and clears credentials without echoing the secret', async () => {
    const secret = 'tf-admin-secret-5678';
    const created = await request(app)
      .put('/api/tools/connectors/tinyfish/credential')
      .set('X-Admin-Token', adminToken)
      .send({ secret });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ credentialConfigured: true, credentialHint: '…5678' });
    expect(JSON.stringify(created.body)).not.toContain(secret);

    const retained = await request(app)
      .put('/api/tools/connectors/tinyfish/credential')
      .set('X-Admin-Token', adminToken)
      .send({});
    expect(retained.body.updatedAt).toBe(created.body.updatedAt);

    const rotatedSecret = 'tf-admin-rotated-9999';
    const rotated = await request(app)
      .put('/api/tools/connectors/tinyfish/credential')
      .set('X-Admin-Token', adminToken)
      .send({ secret: rotatedSecret });
    expect(rotated.body.credentialHint).toBe('…9999');
    expect(JSON.stringify(rotated.body)).not.toContain(rotatedSecret);

    const cleared = await request(app)
      .put('/api/tools/connectors/tinyfish/credential')
      .set('X-Admin-Token', adminToken)
      .send({ clear: true });
    expect(cleared.body).toMatchObject({ credentialConfigured: false, credentialHint: null });
    expect(await getConfigStore().getConnectorCredentialSecret('tinyfish')).toBeNull();
  });

  it('rejects invalid credential operations as field-addressable errors', async () => {
    const empty = await request(app)
      .put('/api/tools/connectors/tinyfish/credential')
      .set('X-Admin-Token', adminToken)
      .send({ secret: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.fields).toContainEqual(expect.objectContaining({
      path: 'secret',
      code: 'invalid_secret',
    }));

    const conflicting = await request(app)
      .put('/api/tools/connectors/tinyfish/credential')
      .set('X-Admin-Token', adminToken)
      .send({ secret: 'must-not-store', clear: true });
    expect(conflicting.status).toBe(400);
    expect(JSON.stringify(conflicting.body)).not.toContain('must-not-store');
    expect(await getConfigStore().getConnectorCredentialSecret('tinyfish')).toBeNull();
  });

  it('tests TinyFish Search live without cache and exposes only safe bounded activity', async () => {
    const draft = structuredClone(DEFAULT_TOOL_RUNTIME_CONFIG);
    draft.enabled = true;
    draft.connectors.tinyfish.enabled = true;
    draft.orchestrator.primaryCatalogId = primaryCatalogId;
    draft.orchestrator.fallbackCatalogId = fallbackCatalogId;
    await request(app)
      .put('/api/tools/config')
      .set('X-Admin-Token', adminToken)
      .send(draft);
    const secret = 'tf-live-test-secret-1234';
    await request(app)
      .put('/api/tools/connectors/tinyfish/credential')
      .set('X-Admin-Token', adminToken)
      .send({ secret });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://api.search.tinyfish.ai/');
      expect(url.searchParams.get('query')).toBe('TinyFish connectivity check');
      return new Response(JSON.stringify({
        query: 'TinyFish connectivity check',
        results: [{ title: 'TinyFish', snippet: 'Healthy', url: 'https://www.tinyfish.ai/' }],
      }), { status: 200 });
    });

    const first = await request(app)
      .post('/api/tools/connectors/tinyfish/test')
      .set('X-Admin-Token', adminToken);
    const second = await request(app)
      .post('/api/tools/connectors/tinyfish/test')
      .set('X-Admin-Token', adminToken);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      connectorId: 'tinyfish',
      toolId: 'web_search',
      cacheHit: false,
      sourceCount: 1,
    });
    expect(first.body.health.status).toBe('ready');
    expect(JSON.stringify(first.body)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(2); // the second test bypassed the first result cache
    fetchMock.mockRestore();

    const activity = await request(app)
      .get('/api/tools/activity?limit=1')
      .set('X-Admin-Token', adminToken);
    expect(activity.status).toBe(200);
    expect(activity.body.items).toHaveLength(1);
    expect(activity.body.items[0]).toMatchObject({
      toolId: 'web_search',
      connector: 'tinyfish',
      source: 'admin_connector_test',
      status: 'completed',
    });
    expect(activity.body.items[0]).not.toHaveProperty('arguments');
    expect(activity.body.items[0]).not.toHaveProperty('content');
    expect(activity.body.items[0]).not.toHaveProperty('rawUrl');
    expect(JSON.stringify(activity.body)).not.toContain(secret);
    expect(activity.body.nextCursor).toEqual(expect.any(String));

    const nextPage = await request(app)
      .get(`/api/tools/activity?limit=1&cursor=${encodeURIComponent(activity.body.nextCursor)}`)
      .set('X-Admin-Token', adminToken);
    expect(nextPage.status).toBe(200);
    expect(nextPage.body.items).toHaveLength(1);
    expect(nextPage.body.items[0].id).not.toBe(activity.body.items[0].id);

    const invalidLimit = await request(app)
      .get('/api/tools/activity?limit=1000')
      .set('X-Admin-Token', adminToken);
    expect(invalidLimit.status).toBe(400);
    const invalidCursor = await request(app)
      .get('/api/tools/activity?cursor=not-a-valid-cursor')
      .set('X-Admin-Token', adminToken);
    expect(invalidCursor.status).toBe(400);
  });
});
