import type { OAuthProviderConfig } from '../types.js';

const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Static Codex OAuth config (encapsulated; env overrides for client id/secret). */
export function getCodexOAuthConfig(): OAuthProviderConfig & {
  codeChallengeMethod: string;
  refreshLeadMs: number;
  scope: string;
  extraParams: Record<string, string>;
} {
  return {
    clientId:
      process.env.HELMORA_OAUTH_CODEX_CLIENT_ID?.trim() || DEFAULT_CODEX_CLIENT_ID,
    clientSecret: process.env.HELMORA_OAUTH_CODEX_CLIENT_SECRET?.trim() || undefined,
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    scope: 'openid profile email offline_access',
    codeChallengeMethod: 'S256',
    extraParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
    /** ~5 min lead before expiry for refresh-before-call. */
    refreshLeadMs: 5 * 60 * 1000,
  };
}

export const CODEX_DEFAULT_BASE_URL =
  'https://chatgpt.com/backend-api/codex/responses';
