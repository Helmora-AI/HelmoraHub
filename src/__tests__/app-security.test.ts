import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import express from 'express';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, publicErrorHandler } from '../app.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { closeStorage, initStorage } from '../storage/index.js';
import request, { TEST_SETUP_TOKEN } from './test-request.js';

describe('application perimeter hardening', () => {
  let app: Express;
  let tmpDir: string;
  const envKeys = [
    'DATA_DIR',
    'STORAGE_BACKEND',
    'RATE_BACKEND',
    'ENCRYPTION_KEY',
    'HELMORA_SETUP_TOKEN',
    'HELMORA_ADMIN_PASSWORD',
    'HELMORA_ADMIN_TOKEN',
    'HELMORA_RECOVERY_TOKEN',
  ] as const;
  let originalEnv: Map<string, string | undefined>;

  beforeEach(async () => {
    originalEnv = new Map(
      envKeys.map((key) => [key, process.env[key]] as const)
    );
    for (const key of envKeys) delete process.env[key];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-app-security-'));
    process.env.DATA_DIR = tmpDir;
    process.env.STORAGE_BACKEND = 'local';
    process.env.RATE_BACKEND = 'memory';
    process.env.ENCRYPTION_KEY = 'test-app-security-encryption-key';
    process.env.HELMORA_SETUP_TOKEN = TEST_SETUP_TOKEN;

    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    config.storageChoice = 'local';
    config.storageBackend = 'sqlite';
    config.rateBackend = 'memory';
    config.encryptionKey = 'test-app-security-encryption-key';
    setActiveConfig(config);
    await initStorage(config);
    app = createApp(config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStorage();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('enforces auth and control limits without applying the control limit to chat', async () => {
    const auth = await request(app)
      .post('/api/auth/login')
      .sendRaw(JSON.stringify({ password: 'x'.repeat(17 * 1024) }));
    expect(auth.status).toBe(413);
    expect(auth.body.error.type).toBe('payload_too_large');

    const control = await request(app)
      .post('/api/does-not-exist')
      .sendRaw(JSON.stringify({ value: 'x'.repeat(300 * 1024) }));
    expect(control.status).toBe(413);
    expect(control.body.error.type).toBe('payload_too_large');

    const chat = await request(app)
      .post('/api/chat/completions')
      .send({ messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] });
    expect(chat.status).not.toBe(413);
    expect(chat.body.error.type).toBe('setup_required');
  });

  it('rejects compressed auth and control bodies before authentication', async () => {
    const compressed = gzipSync(JSON.stringify({ password: 'secret-value' }));
    const auth = await request(app)
      .post('/api/auth/login')
      .set('Content-Encoding', 'gzip')
      .sendRaw(compressed);
    expect(auth.status).toBe(415);
    expect(auth.body.error.type).toBe('unsupported_content_encoding');

    const control = await request(app)
      .post('/api/does-not-exist')
      .set('Content-Encoding', 'gzip')
      .sendRaw(gzipSync(JSON.stringify({ value: 'control' })));
    expect(control.status).toBe(415);
    expect(control.body.error.type).toBe('unsupported_content_encoding');
  });

  it('normalizes malformed JSON without exposing parser internals', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .sendRaw('{"password":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        type: 'invalid_json',
        message: 'Request body is not valid JSON.',
      },
    });
  });

  it('marks auth and one-time credential responses as non-cacheable', async () => {
    const status = await request(app).get('/api/auth/status');
    expect(status.headers['cache-control']).toContain('no-store');

    const setup = await request(app)
      .post('/api/auth/setup')
      .send({ password: 'test-admin-password', setupToken: TEST_SETUP_TOKEN });
    expect(setup.status).toBe(200);
    expect(setup.headers['cache-control']).toContain('no-store');
    expect(setup.headers.pragma).toBe('no-cache');
    expect(setup.headers['referrer-policy']).toBe('no-referrer');
  });

  it('serves the legacy UI under a hash-based restrictive CSP', async () => {
    const response = await request(app).get('/settings');
    expect(response.status).toBe(200);
    const csp = String(response.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).toContain("style-src 'self' 'sha256-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
  });
});

describe('public unexpected error contract', () => {
  it('returns a generic internal_error while retaining details only in server logs', async () => {
    const surface = express();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    surface.get('/boom', () => {
      throw new Error('database path and secret-bearing internal detail');
    });
    surface.use(publicErrorHandler);

    const response = await request(surface).get('/boom');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        type: 'internal_error',
        message: 'An unexpected internal error occurred.',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('database path');
    expect(logged).toHaveBeenCalledOnce();
  });
});
