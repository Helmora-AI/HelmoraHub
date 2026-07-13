export type HubMode =
  | 'manual'
  | 'smart'
  | 'coding'
  | 'economy'
  | 'premium'
  | 'fusion';

export const HUB_MODES: HubMode[] = [
  'manual',
  'smart',
  'coding',
  'economy',
  'premium',
  'fusion',
];

export type ProviderTier = 1 | 2 | 3;

export type AgentRole =
  | 'coordinator'
  | 'developer'
  | 'analyst'
  | 'scout'
  | 'ops'
  | 'reviewer';

export const DEFAULT_AGENT_ROLES: AgentRole[] = [
  'coordinator',
  'developer',
  'analyst',
  'scout',
  'ops',
  'reviewer',
];

export interface ModeProfile {
  id: HubMode;
  label: string;
  description: string;
  tierOrder: ProviderTier[];
  rtk: boolean;
  autoRoute: boolean;
}

export const MODE_PROFILES: Record<HubMode, ModeProfile> = {
  manual: {
    id: 'manual',
    label: 'Manual',
    description: 'Pin a model; respect toggles only',
    tierOrder: [1, 2, 3],
    rtk: false,
    autoRoute: false,
  },
  smart: {
    id: 'smart',
    label: 'Smart',
    description: 'Best available model in enabled pool',
    tierOrder: [1, 2, 3],
    rtk: true,
    autoRoute: true,
  },
  coding: {
    id: 'coding',
    label: 'Coding',
    description: 'Subscription → paid → free for coding tools',
    tierOrder: [1, 2, 3],
    rtk: true,
    autoRoute: true,
  },
  economy: {
    id: 'economy',
    label: 'Economy',
    description: 'Free tier only',
    tierOrder: [3],
    rtk: true,
    autoRoute: true,
  },
  premium: {
    id: 'premium',
    label: 'Premium',
    description: 'Subscription + paid only',
    tierOrder: [1, 2],
    rtk: true,
    autoRoute: true,
  },
  fusion: {
    id: 'fusion',
    label: 'Fusion',
    description: 'Multi-model panel (Phase 2+)',
    tierOrder: [1, 2],
    rtk: false,
    autoRoute: true,
  },
};

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

export type ProviderAuthStyle =
  | 'bearer'
  | 'x-api-key'
  | 'query-key'
  | 'none'
  | 'account_token'
  | 'oauth'
  | 'cookie';

export type ProviderVerifyStatus = 'never' | 'ok' | 'fail' | 'unsupported';

export type ProviderAuthMode = 'none' | 'api_key' | 'oauth';

export type ProviderOAuthState =
  | 'none'
  | 'connected'
  | 'needs_reconnect'
  | 'verification_pending';

export interface ProviderToggle {
  id: string;
  label: string;
  enabled: boolean;
  tier: ProviderTier;
  baseUrl: string | null;
  apiKey: string | null;
  defaultModel: string | null;
  allowedModes: HubMode[];
  capabilities: string[];
  protocol: ProviderProtocol;
  authStyle: ProviderAuthStyle;
  benchmarkModel: string | null;
  /** User-pinned / manually added model ids for this provider. */
  pinnedModels: string[];
  verifyStatus: ProviderVerifyStatus;
  verifyError: string | null;
  verifiedAt: number | null;
  source: string;
  catalogReady: boolean;
  extraHeaders: Record<string, string> | null;
  timeoutMs: number | null;
  /** Active credential mode (api_key paste vs oauth vault). */
  authMode: ProviderAuthMode;
  /** OAuth runtime state when authMode is oauth (or after disconnect → none). */
  oauthState: ProviderOAuthState;
}

export interface AgentConfig {
  id: AgentRole;
  nickname: string;
  enabled: boolean;
  model: string;
  mode: HubMode;
  deskId: string | null;
}

export interface HubSettings {
  activeMode: HubMode;
  apiKey: string;
}
