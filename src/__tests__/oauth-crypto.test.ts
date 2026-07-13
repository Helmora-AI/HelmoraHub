import { describe, expect, it } from 'vitest';
import {
  createPkcePair,
  hashOAuthState,
  verifyPkceChallenge,
} from '../oauth/pkce.js';
import {
  decryptOAuthPayload,
  encryptOAuthPayload,
  oauthBundleAad,
} from '../oauth/crypto.js';
import {
  computeCredentialConfigured,
  computeCredentialUsable,
} from '../oauth/credential-flags.js';
import { mapIdpCallbackError, type OAuthCallbackErrorCode } from '../oauth/errors.js';

describe('oauth pkce', () => {
  it('creates S256 challenge that verifies', () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(verifyPkceChallenge(pair.verifier, pair.challenge)).toBe(true);
    expect(verifyPkceChallenge(pair.verifier + 'x', pair.challenge)).toBe(false);
  });

  it('hashes state to stable digest', () => {
    const a = hashOAuthState('abc');
    const b = hashOAuthState('abc');
    const c = hashOAuthState('abd');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });
});

describe('oauth crypto AAD', () => {
  const key = 'test-encryption-key-for-oauth-aad!!';

  it('round-trips with matching AAD', () => {
    const aad = oauthBundleAad('claude', 1);
    const enc = encryptOAuthPayload('{"accessToken":"tok"}', key, aad);
    expect(enc.startsWith('enc:oauth:v1:')).toBe(true);
    expect(decryptOAuthPayload(enc, key, aad)).toBe('{"accessToken":"tok"}');
  });

  it('fails decrypt when providerId AAD mismatches', () => {
    const enc = encryptOAuthPayload('secret', key, oauthBundleAad('claude', 1));
    expect(() =>
      decryptOAuthPayload(enc, key, oauthBundleAad('codex', 1))
    ).toThrow();
  });

  it('fails decrypt when schemaVersion AAD mismatches', () => {
    const enc = encryptOAuthPayload('secret', key, oauthBundleAad('claude', 1));
    expect(() =>
      decryptOAuthPayload(enc, key, oauthBundleAad('claude', 2))
    ).toThrow();
  });
});

describe('credential flags (mode-aware)', () => {
  it('oauth mode ignores leftover api key when not connected', () => {
    expect(
      computeCredentialConfigured({
        authMode: 'oauth',
        apiKeyConfigured: true,
        oauthConnected: false,
      })
    ).toBe(false);
    expect(
      computeCredentialUsable({
        authMode: 'oauth',
        apiKeyConfigured: true,
        oauthConnected: false,
        oauthState: 'none',
      })
    ).toBe(false);
  });

  it('api_key mode uses apiKeyConfigured only', () => {
    expect(
      computeCredentialConfigured({
        authMode: 'api_key',
        apiKeyConfigured: true,
        oauthConnected: false,
      })
    ).toBe(true);
    expect(
      computeCredentialConfigured({
        authMode: 'api_key',
        apiKeyConfigured: false,
        oauthConnected: true,
      })
    ).toBe(false);
  });

  it('oauth usable false when needs_reconnect', () => {
    expect(
      computeCredentialUsable({
        authMode: 'oauth',
        apiKeyConfigured: false,
        oauthConnected: true,
        oauthState: 'needs_reconnect',
      })
    ).toBe(false);
    expect(
      computeCredentialUsable({
        authMode: 'oauth',
        apiKeyConfigured: false,
        oauthConnected: true,
        oauthState: 'connected',
      })
    ).toBe(true);
  });

  it('none mode is never configured', () => {
    expect(
      computeCredentialConfigured({
        authMode: 'none',
        apiKeyConfigured: true,
        oauthConnected: true,
      })
    ).toBe(false);
  });
});

describe('oauth callback error mapping', () => {
  it('maps IdP access_denied', () => {
    expect(mapIdpCallbackError({ error: 'access_denied' })).toBe('access_denied');
  });

  it('maps missing code without error to missing_code', () => {
    expect(mapIdpCallbackError({ code: undefined })).toBe('missing_code');
  });

  it('defaults unknown IdP errors to exchange_failed', () => {
    const code: OAuthCallbackErrorCode = mapIdpCallbackError({ error: 'server_error' });
    expect(code).toBe('exchange_failed');
  });

  it('never returns raw error_description as code', () => {
    const code = mapIdpCallbackError({
      error: 'access_denied',
      error_description: 'User clicked cancel',
    });
    expect(code).toBe('access_denied');
    expect(String(code)).not.toContain('cancel');
  });
});
