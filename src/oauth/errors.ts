export type OAuthCallbackErrorCode =
  | 'access_denied'
  | 'invalid_state'
  | 'expired_state'
  | 'missing_code'
  | 'exchange_failed'
  | 'persist_failed'
  | 'provider_not_supported';

export type IdpCallbackQuery = {
  error?: string | null;
  error_description?: string | null;
  code?: string | null;
  state?: string | null;
};

/**
 * Map IdP / local callback conditions to a safe SPA enum.
 * Never returns error_description or raw provider strings.
 */
export function mapIdpCallbackError(query: IdpCallbackQuery): OAuthCallbackErrorCode {
  const err = (query.error ?? '').trim().toLowerCase();
  if (err === 'access_denied') return 'access_denied';
  if (err) return 'exchange_failed';
  if (!query.code?.trim()) return 'missing_code';
  return 'exchange_failed';
}

export function buildFrontendOAuthRedirect(
  frontendOrigin: string,
  opts:
    | { ok: true; providerId: string }
    | { ok: false; providerId: string; code: OAuthCallbackErrorCode }
): string {
  const base = frontendOrigin.replace(/\/$/, '');
  const path = '/providers';
  if (opts.ok) {
    return `${base}${path}?oauth=ok&provider=${encodeURIComponent(opts.providerId)}`;
  }
  return `${base}${path}?oauth=error&provider=${encodeURIComponent(opts.providerId)}&code=${encodeURIComponent(opts.code)}`;
}
