import type { OAuthProviderHandler, UpstreamRequest, VerifyResult } from '../handler.js';
import type { OAuthTokenBundle } from '../types.js';
import { CODEX_DEFAULT_BASE_URL, getCodexOAuthConfig } from './codex-config.js';

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
  return {
    accessToken,
    refreshToken: json.refresh_token != null ? String(json.refresh_token) : null,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
    tokenType: json.token_type != null ? String(json.token_type) : 'Bearer',
    schemaVersion: 1,
    meta: undefined,
  };
}

async function postForm(
  url: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const hard = response.status === 400 || response.status === 401;
    throw Object.assign(new Error(`Token request failed: ${errText}`), {
      code: hard ? 'invalid_grant' : 'token_failed',
      status: response.status,
    });
  }
  return (await response.json()) as Record<string, unknown>;
}

export const codexOAuthHandler: OAuthProviderHandler = {
  providerId: 'codex',
  flow: 'authorization_code_pkce',
  supportsRefresh: true,

  async buildAuthorizeUrl({ state, codeChallenge, redirectUri }) {
    const cfg = getCodexOAuthConfig();
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: cfg.scope,
      code_challenge: codeChallenge,
      code_challenge_method: cfg.codeChallengeMethod,
      ...cfg.extraParams,
      state,
    };
    // Encode spaces as %20 (not +) to match Codex CLI.
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return `${cfg.authorizeUrl}?${queryString}`;
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const cfg = getCodexOAuthConfig();
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    };
    if (cfg.clientSecret) params.client_secret = cfg.clientSecret;
    const json = await postForm(cfg.tokenUrl, params);
    return parseTokenResponse(json);
  },

  async refreshToken(bundle) {
    const cfg = getCodexOAuthConfig();
    if (!bundle.refreshToken) {
      throw Object.assign(new Error('missing_refresh_token'), {
        code: 'invalid_grant',
        status: 400,
      });
    }
    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      refresh_token: bundle.refreshToken,
      scope: cfg.scope,
    };
    if (cfg.clientSecret) params.client_secret = cfg.clientSecret;
    try {
      const json = await postForm(cfg.tokenUrl, params);
      const next = parseTokenResponse(json);
      if (!next.refreshToken) next.refreshToken = bundle.refreshToken;
      return next;
    } catch (err) {
      const e = err as { code?: string; status?: number };
      if (e.status === 400 || e.status === 401) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
          code: 'invalid_grant',
          status: e.status,
        });
      }
      throw err;
    }
  },

  shouldRefresh(bundle, now) {
    const cfg = getCodexOAuthConfig();
    if (bundle.expiresAt == null) return false;
    return bundle.expiresAt < now + cfg.refreshLeadMs;
  },

  applyAuth(request: UpstreamRequest, bundle: OAuthTokenBundle): UpstreamRequest {
    return {
      ...request,
      headers: {
        ...(request.headers ?? {}),
        Authorization: `Bearer ${bundle.accessToken}`,
        originator: 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/0.136.0',
        'Content-Type': 'application/json',
      },
    };
  },

  async verify(bundle, signal?): Promise<VerifyResult> {
    const base =
      process.env.HELMORA_OAUTH_CODEX_API_BASE?.trim() || CODEX_DEFAULT_BASE_URL;
    const url = base.replace(/\/$/, '');
    try {
      const req = codexOAuthHandler.applyAuth(
        {
          method: 'POST',
          url,
          headers: {},
          body: {
            model: 'gpt-5.4-mini',
            input: 'ping',
            store: false,
            stream: false,
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
      if (response.ok) return { ok: true, status: response.status };
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          error: `auth_failed: ${response.status}`,
        };
      }
      // Some Codex endpoints reject minimal probes with 400 but auth is valid.
      if (response.status === 400) {
        return { ok: true, status: response.status };
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
