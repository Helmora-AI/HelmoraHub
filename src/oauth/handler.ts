import type { OAuthTokenBundle } from './types.js';

/** Minimal upstream request shape for applyAuth (expanded in Task 5+). */
export type UpstreamRequest = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export type VerifyResult = {
  ok: boolean;
  error?: string | null;
  status?: number | null;
};

export type OAuthFlow = 'authorization_code_pkce' | 'device_code';

/**
 * Per-provider OAuth integration. Core orchestrates PKCE/start/callback/refresh;
 * handlers own IdP URLs, token exchange, and auth application.
 */
export interface OAuthProviderHandler {
  providerId: string;
  flow: OAuthFlow;
  /** If false, core must not call refresh; near-expiry without refresh → needs_reconnect. */
  supportsRefresh: boolean;

  buildAuthorizeUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): Promise<string>;

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokenBundle>;

  /** Required when supportsRefresh; otherwise may throw typed `refresh_not_supported`. */
  refreshToken?(bundle: OAuthTokenBundle): Promise<OAuthTokenBundle>;

  shouldRefresh(bundle: OAuthTokenBundle, now: number): boolean;

  applyAuth(request: UpstreamRequest, bundle: OAuthTokenBundle): UpstreamRequest;

  verify(bundle: OAuthTokenBundle, signal?: AbortSignal): Promise<VerifyResult>;

  revoke?(bundle: OAuthTokenBundle): Promise<void>;
}
