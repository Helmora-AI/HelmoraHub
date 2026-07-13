import type { ProviderAuthMode, OAuthRuntimeState } from './credential-flags.js';

export type OAuthTokenBundle = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  tokenType?: string;
  /** Allowlisted non-secret hints only — never raw token JSON. */
  meta?: Record<string, unknown>;
  schemaVersion: number;
};

export type OAuthProviderConfig = {
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  audience?: string;
};

export type { ProviderAuthMode, OAuthRuntimeState };
