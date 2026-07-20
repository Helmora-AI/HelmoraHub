import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGISTERED_TOOLS } from '../tools/registry.js';
import { nativeToolCapabilityFor } from '../providers/native-tools.js';
import {
  parseAnthropicToolCalls,
  callAnthropicCompatible,
  toAnthropicToolMessages,
  toAnthropicTools,
} from '../providers/adapters/anthropic.js';
import {
  parseGeminiToolCalls,
  callGeminiCompatible,
  toGeminiToolContents,
  toGeminiTools,
} from '../providers/adapters/gemini.js';
import type { ProviderToggle, ProviderProtocol } from '../types.js';

const searchCall = { id: 'call_1', toolId: 'web_search' as const, arguments: { query: 'today' } };
const searchResult = {
  callId: 'call_1',
  toolId: 'web_search' as const,
  content: 'result',
  sources: [],
  truncated: false,
  isError: false,
};

function provider(protocol: ProviderProtocol): ProviderToggle {
  return {
    id: protocol,
    label: protocol,
    enabled: true,
    tier: 1,
    baseUrl: protocol === 'anthropic' ? 'https://anthropic.test/v1' : 'https://gemini.test/v1beta',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    allowedModes: ['smart'],
    capabilities: ['tools'],
    protocol,
    authStyle: protocol === 'anthropic' ? 'x-api-key' : 'query-key',
    benchmarkModel: null,
    pinnedModels: [],
    verifyStatus: 'ok',
    verifyError: null,
    verifiedAt: null,
    source: 'test',
    catalogReady: true,
    extraHeaders: null,
    timeoutMs: null,
    authMode: 'api_key',
    oauthState: 'none',
  };
}

describe('Anthropic and Gemini native tools', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('advertises native support only when the provider declares tools', () => {
    expect(nativeToolCapabilityFor({
      id: 'anthropic', protocol: 'anthropic', authMode: 'api_key', capabilities: ['tools'],
    })).toEqual({ adapter: 'anthropic', streaming: false });
    expect(nativeToolCapabilityFor({
      id: 'gemini', protocol: 'gemini', authMode: 'api_key', capabilities: ['tools'],
    })).toEqual({ adapter: 'gemini', streaming: false });
  });

  it('maps Anthropic tool definitions, calls, and results without trusting arbitrary names', () => {
    expect(toAnthropicTools([REGISTERED_TOOLS[0]!])[0]).toMatchObject({
      name: 'web_search',
      input_schema: expect.objectContaining({ type: 'object' }),
    });
    expect(parseAnthropicToolCalls({
      content: [{ type: 'tool_use', id: 'call_1', name: 'web_search', input: { query: 'today' } }],
    }, [REGISTERED_TOOLS[0]!])).toEqual([searchCall]);
    expect(toAnthropicToolMessages([searchCall], [searchResult])).toEqual([
      { role: 'assistant', content: [expect.objectContaining({ type: 'tool_use', id: 'call_1' })] },
      { role: 'user', content: [expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_1' })] },
    ]);
  });

  it('maps Gemini declarations, function calls, and responses with stable round ids', () => {
    expect(toGeminiTools([REGISTERED_TOOLS[0]!])).toEqual([{
      functionDeclarations: [expect.objectContaining({ name: 'web_search' })],
    }]);
    expect(parseGeminiToolCalls({
      candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { query: 'today' } } }] } }],
    }, [REGISTERED_TOOLS[0]!], 2)).toEqual([{ ...searchCall, id: 'gemini_call_2_0' }]);
    expect(toGeminiToolContents([searchCall], [searchResult])).toEqual([
      { role: 'model', parts: [expect.objectContaining({ functionCall: expect.any(Object) })] },
      { role: 'user', parts: [expect.objectContaining({ functionResponse: expect.any(Object) })] },
    ]);
  });

  it('sends and normalizes Anthropic tool rounds through the provider adapter', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0].name).toBe('web_search');
      expect(body.tool_choice).toEqual({ type: 'any' });
      return new Response(JSON.stringify({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'call_1', name: 'web_search', input: { query: 'today' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 4, output_tokens: 2 },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await callAnthropicCompatible(provider('anthropic'), {
      messages: [{ role: 'user', content: 'search today' }],
      toolRound: { definitions: [REGISTERED_TOOLS[0]!], round: 0, required: true },
    });
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({
      choices: [{ message: { tool_calls: [expect.objectContaining({ id: 'call_1' })] } }],
    });
  });

  it('sends and normalizes Gemini tool rounds through the provider adapter', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0].functionDeclarations[0].name).toBe('web_search');
      expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { query: 'today' } } }] } }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await callGeminiCompatible(provider('gemini'), {
      messages: [{ role: 'user', content: 'search today' }],
      toolRound: { definitions: [REGISTERED_TOOLS[0]!], round: 3, required: true },
    });
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({
      choices: [{ message: { tool_calls: [expect.objectContaining({ id: 'gemini_call_3_0' })] } }],
    });
  });
});
