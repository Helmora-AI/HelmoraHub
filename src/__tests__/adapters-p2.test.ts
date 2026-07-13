import { describe, expect, it, vi, afterEach } from 'vitest';
import { toAnthropicMessages, callAnthropicCompatible } from '../providers/adapters/anthropic.js';
import { toGeminiContents, callGeminiCompatible } from '../providers/adapters/gemini.js';
import { isChatProtocolReady } from '../providers/catalog/index.js';
import type { ProviderToggle } from '../types.js';

describe('P2 adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('marks anthropic and gemini protocols ready', () => {
    expect(isChatProtocolReady('anthropic', true)).toBe(true);
    expect(isChatProtocolReady('gemini', true)).toBe(true);
  });

  it('converts OpenAI messages to Anthropic shape', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'ping' },
    ]);
    expect(system).toBe('Be brief');
    expect(messages[0].role).toBe('user');
    expect(messages.at(-1)?.content).toBe('ping');
  });

  it('converts OpenAI messages to Gemini contents', () => {
    const { systemInstruction, contents } = toGeminiContents([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(systemInstruction?.parts[0].text).toBe('sys');
    expect(contents[0].role).toBe('user');
  });

  it('calls Anthropic messages API and maps to OpenAI body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.max_tokens).toBeGreaterThan(0);
        expect(body.messages[0].role).toBe('user');
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 'msg_1',
              content: [{ type: 'text', text: 'pong' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 3, output_tokens: 1 },
            }),
        };
      })
    );

    const provider: ProviderToggle = {
      id: 'anthropic',
      label: 'Anthropic',
      enabled: true,
      tier: 2,
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      defaultModel: 'claude-sonnet-4-20250514',
      allowedModes: ['smart'],
      capabilities: ['tools'],
      protocol: 'anthropic',
      authStyle: 'x-api-key',
      benchmarkModel: 'claude-sonnet-4-20250514',
      pinnedModels: [],
      verifyStatus: 'ok',
      verifyError: null,
      verifiedAt: Date.now(),
      source: '9router',
      catalogReady: true,
      extraHeaders: null,
      timeoutMs: null,
    };

    const result = await callAnthropicCompatible(provider, {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
    });
    expect(result.ok).toBe(true);
    expect((result.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe(
      'pong'
    );
  });

  it('calls Gemini generateContent and maps to OpenAI body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(String(url)).toContain('generateContent');
        expect(String(url)).toContain('key=');
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'hi' }] } }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
            }),
        };
      })
    );

    const provider: ProviderToggle = {
      id: 'google',
      label: 'Google',
      enabled: true,
      tier: 3,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIza-test',
      defaultModel: 'gemini-2.5-flash',
      allowedModes: ['economy'],
      capabilities: ['tools'],
      protocol: 'gemini',
      authStyle: 'query-key',
      benchmarkModel: 'gemini-2.5-flash',
      pinnedModels: [],
      verifyStatus: 'ok',
      verifyError: null,
      verifiedAt: Date.now(),
      source: 'freellmapi',
      catalogReady: true,
      extraHeaders: null,
      timeoutMs: 60_000,
    };

    const result = await callGeminiCompatible(provider, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(result.ok).toBe(true);
    expect((result.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe(
      'hi'
    );
  });
});
