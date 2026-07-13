import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';

vi.mock('../providers/verify.js', async () => {
  const actual = await vi.importActual<typeof import('../providers/verify.js')>(
    '../providers/verify.js'
  );
  return {
    ...actual,
    verifyProvider: vi.fn(async (provider, overrides) => ({
      ok: true,
      verifyStatus: 'ok' as const,
      verifyError: null,
      verifiedAt: Date.now(),
      enabled: true,
      latencyMs: 12,
      model:
        overrides?.benchmarkModel ??
        provider.benchmarkModel ??
        provider.defaultModel ??
        'probe-model',
    })),
  };
});

let app: Express;
let tmpDir: string;
let adminToken: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-verify-persist-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-verify-persist!!';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_TOKEN;
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.CTRLHUB_ADMIN_TOKEN;
  delete process.env.CTRLHUB_ADMIN_PASSWORD;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = 'test-encryption-key-verify-persist!!';
  setActiveConfig(config);
  await initStorage(config);
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'verify-persist-password' });
  if (setup.status === 409) {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ password: 'verify-persist-password' });
    expect(login.status).toBe(200);
    adminToken = login.body.adminToken ?? login.body.token;
  } else {
    expect(setup.status).toBe(200);
    adminToken = setup.body.adminToken ?? setup.body.token;
  }
  expect(adminToken).toBeTruthy();
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function withAdmin(req: ReturnType<typeof request>) {
  return req
    .set('X-Admin-Token', adminToken)
    .set('Authorization', `Bearer ${adminToken}`);
}

describe('verify persistOnSuccess + enable (all API-key providers)', () => {
  it('keeps verifyStatus=ok after persist and allows enable', async () => {
    const id = 'ollama';
    const verify = await withAdmin(request(app).post(`/api/providers/${id}/verify`)).send({
      credential: 'ollama-cloud-key-test',
      benchmarkModel: 'llama3.2',
      persistOnSuccess: true,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.verifyStatus).toBe('ok');
    expect(verify.body.provider.verifyStatus).toBe('ok');
    expect(verify.body.provider.credentialConfigured).toBe(true);

    const stored = await getConfigStore().getProvider(id);
    expect(stored?.verifyStatus).toBe('ok');
    expect(stored?.apiKey).toBe('ollama-cloud-key-test');
    expect(stored?.authMode).toBe('api_key');

    const enable = await withAdmin(request(app).patch(`/api/providers/${id}`)).send({
      enabled: true,
    });
    expect(enable.status).toBe(200);
    expect(enable.body.provider.enabled).toBe(true);
    expect(enable.body.provider.verifyStatus).toBe('ok');
  });

  it('rejects enable when verifyStatus is not ok', async () => {
    await getConfigStore().updateProvider('groq', {
      verifyStatus: 'never',
      enabled: false,
      apiKey: 'x',
      authMode: 'api_key',
    });
    const enable = await withAdmin(request(app).patch('/api/providers/groq')).send({
      enabled: true,
    });
    expect(enable.status).toBe(400);
    expect(enable.body.error?.code).toBe('verify_required');
  });

  it('old SPA pattern: verify without persist then PATCH credential wipes status', async () => {
    const id = 'mistral';
    const verify = await withAdmin(request(app).post(`/api/providers/${id}/verify`)).send({
      credential: 'mistral-ephemeral',
      persistOnSuccess: false,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.provider.verifyStatus).toBe('ok');
    expect((await getConfigStore().getProvider(id))?.apiKey).not.toBe('mistral-ephemeral');
    expect((await getConfigStore().getProvider(id))?.verifyStatus).toBe('ok');

    const patch = await withAdmin(request(app).patch(`/api/providers/${id}`)).send({
      credential: 'mistral-ephemeral',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.provider.verifyStatus).toBe('never');
  });
});
