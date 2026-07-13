import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import {
  clearOAuthHandlers,
  clearOAuthVerifyQueue,
  clearRefreshLocks,
  getBundle,
  getOAuthVerifyQueueSnapshot,
  OAuthCore,
  putBundle,
  registerOAuthHandler,
  type OAuthProviderHandler,
  type OAuthTokenBundle,
} from '../oauth/index.js';
import { registerBuiltinOAuthHandlers } from '../oauth/handlers/index.js';
import type { OAuthRuntimeState, ProviderAuthMode } from '../oauth/credential-flags.js';

const ENC_KEY = 'test-encryption-key-oauth-routes!!';
const PUBLIC_URL = 'http://hub.test:20800';
const FRONTEND_URL = 'http://spa.test:5173';
const MOCK_PROVIDER = 'mock-oauth';

let app: Express;
let tmpDir: string;
let spaToken: string;
let adminToken: string;
let refreshCalls = 0;
let lastExchangedCode: string | null = null;
let refreshImpl: (bundle: OAuthTokenBundle) => Promise<OAuthTokenBundle>;

function makeMockHandler(overrides?: Partial<OAuthProviderHandler>): OAuthProviderHandler {
  return {
    providerId: MOCK_PROVIDER,
    flow: 'authorization_code_pkce',
    supportsRefresh: true,
    async buildAuthorizeUrl({ state, codeChallenge, redirectUri }) {
      const u = new URL('https://idp.test/authorize');
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('redirect_uri', redirectUri);
      return u.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      lastExchangedCode = code;
      void codeVerifier;
      void redirectUri;
      return {
        accessToken: `access-from-${code}`,
        refreshToken: 'refresh-tok',
        expiresAt: Date.now() + 3_600_000,
        tokenType: 'Bearer',
        schemaVersion: 1,
        meta: { hint: 'ok' },
      };
    },
    async refreshToken(bundle) {
      return refreshImpl(bundle);
    },
    shouldRefresh(bundle, now) {
      return (bundle.expiresAt ?? 0) < now + 60_000;
    },
    applyAuth(request, bundle) {
      return {
        ...request,
        headers: { ...(request.headers ?? {}), Authorization: `Bearer ${bundle.accessToken}` },
      };
    },
    async verify() {
      return { ok: true };
    },
    ...overrides,
  };
}

function coreFromStore(store: SqliteConfigStore): OAuthCore {
  const vault = store.getOAuthVault();
  const db = vault.getDatabase();
  return new OAuthCore({
    db,
    encryptionKey: ENC_KEY,
    publicUrl: PUBLIC_URL,
    frontendUrl: FRONTEND_URL,
    setProviderOAuthFlags: (providerId, flags) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (flags.authMode != null) {
        sets.push('auth_mode = ?');
        vals.push(flags.authMode);
      }
      if (flags.oauthState != null) {
        sets.push('oauth_state = ?');
        vals.push(flags.oauthState);
      }
      if (sets.length === 0) return;
      vals.push(providerId);
      db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    getProviderOAuthSnapshot: (providerId) => {
      const row = db
        .prepare('SELECT enabled, auth_mode, oauth_state FROM providers WHERE id = ?')
        .get(providerId) as
        | { enabled: number; auth_mode: string; oauth_state: string }
        | undefined;
      if (!row) return null;
      return {
        enabled: Boolean(row.enabled),
        authMode: row.auth_mode as ProviderAuthMode,
        oauthState: row.oauth_state as OAuthRuntimeState,
      };
    },
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-oauth-routes-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = ENC_KEY;
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  process.env.HELMORA_PUBLIC_URL = PUBLIC_URL;
  process.env.HELMORA_FRONTEND_URL = FRONTEND_URL;
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = ENC_KEY;
  config.publicUrl = PUBLIC_URL;
  config.frontendUrl = FRONTEND_URL;
  setActiveConfig(config);
  await initStorage(config);
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'oauth-admin-password' });
  spaToken = setup.body.token;
  adminToken = setup.body.adminToken;

  // Ensure a provider row exists for mock id (flags updates).
  const store = getConfigStore() as SqliteConfigStore;
  const db = store.getOAuthVault().getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO providers
      (id, label, enabled, tier, base_url, api_key, default_model, allowed_modes, capabilities, auth_mode, oauth_state)
     VALUES (?, ?, 1, 2, NULL, NULL, NULL, '["smart"]', '[]', 'none', 'none')`
  ).run(MOCK_PROVIDER, 'Mock OAuth');
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

beforeEach(() => {
  clearOAuthHandlers();
  clearOAuthVerifyQueue();
  clearRefreshLocks();
  refreshCalls = 0;
  lastExchangedCode = null;
  refreshImpl = async (bundle) => {
    refreshCalls += 1;
    return {
      ...bundle,
      accessToken: `refreshed-${refreshCalls}`,
      expiresAt: Date.now() + 3_600_000,
    };
  };
  registerOAuthHandler(makeMockHandler());
});

afterEach(() => {
  clearOAuthHandlers();
  clearRefreshLocks();
  registerBuiltinOAuthHandlers();
});

describe('OAuth start', () => {
  it('returns authorizeUrl + expiresAt for SPA session', async () => {
    const res = await request(app)
      .post(`/api/oauth/${MOCK_PROVIDER}/start`)
      .set('Authorization', `Bearer ${spaToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain('https://idp.test/authorize');
    expect(res.body.authorizeUrl).toContain('state=');
    expect(res.body.authorizeUrl).toContain('code_challenge=');
    expect(res.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.state).toBeUndefined();
  });

  it('rejects long-lived admin token on start', async () => {
    const res = await request(app)
      .post(`/api/oauth/${MOCK_PROVIDER}/start`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(401);
  });
});

describe('OAuth callback', () => {
  async function startAndCaptureState(): Promise<{ state: string; authorizeUrl: string }> {
    const res = await request(app)
      .post(`/api/oauth/${MOCK_PROVIDER}/start`)
      .set('Authorization', `Bearer ${spaToken}`)
      .send({});
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    return { state: url.searchParams.get('state')!, authorizeUrl: res.body.authorizeUrl };
  }

  it('success redirects to FRONTEND/providers?oauth=ok&provider=', async () => {
    const { state } = await startAndCaptureState();
    clearOAuthVerifyQueue();

    const res = await request(app).get(
      `/api/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`
    );

    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const loc = res.headers.location;
    expect(loc).toBe(
      `${FRONTEND_URL}/providers?oauth=ok&provider=${encodeURIComponent(MOCK_PROVIDER)}`
    );
    expect(lastExchangedCode).toBe('auth-code-1');

    // Drain is scheduled via setImmediate — wait one tick.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const snap = getOAuthVerifyQueueSnapshot();
    expect(snap.processCalls).toBe(1);
    expect(snap.queued).toEqual([]);

    const store = getConfigStore() as SqliteConfigStore;
    const row = store
      .getOAuthVault()
      .getDatabase()
      .prepare('SELECT auth_mode, oauth_state FROM providers WHERE id = ?')
      .get(MOCK_PROVIDER) as { auth_mode: string; oauth_state: string };
    expect(row.auth_mode).toBe('oauth');
    // Processor ran mock verify → connected (not double-enqueued on SPA refetch).
    expect(row.oauth_state).toBe('connected');
  });

  it('callback enqueues verify only once (SPA refetch does not re-verify)', async () => {
    const { state } = await startAndCaptureState();
    clearOAuthVerifyQueue();

    await request(app).get(
      `/api/oauth/callback?code=once-only&state=${encodeURIComponent(state)}`
    );
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const afterCallback = getOAuthVerifyQueueSnapshot().processCalls;
    expect(afterCallback).toBe(1);

    // Simulate SPA refetch of providers — must not bump verify processCalls.
    const list = await request(app)
      .get('/api/providers')
      .set('Authorization', `Bearer ${spaToken}`);
    expect(list.status).toBe(200);
    expect(getOAuthVerifyQueueSnapshot().processCalls).toBe(afterCallback);
  });

  it('access_denied → code=access_denied', async () => {
    const { state } = await startAndCaptureState();
    const res = await request(app).get(
      `/api/oauth/callback?error=access_denied&error_description=Nope&state=${encodeURIComponent(state)}&provider=evil`
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.get('oauth')).toBe('error');
    expect(loc.searchParams.get('code')).toBe('access_denied');
    expect(loc.searchParams.get('provider')).toBe(MOCK_PROVIDER);
    expect(loc.searchParams.get('error_description')).toBeNull();
  });

  it('replay callback fails with invalid_state', async () => {
    const { state } = await startAndCaptureState();
    const first = await request(app).get(
      `/api/oauth/callback?code=c1&state=${encodeURIComponent(state)}`
    );
    expect(first.status).toBe(302);
    expect(first.headers.location).toContain('oauth=ok');

    const second = await request(app).get(
      `/api/oauth/callback?code=c2&state=${encodeURIComponent(state)}`
    );
    expect(second.status).toBe(302);
    const loc = new URL(second.headers.location);
    expect(loc.searchParams.get('oauth')).toBe('error');
    expect(loc.searchParams.get('code')).toBe('invalid_state');
  });

  it('provider query override is ignored (pending provider wins)', async () => {
    const { state } = await startAndCaptureState();
    const res = await request(app).get(
      `/api/oauth/callback?code=override-test&state=${encodeURIComponent(state)}&provider=evil-provider`
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`provider=${encodeURIComponent(MOCK_PROVIDER)}`);
    expect(res.headers.location).not.toContain('evil-provider');
  });
});

describe('OAuth refresh singleflight + hard/soft', () => {
  it('10 concurrent refresh → refreshToken called once', async () => {
    const store = getConfigStore() as SqliteConfigStore;
    const db = store.getOAuthVault().getDatabase();
    const core = coreFromStore(store);

    putBundle(
      db,
      MOCK_PROVIDER,
      {
        accessToken: 'old',
        refreshToken: 'rt',
        expiresAt: Date.now() + 1000,
        schemaVersion: 1,
      },
      ENC_KEY
    );
    db.prepare(`UPDATE providers SET auth_mode = 'oauth', oauth_state = 'connected' WHERE id = ?`).run(
      MOCK_PROVIDER
    );

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    refreshImpl = async (bundle) => {
      refreshCalls += 1;
      await gate;
      return {
        ...bundle,
        accessToken: 'new-access',
        expiresAt: Date.now() + 3_600_000,
      };
    };
    refreshCalls = 0;

    // Re-register so refreshImpl closure is picked up
    clearOAuthHandlers();
    registerOAuthHandler(makeMockHandler());

    const pending = Array.from({ length: 10 }, () => core.refreshOAuth(MOCK_PROVIDER));
    // Let all waiters attach
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(pending);

    expect(refreshCalls).toBe(1);
    expect(results.every((r) => r.ok && r.oauthConnected)).toBe(true);
    expect(getBundle(db, MOCK_PROVIDER, ENC_KEY)?.accessToken).toBe('new-access');
  });

  it('hard invalid_grant → needs_reconnect, enabled unchanged', async () => {
    const store = getConfigStore() as SqliteConfigStore;
    const db = store.getOAuthVault().getDatabase();
    const core = coreFromStore(store);

    putBundle(
      db,
      MOCK_PROVIDER,
      {
        accessToken: 'old',
        refreshToken: 'rt',
        expiresAt: Date.now() + 1000,
        schemaVersion: 1,
      },
      ENC_KEY
    );
    db.prepare(
      `UPDATE providers SET enabled = 1, auth_mode = 'oauth', oauth_state = 'connected' WHERE id = ?`
    ).run(MOCK_PROVIDER);

    clearOAuthHandlers();
    registerOAuthHandler(
      makeMockHandler({
        async refreshToken() {
          const err = new Error('invalid_grant');
          (err as { code?: string; status?: number }).code = 'invalid_grant';
          (err as { status?: number }).status = 400;
          throw err;
        },
      })
    );

    const result = await core.refreshOAuth(MOCK_PROVIDER);
    expect(result.ok).toBe(false);
    expect(result.oauthState).toBe('needs_reconnect');
    expect(result.oauthConnected).toBe(true);

    const row = db
      .prepare('SELECT enabled, oauth_state FROM providers WHERE id = ?')
      .get(MOCK_PROVIDER) as { enabled: number; oauth_state: string };
    expect(row.enabled).toBe(1);
    expect(row.oauth_state).toBe('needs_reconnect');
    expect(getBundle(db, MOCK_PROVIDER, ENC_KEY)?.accessToken).toBe('old');
  });

  it('soft status 500 → no needs_reconnect', async () => {
    const store = getConfigStore() as SqliteConfigStore;
    const db = store.getOAuthVault().getDatabase();
    const core = coreFromStore(store);

    putBundle(
      db,
      MOCK_PROVIDER,
      {
        accessToken: 'old',
        refreshToken: 'rt',
        expiresAt: Date.now() + 1000,
        schemaVersion: 1,
      },
      ENC_KEY
    );
    db.prepare(
      `UPDATE providers SET enabled = 1, auth_mode = 'oauth', oauth_state = 'connected' WHERE id = ?`
    ).run(MOCK_PROVIDER);

    clearOAuthHandlers();
    registerOAuthHandler(
      makeMockHandler({
        async refreshToken() {
          const err = new Error('upstream 500');
          (err as { status?: number }).status = 500;
          throw err;
        },
      })
    );

    const result = await core.refreshOAuth(MOCK_PROVIDER);
    expect(result.ok).toBe(false);
    expect(result.oauthState).toBe('connected');

    const row = db
      .prepare('SELECT enabled, oauth_state FROM providers WHERE id = ?')
      .get(MOCK_PROVIDER) as { enabled: number; oauth_state: string };
    expect(row.enabled).toBe(1);
    expect(row.oauth_state).toBe('connected');
  });
});

describe('OAuth disconnect + no device routes', () => {
  it('disconnect clears bundle and resets auth flags', async () => {
    const store = getConfigStore() as SqliteConfigStore;
    const db = store.getOAuthVault().getDatabase();
    putBundle(
      db,
      MOCK_PROVIDER,
      {
        accessToken: 'x',
        refreshToken: 'y',
        schemaVersion: 1,
      },
      ENC_KEY
    );
    db.prepare(
      `UPDATE providers SET auth_mode = 'oauth', oauth_state = 'connected' WHERE id = ?`
    ).run(MOCK_PROVIDER);

    const res = await request(app)
      .delete(`/api/oauth/${MOCK_PROVIDER}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(getBundle(db, MOCK_PROVIDER, ENC_KEY)).toBeNull();

    const row = db
      .prepare('SELECT auth_mode, oauth_state FROM providers WHERE id = ?')
      .get(MOCK_PROVIDER) as { auth_mode: string; oauth_state: string };
    expect(row.auth_mode).toBe('none');
    expect(row.oauth_state).toBe('none');
  });

  it('does not mount device routes', async () => {
    const res = await request(app)
      .post(`/api/oauth/${MOCK_PROVIDER}/device/start`)
      .set('Authorization', `Bearer ${spaToken}`)
      .send({});
    // Unmatched under oauth router → falls through to admin requireAdmin or 404
    expect([401, 404, 405]).toContain(res.status);
  });
});
