import type Database from 'better-sqlite3';
import { createOAuthState, createPkcePair } from './pkce.js';
import { createPending, consumePending, PENDING_OAUTH_TTL_MS } from './pending-state.js';
import {
  deleteBundle,
  getBundle,
  getCredentialVersion,
  putBundle,
  putBundleIfVersion,
} from './vault.js';
import { getOAuthHandler } from './registry.js';
import {
  isHardOAuthRefreshError,
  withRefreshSingleflight,
} from './refresh-lock.js';
import { enqueueOAuthVerify } from './verify-queue.js';
import {
  buildFrontendOAuthRedirect,
  mapIdpCallbackError,
  type OAuthCallbackErrorCode,
} from './errors.js';
import type { OAuthRuntimeState, ProviderAuthMode } from './credential-flags.js';
import type { OAuthTokenBundle } from './types.js';
import { hashOAuthState } from './pkce.js';

export type OAuthCoreDeps = {
  db: Database.Database;
  encryptionKey: string;
  publicUrl: string;
  frontendUrl: string;
  /** Persist auth_mode / oauth_state on the provider row. */
  setProviderOAuthFlags: (
    providerId: string,
    flags: { authMode?: ProviderAuthMode; oauthState?: OAuthRuntimeState }
  ) => void;
  /** Read enabled + oauth flags (for refresh DTO / tests). */
  getProviderOAuthSnapshot: (providerId: string) => {
    enabled: boolean;
    authMode: ProviderAuthMode;
    oauthState: OAuthRuntimeState;
  } | null;
};

export type StartOAuthInput = {
  providerId: string;
  adminSessionId: string;
  encryptionKey?: string;
  publicUrl?: string;
  frontendUrl?: string;
};

export type StartOAuthResult = {
  authorizeUrl: string;
  expiresAt: string;
};

export type RefreshOAuthResult = {
  ok: boolean;
  oauthConnected: boolean;
  oauthExpiresAt: string | null;
  oauthState: OAuthRuntimeState;
};

function redirectUri(publicUrl: string): string {
  return `${publicUrl.replace(/\/$/, '')}/api/oauth/callback`;
}

function normalizeFrontend(frontendUrl: string): string {
  return frontendUrl.replace(/\/$/, '');
}

function expiresAtIso(bundle: OAuthTokenBundle | null): string | null {
  if (bundle?.expiresAt == null) return null;
  return new Date(bundle.expiresAt).toISOString();
}

/**
 * Look up pending row without consuming — used to classify expired vs invalid.
 */
function inspectPending(
  db: Database.Database,
  statePlain: string,
  now: number
): { providerId: string; expired: boolean; consumed: boolean } | null {
  const stateHash = hashOAuthState(statePlain);
  const row = db
    .prepare(
      `SELECT provider_id, expires_at, consumed_at FROM oauth_pending_states WHERE state_hash = ?`
    )
    .get(stateHash) as
    | { provider_id: string; expires_at: number; consumed_at: number | null }
    | undefined;
  if (!row) return null;
  return {
    providerId: row.provider_id,
    expired: row.expires_at <= now,
    consumed: row.consumed_at != null,
  };
}

export class OAuthCore {
  constructor(private readonly deps: OAuthCoreDeps) {}

  private key(override?: string): string {
    return override ?? this.deps.encryptionKey;
  }

  private publicUrl(override?: string): string {
    return (override ?? this.deps.publicUrl).replace(/\/$/, '');
  }

  private frontendUrl(override?: string): string {
    return normalizeFrontend(override ?? this.deps.frontendUrl);
  }

  async startOAuth(input: StartOAuthInput): Promise<StartOAuthResult> {
    const handler = getOAuthHandler(input.providerId);
    if (!handler || handler.flow !== 'authorization_code_pkce') {
      const err = new Error('provider_not_supported');
      (err as { code?: string }).code = 'provider_not_supported';
      throw err;
    }

    const encryptionKey = this.key(input.encryptionKey);
    const publicUrl = this.publicUrl(input.publicUrl);
    const { verifier, challenge } = createPkcePair();
    const state = createOAuthState();
    const now = Date.now();

    const pending = createPending(this.deps.db, {
      statePlain: state,
      providerId: input.providerId,
      codeVerifier: verifier,
      initiatingSessionId: input.adminSessionId,
      encryptionKey,
      now,
      ttlMs: PENDING_OAUTH_TTL_MS,
    });

    const authorizeUrl = await handler.buildAuthorizeUrl({
      state,
      codeChallenge: challenge,
      redirectUri: redirectUri(publicUrl),
    });

    return {
      authorizeUrl,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /**
   * Handle IdP callback. Returns the SPA redirect URL (never tokens).
   * Query `provider` is ignored for success path — pending row wins.
   */
  async handleCallback(input: {
    query: Record<string, string | string[] | undefined>;
    encryptionKey?: string;
    frontendUrl?: string;
    publicUrl?: string;
  }): Promise<{ redirectUrl: string }> {
    const q = flattenQuery(input.query);
    const frontend = this.frontendUrl(input.frontendUrl);
    const encryptionKey = this.key(input.encryptionKey);
    const publicUrl = this.publicUrl(input.publicUrl);
    const hintProvider = (q.provider ?? '').trim() || 'unknown';
    const now = Date.now();

    if (q.error) {
      const code = mapIdpCallbackError({
        error: q.error,
        error_description: q.error_description,
        code: q.code,
        state: q.state,
      });
      let providerId = hintProvider;
      if (q.state) {
        const peeked = inspectPending(this.deps.db, q.state, now);
        if (peeked) providerId = peeked.providerId;
      }
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId,
          code,
        }),
      };
    }

    if (!q.state?.trim()) {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId: hintProvider,
          code: 'invalid_state',
        }),
      };
    }

    if (!q.code?.trim()) {
      let providerId = hintProvider;
      const peeked = inspectPending(this.deps.db, q.state, now);
      if (peeked) providerId = peeked.providerId;
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId,
          code: 'missing_code',
        }),
      };
    }

    const peeked = inspectPending(this.deps.db, q.state, now);
    if (!peeked) {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId: hintProvider,
          code: 'invalid_state',
        }),
      };
    }
    if (peeked.consumed) {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId: peeked.providerId,
          code: 'invalid_state',
        }),
      };
    }
    if (peeked.expired) {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId: peeked.providerId,
          code: 'expired_state',
        }),
      };
    }

    const pending = consumePending(this.deps.db, q.state, encryptionKey, now);
    if (!pending) {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId: peeked.providerId,
          code: 'invalid_state',
        }),
      };
    }

    // Pending provider always wins over query override.
    const providerId = pending.providerId;
    const handler = getOAuthHandler(providerId);
    if (!handler) {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId,
          code: 'provider_not_supported',
        }),
      };
    }

    let bundle: OAuthTokenBundle;
    try {
      bundle = await handler.exchangeCode({
        code: q.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: redirectUri(publicUrl),
      });
    } catch {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId,
          code: 'exchange_failed',
        }),
      };
    }

    try {
      putBundle(this.deps.db, providerId, bundle, encryptionKey, now);
      this.deps.setProviderOAuthFlags(providerId, {
        authMode: 'oauth',
        oauthState: 'verification_pending',
      });
    } catch {
      return {
        redirectUrl: buildFrontendOAuthRedirect(frontend, {
          ok: false,
          providerId,
          code: 'persist_failed',
        }),
      };
    }

    // Enqueue once; drain is scheduled by the queue (setImmediate). Do not verify on SPA refetch.
    enqueueOAuthVerify(providerId);

    return {
      redirectUrl: buildFrontendOAuthRedirect(frontend, {
        ok: true,
        providerId,
      }),
    };
  }

  refreshOAuth(providerId: string): Promise<RefreshOAuthResult> {
    return withRefreshSingleflight(providerId, () => this.runRefresh(providerId));
  }

  private async runRefresh(providerId: string): Promise<RefreshOAuthResult> {
    const encryptionKey = this.key();
    const handler = getOAuthHandler(providerId);
    const snap = this.deps.getProviderOAuthSnapshot(providerId);

    const failDto = (
      ok: boolean,
      oauthState: OAuthRuntimeState,
      bundle: OAuthTokenBundle | null
    ): RefreshOAuthResult => ({
      ok,
      oauthConnected: bundle != null,
      oauthExpiresAt: expiresAtIso(bundle),
      oauthState,
    });

    if (!handler?.supportsRefresh || !handler.refreshToken) {
      const bundle = getBundle(this.deps.db, providerId, encryptionKey);
      return failDto(false, snap?.oauthState ?? 'none', bundle);
    }

    // Re-read inside singleflight critical section.
    const bundle = getBundle(this.deps.db, providerId, encryptionKey);
    const version = getCredentialVersion(this.deps.db, providerId);
    if (!bundle || version == null) {
      return failDto(false, 'none', null);
    }

    try {
      const next = await handler.refreshToken(bundle);
      const casOk = putBundleIfVersion(
        this.deps.db,
        providerId,
        next,
        version,
        encryptionKey
      );
      if (!casOk) {
        // Another writer won; re-read and return current.
        const current = getBundle(this.deps.db, providerId, encryptionKey);
        const state = this.deps.getProviderOAuthSnapshot(providerId)?.oauthState ?? 'connected';
        return failDto(true, state, current);
      }

      const state: OAuthRuntimeState =
        snap?.oauthState === 'needs_reconnect' ? 'connected' : snap?.oauthState ?? 'connected';
      if (state === 'connected' || snap?.oauthState === 'needs_reconnect') {
        this.deps.setProviderOAuthFlags(providerId, { oauthState: 'connected' });
      }

      return {
        ok: true,
        oauthConnected: true,
        oauthExpiresAt: expiresAtIso(next),
        oauthState: 'connected',
      };
    } catch (err) {
      if (isHardOAuthRefreshError(err)) {
        this.deps.setProviderOAuthFlags(providerId, {
          oauthState: 'needs_reconnect',
        });
        // enabled unchanged — do not touch enabled
        return failDto(false, 'needs_reconnect', bundle);
      }
      // Soft: keep bundle, do not set needs_reconnect
      const state = snap?.oauthState ?? 'connected';
      return failDto(false, state, bundle);
    }
  }

  async disconnectOAuth(providerId: string): Promise<{ ok: true }> {
    const encryptionKey = this.key();
    const handler = getOAuthHandler(providerId);
    const bundle = getBundle(this.deps.db, providerId, encryptionKey);

    if (handler?.revoke && bundle) {
      try {
        await handler.revoke(bundle);
      } catch {
        // best-effort revoke
      }
    }

    deleteBundle(this.deps.db, providerId);
    this.deps.setProviderOAuthFlags(providerId, {
      authMode: 'none',
      oauthState: 'none',
    });

    return { ok: true };
  }
}

function flattenQuery(
  query: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    out[k] = Array.isArray(v) ? String(v[0] ?? '') : String(v);
  }
  return out;
}

export type { OAuthCallbackErrorCode };
