import { describe, expect, it } from 'vitest';
import { toPublicProvider, deriveHealth } from '../providers/public-shape.js';
import type { ProviderToggle } from '../types.js';

function base(over: Partial<ProviderToggle> = {}): ProviderToggle {
  return {
    id: 'groq',
    label: 'Groq',
    enabled: false,
    tier: 3,
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: null,
    defaultModel: 'llama-3.3-70b-versatile',
    allowedModes: ['manual', 'smart', 'coding', 'economy'],
    capabilities: ['tools', 'streaming'],
    protocol: 'openai',
    authStyle: 'bearer',
    benchmarkModel: 'llama-3.3-70b-versatile',
    pinnedModels: [],
    verifyStatus: 'never',
    verifyError: null,
    verifiedAt: null,
    source: 'both',
    catalogReady: true,
    extraHeaders: null,
    timeoutMs: null,
    authMode: 'none',
    oauthState: 'none',
    ...over,
  };
}

describe('toPublicProvider OAuth DTO flags', () => {
  it('exposes mode-aware credential flags for api_key', () => {
    const dto = toPublicProvider(
      base({ authMode: 'api_key', apiKey: 'sk-test-abcdefgh', oauthState: 'none' })
    );
    expect(dto.authMode).toBe('api_key');
    expect(dto.apiKeyConfigured).toBe(true);
    expect(dto.oauthConnected).toBe(false);
    expect(dto.oauthState).toBe('none');
    expect(dto.oauthExpiresAt).toBeNull();
    expect(dto.credentialConfigured).toBe(true);
    expect(dto.credentialUsable).toBe(true);
    expect(dto.configuration).toBe('configured');
    expect(dto.credentialHint).toMatch(/sk-t••••efgh/);
  });

  it('oauth connected: configured + usable; no apiKey hint', () => {
    const dto = toPublicProvider(
      base({
        id: 'claude',
        protocol: 'oauth',
        authStyle: 'oauth',
        authMode: 'oauth',
        oauthState: 'connected',
        apiKey: 'leftover-should-not-hint',
      })
    );
    expect(dto.oauthConnected).toBe(true);
    expect(dto.credentialConfigured).toBe(true);
    expect(dto.credentialUsable).toBe(true);
    expect(dto.credentialHint).toBeNull();
    expect(dto.apiKeyConfigured).toBe(true);
  });

  it('oauth + leftover apiKey but disconnected → not configured', () => {
    const dto = toPublicProvider(
      base({
        id: 'claude',
        protocol: 'oauth',
        authMode: 'oauth',
        oauthState: 'none',
        apiKey: 'legacy-key',
      })
    );
    expect(dto.oauthConnected).toBe(false);
    expect(dto.credentialConfigured).toBe(false);
    expect(dto.credentialUsable).toBe(false);
    expect(dto.credentialHint).toBeNull();
  });

  it('needs_reconnect → credentialUsable false + invalid_credentials health', () => {
    const p = base({
      authMode: 'oauth',
      oauthState: 'needs_reconnect',
      verifyStatus: 'fail',
      verifyError: 'token expired',
    });
    const dto = toPublicProvider(p);
    expect(dto.oauthConnected).toBe(true);
    expect(dto.credentialConfigured).toBe(true);
    expect(dto.credentialUsable).toBe(false);
    expect(dto.health).toBe('invalid_credentials');
    expect(deriveHealth(p)).toBe('invalid_credentials');
  });

  it('verification_pending is connected for flags but not needs_reconnect', () => {
    const dto = toPublicProvider(
      base({
        authMode: 'oauth',
        oauthState: 'verification_pending',
      })
    );
    expect(dto.oauthConnected).toBe(true);
    expect(dto.credentialConfigured).toBe(true);
    expect(dto.credentialUsable).toBe(true);
  });
});
