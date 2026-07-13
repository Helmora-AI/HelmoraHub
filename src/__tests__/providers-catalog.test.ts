import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CATALOG, isChatProtocolReady } from '../providers/catalog/index.js';
import { verifyProvider } from '../providers/verify.js';
import type { ProviderToggle } from '../types.js';

function baseProvider(over: Partial<ProviderToggle> = {}): ProviderToggle {
  return {
    id: 'groq',
    label: 'Groq',
    enabled: false,
    tier: 3,
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'gsk-test',
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
    ...over,
  };
}

describe('provider catalog', () => {
  it('seeds FreeLLMAPI + 9Router + builtins', () => {
    expect(PROVIDER_CATALOG.length).toBeGreaterThan(90);
    expect(PROVIDER_CATALOG.some((e) => e.id === 'groq')).toBe(true);
    expect(PROVIDER_CATALOG.some((e) => e.id === 'openrouter')).toBe(true);
    expect(PROVIDER_CATALOG.some((e) => e.id === 'paid-upstream')).toBe(true);
    const oauthish = PROVIDER_CATALOG.filter(
      (e) => e.protocol === 'oauth' || e.protocol === 'cookie'
    );
    expect(oauthish.length).toBeGreaterThan(0);
    expect(oauthish.every((e) => !e.catalogReady || e.protocol !== 'openai')).toBe(true);
  });

  it('includes aimlapi as ready OpenAI provider (default T3)', () => {
    const aiml = PROVIDER_CATALOG.find((e) => e.id === 'aimlapi');
    expect(aiml).toBeTruthy();
    expect(aiml?.catalogReady).toBe(true);
    expect(aiml?.protocol).toBe('openai');
    expect(aiml?.tier).toBe(3);
    expect(aiml?.baseUrl).toContain('aimlapi.com');
  });

  it('includes modelscope and kiraai as ready T3 OpenAI providers', () => {
    const ms = PROVIDER_CATALOG.find((e) => e.id === 'modelscope');
    expect(ms?.catalogReady).toBe(true);
    expect(ms?.baseUrl).toContain('modelscope.cn');
    expect(ms?.tier).toBe(3);

    const kira = PROVIDER_CATALOG.find((e) => e.id === 'kiraai');
    expect(kira?.catalogReady).toBe(true);
    expect(kira?.baseUrl).toBe('https://kiraai.vn/api/v1');
    expect(kira?.defaultModel).toBe('kira-3.5-pro');
    expect(kira?.tier).toBe(3);
  });

  it('marks openai/keyless/custom ready for chat', () => {
    expect(isChatProtocolReady('openai', true)).toBe(true);
    expect(isChatProtocolReady('keyless', true)).toBe(true);
    expect(isChatProtocolReady('oauth', false)).toBe(false);
    expect(isChatProtocolReady('openai', false)).toBe(false);
  });

  it('marks kimchi as ready oauth token-paste (stubs stay off)', () => {
    const kimchi = PROVIDER_CATALOG.find((e) => e.id === 'kimchi');
    expect(kimchi?.catalogReady).toBe(true);
    expect(kimchi?.protocol).toBe('oauth');
    expect(kimchi?.baseUrl).toContain('kimchi.dev');
    expect(isChatProtocolReady('oauth', true)).toBe(true);

    const cursor = PROVIDER_CATALOG.find((e) => e.id === 'cursor');
    expect(cursor?.protocol).toBe('oauth');
    expect(cursor?.catalogReady).toBe(false);
    expect(isChatProtocolReady('oauth', false)).toBe(false);
  });

  it('marks OpenAI-compat oauth token-paste providers ready', () => {
    const readyOauth = [
      'kimchi',
      'iflow',
      'xai',
      'qwen',
      'kilocode',
      'cline',
      'clinepass',
      'kimi-coding',
    ];
    for (const id of readyOauth) {
      const e = PROVIDER_CATALOG.find((x) => x.id === id);
      expect(e?.protocol).toBe('oauth');
      expect(e?.catalogReady).toBe(true);
      expect(e?.baseUrl).toBeTruthy();
    }
    const stillStub = ['cursor', 'gemini-cli', 'kiro'];
    for (const id of stillStub) {
      expect(PROVIDER_CATALOG.find((x) => x.id === id)?.catalogReady).toBe(false);
    }
    expect(PROVIDER_CATALOG.find((x) => x.id === 'claude')?.catalogReady).toBe(true);
    expect(PROVIDER_CATALOG.find((x) => x.id === 'codex')?.catalogReady).toBe(true);
  });

  it('marks claude and codex Ready (OAuth PKCE handlers)', () => {
    const claude = PROVIDER_CATALOG.find((e) => e.id === 'claude');
    expect(claude?.catalogReady).toBe(true);
    expect(claude?.protocol).toBe('oauth');
    expect(isChatProtocolReady('oauth', true)).toBe(true);

    const codex = PROVIDER_CATALOG.find((e) => e.id === 'codex');
    expect(codex?.catalogReady).toBe(true);
    expect(codex?.protocol).toBe('oauth');
  });
});

describe('verifyProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns unsupported for oauth stubs', async () => {
    const result = await verifyProvider(
      baseProvider({
        id: 'claude',
        protocol: 'oauth',
        catalogReady: false,
        baseUrl: 'https://api.anthropic.com',
      })
    );
    expect(result.ok).toBe(false);
    expect(result.verifyStatus).toBe('unsupported');
    expect(result.verifyError).toMatch(/protocol_not_ready/);
    expect(result.enabled).toBe(false);
  });

  it('verifies ready oauth (kimchi) via OpenAI-compat bearer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: 'pong' } }],
          }),
      }))
    );
    const result = await verifyProvider(
      baseProvider({
        id: 'kimchi',
        protocol: 'oauth',
        authStyle: 'oauth',
        catalogReady: true,
        baseUrl: 'https://llm.kimchi.dev/openai/v1',
        defaultModel: 'minimax-m3',
        benchmarkModel: 'minimax-m3',
        apiKey: 'access-token-paste',
      })
    );
    expect(result.ok).toBe(true);
    expect(result.verifyStatus).toBe('ok');
    expect(result.enabled).toBe(true);
  });

  it('marks ok when upstream returns 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: 'pong' } }],
          }),
      }))
    );
    const result = await verifyProvider(baseProvider());
    expect(result.ok).toBe(true);
    expect(result.verifyStatus).toBe('ok');
    expect(result.enabled).toBe(true);
  });

  it('marks fail on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'invalid key' } }),
      }))
    );
    const result = await verifyProvider(baseProvider());
    expect(result.ok).toBe(false);
    expect(result.verifyStatus).toBe('fail');
    expect(result.verifyError).toMatch(/401/);
    expect(result.enabled).toBe(false);
  });
});
