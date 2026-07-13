import type { HubMode, ProviderTier } from '../types.js';

export type ProviderProtocol =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'oauth'
  | 'cookie'
  | 'keyless'
  | 'media'
  | 'local'
  | 'custom';

export type AuthStyle =
  | 'bearer'
  | 'x-api-key'
  | 'query-key'
  | 'none'
  | 'account_token'
  | 'oauth'
  | 'cookie';

export type VerifyStatus = 'never' | 'ok' | 'fail' | 'unsupported';

export type CatalogSource = 'freellmapi' | '9router' | 'both' | 'builtin';

export interface CatalogEntry {
  id: string;
  label: string;
  tier: ProviderTier;
  protocol: ProviderProtocol;
  authStyle: AuthStyle;
  baseUrl: string | null;
  defaultModel: string | null;
  capabilities: string[];
  /** If omitted, derived from tier in catalog helpers */
  allowedModes?: HubMode[];
  source: CatalogSource;
  catalogReady: boolean;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  keyless?: boolean;
}
