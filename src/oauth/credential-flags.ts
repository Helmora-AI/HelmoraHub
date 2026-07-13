export type ProviderAuthMode = 'none' | 'api_key' | 'oauth';

export type OAuthRuntimeState =
  | 'none'
  | 'connected'
  | 'needs_reconnect'
  | 'verification_pending';

export type CredentialFlagInput = {
  authMode: ProviderAuthMode;
  apiKeyConfigured: boolean;
  oauthConnected: boolean;
  oauthState?: OAuthRuntimeState;
};

/** True only if the *active* authMode has its credential present. */
export function computeCredentialConfigured(input: CredentialFlagInput): boolean {
  if (input.authMode === 'api_key') return input.apiKeyConfigured;
  if (input.authMode === 'oauth') return input.oauthConnected;
  return false;
}

/** Configured for mode and not hard-blocked for oauth reconnect. */
export function computeCredentialUsable(input: CredentialFlagInput): boolean {
  if (input.authMode === 'api_key') return input.apiKeyConfigured;
  if (input.authMode === 'oauth') {
    return (
      input.oauthConnected && (input.oauthState ?? 'none') !== 'needs_reconnect'
    );
  }
  return false;
}
