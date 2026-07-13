import type { OAuthProviderConfig } from '../types.js';

const DEFAULT_CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Static Claude OAuth config (encapsulated; env overrides for client id/secret). */
export function getClaudeOAuthConfig(): OAuthProviderConfig & {
  codeChallengeMethod: string;
  refreshLeadMs: number;
} {
  return {
    clientId:
      process.env.HELMORA_OAUTH_CLAUDE_CLIENT_ID?.trim() || DEFAULT_CLAUDE_CLIENT_ID,
    clientSecret: process.env.HELMORA_OAUTH_CLAUDE_CLIENT_SECRET?.trim() || undefined,
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
    scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
    codeChallengeMethod: 'S256',
    /** ~5 min lead before expiry for refresh-before-call. */
    refreshLeadMs: 5 * 60 * 1000,
  };
}

/** Beta header required for Claude Code OAuth inference. */
export const CLAUDE_OAUTH_BETA =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';

export const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
