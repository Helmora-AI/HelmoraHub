import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import {
  closeAdminAuthStore,
  getAdminAuthStore,
} from '../lib/admin-auth-store.js';
import {
  hashSessionToken,
  issueAdminSession,
  revokeAdminSessions,
  verifyAdminSession,
} from '../lib/admin-sessions.js';

describe('SQLite-backed opaque admin sessions', () => {
  let tmpDir: string;
  let previousTtl: string | undefined;

  beforeEach(() => {
    previousTtl = process.env.HELMORA_SESSION_TTL_SEC;
    process.env.HELMORA_SESSION_TTL_SEC = '300';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-admin-session-'));
    const config = loadConfig();
    config.dataDir = tmpDir;
    config.dbPath = path.join(tmpDir, 'helmora.db');
    setActiveConfig(config);
  });

  afterEach(() => {
    vi.useRealTimers();
    closeAdminAuthStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousTtl === undefined) delete process.env.HELMORA_SESSION_TTL_SEC;
    else process.env.HELMORA_SESSION_TTL_SEC = previousTtl;
  });

  it('issues distinct cookie and SPA plaintext tokens but persists only exact hashes', () => {
    const cookie = issueAdminSession('cookie');
    const spa = issueAdminSession('spa');
    const store = getAdminAuthStore(tmpDir);

    expect(cookie.token).not.toBe(spa.token);
    expect(verifyAdminSession(cookie.token, 'cookie')).toEqual({ ok: true });
    expect(verifyAdminSession(spa.token, 'spa')).toEqual({ ok: true });
    expect(verifyAdminSession(cookie.token, 'spa')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(store.readSession(cookie.token)).toBeNull();
    expect(store.readSession(hashSessionToken(cookie.token))).toMatchObject({
      kind: 'cookie',
    });
    expect(store.readSession(hashSessionToken(spa.token))).toMatchObject({
      kind: 'spa',
    });
  });

  it('enforces the configured expiry in both issuance and verification', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
    const session = issueAdminSession('spa');

    expect(session.expiresAt).toBe('2026-07-16T00:05:00.000Z');
    vi.advanceTimersByTime(300_001);
    expect(verifyAdminSession(session.token, 'spa')).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('revokes every presented hash while leaving unrelated sessions active', () => {
    const cookie = issueAdminSession('cookie');
    const spa = issueAdminSession('spa');
    const unrelated = issueAdminSession('spa');

    expect(revokeAdminSessions([cookie.token, spa.token])).toBe(2);
    expect(verifyAdminSession(cookie.token, 'cookie').ok).toBe(false);
    expect(verifyAdminSession(spa.token, 'spa').ok).toBe(false);
    expect(verifyAdminSession(unrelated.token, 'spa')).toEqual({ ok: true });
  });
});
