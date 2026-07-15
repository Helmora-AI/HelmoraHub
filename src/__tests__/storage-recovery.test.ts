import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { loadConfig, type Config } from '../lib/config.js';
import { hashRecoveryToken } from '../lib/admin-auth.js';
import {
  readRecoverySupabaseCredential,
} from '../lib/recovery-control-vault.js';
import { updateAdminConfig } from '../lib/runtime-config.js';
import {
  SUPABASE_CONTROL_CAPABILITIES,
  probeSupabaseControlCapabilities,
  type SupabaseCapabilityProbeClient,
} from '../lib/supabase-schema.js';
import {
  closeStorage,
  getControlHealth,
  initStorage,
} from '../storage/index.js';
import type { ConfigStore } from '../storage/types.js';
import request from './test-request.js';

function hybridConfig(dir: string): Config {
  const config = loadConfig();
  config.dataDir = dir;
  config.dbPath = path.join(dir, 'helmora.db');
  config.storageChoice = 'sql';
  config.storageBackend = 'supabase';
  config.rateBackend = 'memory';
  config.supabaseUrl = 'https://old-project.supabase.co';
  config.supabaseServiceRoleKey = 'old-service-role-key';
  config.encryptionKey = 'test-storage-recovery-encryption-key';
  return config;
}

describe('Hybrid recovery storage surface', () => {
  let tmpDir: string;
  let config: Config;
  let recoveryToken: string;
  let recoverySession: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    previousEnv = {};
    for (const name of [
      'HELMORA_RECOVERY_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ENCRYPTION_KEY',
      'DATA_DIR',
    ]) {
      previousEnv[name] = process.env[name];
      delete process.env[name];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-storage-recovery-'));
    process.env.DATA_DIR = tmpDir;
    process.env.ENCRYPTION_KEY = 'test-storage-recovery-encryption-key';
    config = hybridConfig(tmpDir);
    await initStorage(config, {
      createHybridControl: () => ({
        store: { close: async () => undefined } as ConfigStore,
        bootstrap: async () => {
          throw new Error('remote probe must not run during recovery API setup');
        },
      }),
    });
    recoveryToken = 'helmora-recovery-token-storage-repair-value';
    updateAdminConfig(tmpDir, {
      recoveryTokenHash: hashRecoveryToken(recoveryToken),
    });
    const app = createApp(config);
    const login = await request(app)
      .post('/api/auth/recovery-login')
      .send({ token: recoveryToken });
    expect(login.status).toBe(200);
    recoverySession = login.body.token;
  });

  afterEach(async () => {
    await closeStorage();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports recovery readiness and exposes only masked storage repair data', async () => {
    const app = createApp(config);
    expect(getControlHealth()).toMatchObject({
      controlPlane: 'recovery_only',
      servingReady: false,
      recoveryReady: true,
    });

    const unauthenticated = await request(app).get('/api/storage/health');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.type).toBe('recovery_unauthorized');

    const health = await request(app)
      .get('/api/storage/health')
      .set('Authorization', `Bearer ${recoverySession}`);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      controlState: 'recovery_only',
      servingReady: false,
      recoveryReady: true,
    });

    const settings = await request(app)
      .get('/api/settings/storage')
      .set('Authorization', `Bearer ${recoverySession}`);
    expect(settings.status).toBe(200);
    expect(settings.body.form).toMatchObject({
      supabaseUrl: 'https://old-project.supabase.co',
      supabaseServiceRoleConfigured: true,
    });
    expect(JSON.stringify(settings.body)).not.toContain('old-service-role-key');

    const schema = await request(app)
      .get('/api/settings/storage/schema')
      .set('Authorization', `Bearer ${recoverySession}`);
    expect(schema.status).toBe(200);
    expect(schema.body.sql).toContain('helmora_connector_credentials');
  });

  it('persists only allowlisted repair fields and encrypts a replacement secret', async () => {
    const app = createApp(config);
    const replacement = 'replacement-service-role-key-secret';
    const response = await request(app)
      .put('/api/settings/storage')
      .set('Authorization', `Bearer ${recoverySession}`)
      .send({
        supabaseUrl: 'https://repaired-project.supabase.co',
        supabaseCredentialOperation: { kind: 'replace', value: replacement },
        storageModeOperation: { kind: 'switch_to_sql' },
      });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, restartRequired: true });
    expect(JSON.stringify(response.body)).not.toContain(replacement);

    const runtimeRaw = fs.readFileSync(
      path.join(tmpDir, 'runtime-config.json'),
      'utf8'
    );
    expect(runtimeRaw).not.toContain(replacement);
    expect(readRecoverySupabaseCredential(tmpDir, config.encryptionKey)).toBe(
      replacement
    );
    const repairedConfig = loadConfig();
    expect(repairedConfig.storageChoice).toBe('sql');
    expect(repairedConfig.supabaseUrl).toBe('https://repaired-project.supabase.co');
    expect(repairedConfig.supabaseServiceRoleKey).toBe(replacement);
  });

  it('rejects environment-managed replacement and forbidden recovery fields', async () => {
    const app = createApp(config);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'environment-owned-service-role';
    const envManaged = await request(app)
      .put('/api/settings/storage')
      .set('Authorization', `Bearer ${recoverySession}`)
      .send({
        supabaseCredentialOperation: {
          kind: 'replace',
          value: 'attempted-replacement-secret',
        },
      });
    expect(envManaged.status).toBe(409);
    expect(envManaged.body.error.type).toBe('credential_env_managed');

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ENCRYPTION_KEY;
    config.encryptionKey = null;
    const noEncryptionKey = await request(app)
      .put('/api/settings/storage')
      .set('Authorization', `Bearer ${recoverySession}`)
      .send({
        supabaseCredentialOperation: {
          kind: 'replace',
          value: 'replacement-without-encryption-key',
        },
      });
    expect(noEncryptionKey.status).toBe(409);
    expect(noEncryptionKey.body.error.type).toBe('encryption_key_unavailable');

    for (const body of [
      { encryptionKey: 'forbidden-new-encryption-key' },
      { clearSupabaseServiceRoleKey: true },
      { storageModeOperation: { kind: 'switch_to_local' } },
      {
        supabaseCredentialOperation: { kind: 'retain' },
        storageModeOperation: { kind: 'retain' },
      },
    ]) {
      const rejected = await request(app)
        .put('/api/settings/storage')
        .set('Authorization', `Bearer ${recoverySession}`)
        .send(body);
      expect(rejected.status).toBe(400);
    }
  });
});

describe('Supabase capability probe', () => {
  it('reports every capability and keeps missing tables field-addressable', async () => {
    const client: SupabaseCapabilityProbeClient = {
      from: (table) => ({
        select: () => ({
          limit: async () => ({
            error:
              table === 'helmora_connector_credentials'
                ? { message: `Could not find the table 'public.${table}' in the schema cache` }
                : null,
          }),
        }),
      }),
    };

    const result = await probeSupabaseControlCapabilities(client, 1_000);
    expect(result.capabilities).toHaveLength(SUPABASE_CONTROL_CAPABILITIES.length);
    expect(result.ok).toBe(false);
    expect(result.capabilities).toContainEqual({
      id: 'connector_credentials',
      table: 'helmora_connector_credentials',
      status: 'missing',
      errorCode: 'schema_incomplete',
    });
    expect(result.capabilities.filter((item) => item.status === 'ready')).toHaveLength(
      SUPABASE_CONTROL_CAPABILITIES.length - 1
    );
  });
});
