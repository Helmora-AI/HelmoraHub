import type { OAuthProviderHandler, UpstreamRequest, VerifyResult } from '../handler.js';
import type { OAuthTokenBundle } from '../types.js';
import {
  CLAUDE_ANTHROPIC_VERSION,
  CLAUDE_OAUTH_BETA,
  getClaudeOAuthConfig,
} from './claude-config.js';

function parseTokenResponse(json: Record<string, unknown>): OAuthTokenBundle {
  const accessToken = String(json.access_token ?? '');
  if (!accessToken) {
    throw Object.assign(new Error('missing_access_token'), { code: 'exchange_failed' });
  }
  const expiresIn =
    typeof json.expires_in === 'number'
      ? json.expires_in
      : typeof json.expires_in === 'string'
        ? Number(json.expires_in)
        : NaN;
  const scope = typeof json.scope === 'string' ? json.scope : undefined;
  return {
    accessToken,
    refreshToken: json.refresh_token != null ? String(json.refresh_token) : null,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
    tokenType: json.token_type != null ? String(json.token_type) : 'Bearer',
    schemaVersion: 1,
    // Allowlisted meta only — never raw token JSON.
    meta: scope ? { scope } : undefined,
  };
}

export const claudeOAuthHandler: OAuthProviderHandler = {
  providerId: 'claude',
  flow: 'authorization_code_pkce',
  supportsRefresh: true,

  async buildAuthorizeUrl({ state, codeChallenge, redirectUri }) {
    const cfg = getClaudeOAuthConfig();
    const params = new URLSearchParams({
      code: 'true',
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: cfg.codeChallengeMethod,
      state,
    });
    return `${cfg.authorizeUrl}?${params.toString()}`;
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const cfg = getClaudeOAuthConfig();
    // Claude may return code#state — strip fragment.
    let authCode = code;
    let codeState = '';
    if (authCode.includes('#')) {
      const parts = authCode.split('#');
      authCode = parts[0]!;
      codeState = parts[1] || '';
    }

    const body: Record<string, string> = {
      code: authCode,
      state: codeState,
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    };
    if (cfg.clientSecret) body.client_secret = cfg.clientSecret;

    const response = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw Object.assign(new Error(`Token exchange failed: ${errText}`), {
        code: 'exchange_failed',
        status: response.status,
      });
    }

    const json = (await response.json()) as Record<string, unknown>;
    return parseTokenResponse(json);
  },

  async refreshToken(bundle) {
    const cfg = getClaudeOAuthConfig();
    if (!bundle.refreshToken) {
      throw Object.assign(new Error('missing_refresh_token'), {
        code: 'invalid_grant',
        status: 400,
      });
    }

    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      refresh_token: bundle.refreshToken,
    };
    if (cfg.clientSecret) body.client_secret = cfg.clientSecret;

    const response = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const hard = response.status === 400 || response.status === 401;
      throw Object.assign(new Error(`Refresh failed: ${errText}`), {
        code: hard ? 'invalid_grant' : 'refresh_failed',
        status: response.status,
      });
    }

    const json = (await response.json()) as Record<string, unknown>;
    const next = parseTokenResponse(json);
    // Preserve refresh token if rotation omitted it.
    if (!next.refreshToken) next.refreshToken = bundle.refreshToken;
    return next;
  },

  shouldRefresh(bundle, now) {
    const cfg = getClaudeOAuthConfig();
    if (bundle.expiresAt == null) return false;
    return bundle.expiresAt < now + cfg.refreshLeadMs;
  },

  applyAuth(request: UpstreamRequest, bundle: OAuthTokenBundle): UpstreamRequest {
    const headers: Record<string, string> = {
      ...(request.headers ?? {}),
      Authorization: `Bearer ${bundle.accessToken}`,
      'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
      'anthropic-beta': CLAUDE_OAUTH_BETA,
      'Content-Type': 'application/json',
    };
    // Prefer Bearer for oauth — do not set x-api-key.
    delete headers['x-api-key'];
    delete headers['X-Api-Key'];
    return { ...request, headers };
  },

  async verify(bundle, signal?): Promise<VerifyResult> {
    const base =
      process.env.HELMORA_OAUTH_CLAUDE_API_BASE?.trim() ||
      'https://api.anthropic.com/v1';
    const url = `${base.replace(/\/$/, '')}/messages`;
    try {
      const req = claudeOAuthHandler.applyAuth(
        {
          method: 'POST',
          url,
          headers: {},
          body: {
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          },
        },
        bundle
      );
      const response = await fetch(url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal,
      });
      if (response.ok || response.status === 400) {
        // 400 can mean model/param issues but auth worked
        return { ok: true, status: response.status };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          error: `auth_failed: ${response.status}`,
        };
      }
      return {
        ok: false,
        status: response.status,
        error: `upstream ${response.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
