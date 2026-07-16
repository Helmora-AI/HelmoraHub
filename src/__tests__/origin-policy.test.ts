import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../lib/config.js';
import {
  normalizeConfiguredOrigin,
  parseConfiguredOrigins,
} from '../lib/origin-policy.js';
import request from './test-request.js';

describe('canonical origin parsing', () => {
  it.each([
    ['HTTPS://Trusted.Example', 'https://trusted.example'],
    ['https://trusted.example:443', 'https://trusted.example'],
    ['http://trusted.example:80', 'http://trusted.example'],
    ['http://[::1]:20800', 'http://[::1]:20800'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeConfiguredOrigin(input)).toBe(expected);
  });

  it.each([
    '*',
    'null',
    'ftp://trusted.example',
    'https://user@trusted.example',
    'https://trusted.example/path',
    'https://trusted.example?query=1',
    'https://trusted.example#fragment',
    'https://trusted.example.',
    'https://*.trusted.example',
    'not a url',
  ])('rejects invalid configured origin %s', (input) => {
    expect(() => normalizeConfiguredOrigin(input)).toThrow();
  });

  it('rejects the whole list when any configured entry is malformed', () => {
    expect(() =>
      parseConfiguredOrigins({
        publicUrl: 'https://hub.example',
        frontendUrl: 'https://frontend.example',
        additionalOrigins: 'https://extra.example, https://bad.example/path',
      })
    ).toThrow();
  });
});

describe('browser origin policy', () => {
  const envKeys = [
    'DATA_DIR',
    'HELMORA_PUBLIC_URL',
    'HELMORA_FRONTEND_URL',
    'HELMORA_CORS_ORIGINS',
  ] as const;
  const original = new Map(
    envKeys.map((key) => [key, process.env[key]] as const)
  );
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    for (const key of envKeys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function appWithOrigins() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-origin-'));
    process.env.DATA_DIR = tmpDir;
    process.env.HELMORA_PUBLIC_URL = 'https://hub.example';
    process.env.HELMORA_FRONTEND_URL = 'https://frontend.example';
    process.env.HELMORA_CORS_ORIGINS =
      'https://extra.example, http://[::1]:5173';
    return createApp(loadConfig());
  }

  it('allows no-Origin server clients without emitting browser credentials headers', async () => {
    const response = await request(appWithOrigins()).get('/');
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it.each([
    'https://hub.example',
    'https://frontend.example',
    'https://extra.example',
    'http://[::1]:5173',
  ])('echoes exact configured origin %s without credentials', async (origin) => {
    const response = await request(appWithOrigins())
      .get('/')
      .set('Origin', origin);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers.vary).toContain('Origin');
  });

  it.each([
    'https://hub.example.attacker.test',
    'https://hub.example@attacker.test',
    'http://hub.example',
    'null',
  ])('rejects deceptive browser origin %s without reflecting it', async (origin) => {
    const response = await request(appWithOrigins())
      .get('/')
      .set('Origin', origin)
      .set('Host', 'hub.example')
      .set('Forwarded', 'host=hub.example;proto=https')
      .set('X-Forwarded-Host', 'hub.example');
    expect(response.status).toBe(403);
    expect(response.body.error.type).toBe('origin_not_allowed');
    expect(JSON.stringify(response.body)).not.toContain(origin);
  });

  it('uses the same allow decision for preflight', async () => {
    const allowed = await request(appWithOrigins())
      .options('/api/auth/status')
      .set('Origin', 'https://frontend.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://frontend.example'
    );

    const denied = await request(appWithOrigins())
      .options('/api/auth/status')
      .set('Origin', 'https://attacker.test')
      .set('Access-Control-Request-Method', 'GET');
    expect(denied.status).toBe(403);
    expect(denied.body.error.type).toBe('origin_not_allowed');
  });
});
