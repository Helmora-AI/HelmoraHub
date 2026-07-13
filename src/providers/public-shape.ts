import type { ProviderToggle } from '../types.js';
import {
  computeCredentialConfigured,
  computeCredentialUsable,
  type OAuthRuntimeState,
  type ProviderAuthMode,
} from '../oauth/credential-flags.js';

export type RuntimeHealth =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'unavailable';

export type VerifyCode =
  | 'auth_failed'
  | 'timeout'
  | 'rate_limited'
  | 'models_unavailable'
  | 'bad_response'
  | 'protocol_not_ready'
  | 'missing_credential'
  | 'upstream_error'
  | null;

/** Hint only — never return full stored credential. */
export function credentialHint(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '••••';
  const prefix = value.slice(0, Math.min(4, value.length));
  const suffix = value.slice(-4);
  return `${prefix}••••${suffix}`;
}

export function classifyVerifyError(message: string | null | undefined): VerifyCode {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes('protocol_not_ready')) return 'protocol_not_ready';
  if (m.includes('apikey required') || m.includes('credential')) return 'missing_credential';
  if (m.includes('401') || m.includes('403') || m.includes('auth') || m.includes('invalid key')) {
    return 'auth_failed';
  }
  if (m.includes('429') || m.includes('rate')) return 'rate_limited';
  if (m.includes('timeout') || m.includes('abort')) return 'timeout';
  if (m.includes('model')) return 'models_unavailable';
  if (m.includes('json') || m.includes('parse') || m.includes('format')) return 'bad_response';
  return 'upstream_error';
}

export function deriveHealth(p: ProviderToggle): RuntimeHealth {
  if (p.oauthState === 'needs_reconnect') return 'invalid_credentials';
  if (p.verifyStatus === 'unsupported') return 'unavailable';
  if (p.verifyStatus === 'never') return 'unknown';
  if (p.verifyStatus === 'ok') return 'healthy';
  const code = classifyVerifyError(p.verifyError);
  if (code === 'auth_failed' || code === 'missing_credential') return 'invalid_credentials';
  if (code === 'rate_limited') return 'rate_limited';
  if (code === 'timeout' || code === 'protocol_not_ready') return 'unavailable';
  return 'degraded';
}

export function toIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Public provider DTO — no secrets. */
export function toPublicProvider(p: ProviderToggle) {
  const authMode: ProviderAuthMode = p.authMode ?? 'none';
  const oauthState: OAuthRuntimeState = p.oauthState ?? 'none';
  const apiKeyConfigured = Boolean(p.apiKey);
  const oauthConnected = authMode === 'oauth' && oauthState !== 'none';
  const credentialConfigured = computeCredentialConfigured({
    authMode,
    apiKeyConfigured,
    oauthConnected,
    oauthState,
  });
  const credentialUsable = computeCredentialUsable({
    authMode,
    apiKeyConfigured,
    oauthConnected,
    oauthState,
  });

  const keyless =
    p.protocol === 'keyless' ||
    p.authStyle === 'none' ||
    (!p.apiKey && p.catalogReady && !p.baseUrl);

  // Hint only for api_key mode — never surface leftover apiKey as oauth token hint.
  const hint =
    authMode === 'api_key' ? credentialHint(p.apiKey) : null;

  // Keyless / none-auth demos stay "configured" for UI even when authMode is none.
  const configuration =
    credentialConfigured || keyless || p.protocol === 'keyless' || p.authStyle === 'none'
      ? ('configured' as const)
      : ('unconfigured' as const);

  return {
    id: p.id,
    label: p.label,
    logoKey: p.id,
    tier: p.tier,
    protocol: p.protocol,
    authStyle: p.authStyle,
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel,
    benchmarkModel: p.benchmarkModel,
    pinnedModels: Array.isArray(p.pinnedModels) ? p.pinnedModels : [],
    capabilities: p.capabilities,
    source: p.source,
    catalogReady: p.catalogReady,
    enabled: p.enabled,
    authMode,
    apiKeyConfigured,
    oauthConnected,
    oauthExpiresAt: null as string | null,
    oauthState,
    credentialConfigured,
    credentialUsable,
    credentialHint: hint,
    configuration,
    health: deriveHealth(p),
    verificationPhase: 'idle' as const,
    verifyStatus: p.verifyStatus,
    verifyCode: classifyVerifyError(p.verifyError),
    verifyError: p.verifyError,
    verifiedAt: toIso(p.verifiedAt),
    timeoutMs: p.timeoutMs,
    allowedModes: p.allowedModes,
  };
}

export type PublicProvider = ReturnType<typeof toPublicProvider>;
