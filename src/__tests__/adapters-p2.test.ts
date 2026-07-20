import { describe, expect, it, vi, afterEach } from 'vitest';
import { toAnthropicMessages, callAnthropicCompatible } from '../providers/adapters/anthropic.js';
import { toGeminiContents, callGeminiCompatible } from '../providers/adapters/gemini.js';
import {
  parseOpenAIChatToolCalls,
  toOpenAIChatToolMessages,
  toOpenAIChatTools,
} from '../providers/adapters/openai-tools.js';
import {
  callCodexResponses,
  parseResponsesToolCalls,
  toResponsesToolItems,
  toResponsesTools,
} from '../providers/adapters/codex-responses.js';
import { nativeToolCapabilityFor } from '../providers/native-tools.js';
import { dispatchChat } from '../providers/dispatch.js';
import { isChatProtocolReady } from '../providers/catalog/index.js';
import { callOpenAICompatible } from '../services/upstream.js';
import { REGISTERED_TOOLS } from '../tools/registry.js';
import type { ModelToolResult } from '../tools/untrusted-context.js';
import type { ProviderToggle } from '../types.js';

function provider(overrides: Partial<ProviderToggle> = {}): ProviderToggle {
  return {
    id: 'openai',
    label: 'OpenAI',
    enabled: true,
    tier: 1,
    baseUrl: 'https://api.openai.test/v1',
    apiKey: 'sk-test',
    defaultModel: 'gpt-5',
    allowedModes: ['smart'],
    capabilities: ['tools'],
    protocol: 'openai',
    authStyle: 'bearer',
    benchmarkModel: 'gpt-5',
    pinnedModels: [],
    verifyStatus: 'ok',
    verifyError: null,
    verifiedAt: Date.now(),
    source: '9router',
    catalogReady: true,
    extraHeaders: null,
    timeoutMs: null,
    authMode: 'api_key',
    oauthState: 'none',
    ...overrides,
  };
}

const webSearchCall = {
  id: 'call_search_1',
  toolId: 'web_search' as const,
  arguments: { query: 'Helmora latest news' },
};

const webSearchResult: ModelToolResult = {
  callId: webSearchCall.id,
  toolId: webSearchCall.toolId,
  isError: false,
  content: 'A bounded, redacted search result.',
  sources: [],
  truncated: false,
};

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

  it('requires explicit provider capability and selects the matching supported adapter', () => {
    expect(nativeToolCapabilityFor(provider({ capabilities: [] }))).toBeNull();
    expect(nativeToolCapabilityFor(provider({ defaultModel: 'definitely-tools-capable' }))).toEqual({
      adapter: 'openai_chat',
      streaming: false,
    });
    expect(nativeToolCapabilityFor(provider({ protocol: 'anthropic' }))).toEqual({
      adapter: 'anthropic',
      streaming: false,
    });
    expect(nativeToolCapabilityFor(provider({ protocol: 'gemini' }))).toEqual({
      adapter: 'gemini',
      streaming: false,
    });
    expect(nativeToolCapabilityFor(provider({
      id: 'codex',
      protocol: 'oauth',
      authStyle: 'oauth',
      authMode: 'oauth',
    }))).toEqual({ adapter: 'openai_responses', streaming: false });
  });

  it('refuses native tool state when provider metadata does not enable tools', async () => {
    const result = await dispatchChat(provider({ capabilities: [] }), {
      messages: [{ role: 'user', content: 'search it' }],
      toolRound: { definitions: [REGISTERED_TOOLS[0]] },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      error: 'native_tool_calling_unsupported',
    });
  });

  it('translates registered tools into OpenAI Chat function definitions', () => {
    expect(toOpenAIChatTools([REGISTERED_TOOLS[0]])).toEqual([
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: REGISTERED_TOOLS[0].description,
          parameters: REGISTERED_TOOLS[0].inputSchema,
          strict: false,
        },
      },
    ]);
  });

  it('round-trips OpenAI Chat calls and tool results without changing call IDs', () => {
    const parsed = parseOpenAIChatToolCalls({
      choices: [{
        message: {
          tool_calls: [{
            id: webSearchCall.id,
            type: 'function',
            function: { name: webSearchCall.toolId, arguments: JSON.stringify(webSearchCall.arguments) },
          }],
        },
      }],
    }, [REGISTERED_TOOLS[0]]);
    expect(parsed).toEqual([webSearchCall]);

    const messages = toOpenAIChatToolMessages(parsed, [webSearchResult]);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: webSearchCall.id }],
    });
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: webSearchCall.id });
  });

  it('rejects a result whose tool identity does not match its call', () => {
    expect(() => toOpenAIChatToolMessages([webSearchCall], [{
      ...webSearchResult,
      toolId: 'web_fetch',
    }])).toThrowError(expect.objectContaining({ code: 'openai_chat_invalid_tool_result' }));
  });

  it('rejects malformed OpenAI Chat tool arguments', () => {
    expect(() => parseOpenAIChatToolCalls({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_bad',
            type: 'function',
            function: { name: 'web_search', arguments: '{not-json' },
          }],
        },
      }],
    }, [REGISTERED_TOOLS[0]])).toThrowError(expect.objectContaining({
      code: 'openai_chat_invalid_tool_arguments',
    }));
  });

  it('sends Chat tools without leaking Helmora toolRound metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.toolRound).toBeUndefined();
      expect(body.tools[0].function.name).toBe('web_search');
      expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: webSearchCall.id });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'done' } }] }),
      };
    }));

    const result = await callOpenAICompatible(provider(), {
      messages: [{ role: 'user', content: 'search it' }],
      toolRound: {
        definitions: [REGISTERED_TOOLS[0]],
        calls: [webSearchCall],
        results: [webSearchResult],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('maps a required first tool round to OpenAI Chat tool_choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toBe('required');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { tool_calls: [] } }] }),
      };
    }));

    const result = await callOpenAICompatible(provider(), {
      messages: [{ role: 'user', content: 'search it' }],
      toolRound: { definitions: [REGISTERED_TOOLS[0]], required: true },
    });
    expect(result.ok).toBe(true);
  });

  it('uses flat OpenAI Responses definitions and preserves call_id in results', () => {
    expect(toResponsesTools([REGISTERED_TOOLS[0]])).toEqual([
      {
        type: 'function',
        name: 'web_search',
        description: REGISTERED_TOOLS[0].description,
        parameters: REGISTERED_TOOLS[0].inputSchema,
        strict: false,
      },
    ]);
    expect(toResponsesToolItems([webSearchCall], [webSearchResult])).toEqual([
      {
        type: 'function_call',
        call_id: webSearchCall.id,
        name: webSearchCall.toolId,
        arguments: JSON.stringify(webSearchCall.arguments),
      },
      expect.objectContaining({
        type: 'function_call_output',
        call_id: webSearchCall.id,
      }),
    ]);
  });

  it('parses Responses calls and rejects malformed arguments', () => {
    expect(parseResponsesToolCalls({
      output: [{
        type: 'function_call',
        call_id: webSearchCall.id,
        name: webSearchCall.toolId,
        arguments: JSON.stringify(webSearchCall.arguments),
      }],
    }, [REGISTERED_TOOLS[0]])).toEqual([webSearchCall]);

    expect(() => parseResponsesToolCalls({
      output: [{
        type: 'function_call',
        call_id: 'call_bad',
        name: 'web_search',
        arguments: '[]',
      }],
    }, [REGISTERED_TOOLS[0]])).toThrowError(expect.objectContaining({
      code: 'openai_responses_invalid_tool_arguments',
    }));
  });

  it('sends Codex only Responses tool shapes and maps returned calls to Chat format', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.toolRound).toBeUndefined();
      expect(body.tools[0]).toMatchObject({ type: 'function', name: 'web_search' });
      expect(body.tools[0].function).toBeUndefined();
      expect(body.input.at(-1)).toMatchObject({
        type: 'function_call_output',
        call_id: webSearchCall.id,
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: 'resp_1',
          output: [{
            type: 'function_call',
            call_id: 'call_fetch_1',
            name: 'web_fetch',
            arguments: JSON.stringify({ urls: ['https://example.com/'] }),
          }],
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      };
    }));

    const result = await callCodexResponses(provider({
      id: 'codex',
      baseUrl: 'https://chatgpt.test/backend-api/codex/responses',
      protocol: 'oauth',
      authStyle: 'oauth',
      authMode: 'oauth',
    }), {
      messages: [{ role: 'user', content: 'search it' }],
      toolRound: {
        definitions: REGISTERED_TOOLS,
        calls: [webSearchCall],
        results: [webSearchResult],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({
      choices: [{
        message: {
          tool_calls: [{ id: 'call_fetch_1', function: { name: 'web_fetch' } }],
        },
        finish_reason: 'tool_calls',
      }],
    });
  });

  it('maps a required first tool round to Responses tool_choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tool_choice).toBe('required');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'resp_required', output: [] }),
      };
    }));

    const result = await callCodexResponses(provider({
      id: 'codex',
      baseUrl: 'https://chatgpt.test/backend-api/codex/responses',
      protocol: 'oauth',
      authStyle: 'oauth',
      authMode: 'oauth',
    }), {
      messages: [{ role: 'user', content: 'search it' }],
      toolRound: { definitions: REGISTERED_TOOLS, required: true },
    });
    expect(result.ok).toBe(true);
  });
});
