import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CATALOG, isChatProtocolReady } from '../providers/catalog/index.js';
import { codexOAuthHandler } from '../oauth/handlers/codex.js';
import { getCodexOAuthConfig } from '../oauth/handlers/codex-config.js';
import { callCodexResponses, toResponsesInput } from '../providers/adapters/codex-responses.js';
import type { ProviderToggle } from '../types.js';

function codexProvider(over: Partial<ProviderToggle> = {}): ProviderToggle {
  return {
    id: 'codex',
    label: 'OpenAI Codex',
    enabled: true,
    tier: 1,
    baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
    apiKey: 'codex-access',
    defaultModel: 'gpt-5.6-sol',
    allowedModes: ['manual', 'smart', 'coding', 'premium', 'fusion'],
    capabilities: ['streaming', 'tools'],
    protocol: 'oauth',
    authStyle: 'oauth',
    benchmarkModel: 'gpt-5.6-sol',
    pinnedModels: [],
    verifyStatus: 'ok',
    verifyError: null,
    verifiedAt: Date.now(),
    source: '9router',
    catalogReady: true,
    extraHeaders: null,
    timeoutMs: null,
    authMode: 'oauth',
    oauthState: 'connected',
    ...over,
  };
}

describe('Codex OAuth handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('catalogReady is true', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.id === 'codex');
    expect(entry?.catalogReady).toBe(true);
    expect(isChatProtocolReady('oauth', true)).toBe(true);
  });

  it('buildAuthorizeUrl encodes scope with %20', async () => {
    const url = await codexOAuthHandler.buildAuthorizeUrl({
      state: 'st',
      codeChallenge: 'chal',
      redirectUri: 'http://hub.test/api/oauth/callback',
    });
    expect(url).toContain(getCodexOAuthConfig().authorizeUrl);
    expect(url).toContain('code_challenge=chal');
    expect(url).toContain('openid%20profile');
    expect(url).toContain('originator=codex_cli_rs');
  });

  it('exchangeCode uses form-urlencoded (mock fetch)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.headers && (init.headers as Record<string, string>)['Content-Type'])).toContain(
        'application/x-www-form-urlencoded'
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'cx-at',
          refresh_token: 'cx-rt',
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const bundle = await codexOAuthHandler.exchangeCode({
      code: 'c1',
      codeVerifier: 'ver',
      redirectUri: 'http://hub.test/api/oauth/callback',
    });
    expect(bundle.accessToken).toBe('cx-at');
    expect(bundle.refreshToken).toBe('cx-rt');
  });

  it('shouldRefresh near expiry (~5 min)', () => {
    const now = Date.now();
    expect(
      codexOAuthHandler.shouldRefresh(
        { accessToken: 'x', schemaVersion: 1, expiresAt: now + 30_000 },
        now
      )
    ).toBe(true);
    expect(
      codexOAuthHandler.shouldRefresh(
        { accessToken: 'x', schemaVersion: 1, expiresAt: now + 600_000 },
        now
      )
    ).toBe(false);
  });

  it('verify hits responses with Bearer', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer cx-tok');
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await codexOAuthHandler.verify({
      accessToken: 'cx-tok',
      schemaVersion: 1,
    });
    expect(result.ok).toBe(true);
  });
});

describe('Codex Responses adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('toResponsesInput maps system + user', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(instructions).toBe('Be brief');
    expect(input).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('callCodexResponses maps output to chat completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'pong' }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
      }))
    );

    const result = await callCodexResponses(codexProvider(), {
      messages: [{ role: 'user', content: 'ping' }],
      model: 'gpt-5.6-sol',
    });
    expect(result.ok).toBe(true);
    const body = result.body as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe('pong');
    expect(body.usage.prompt_tokens).toBe(2);
  });
});
