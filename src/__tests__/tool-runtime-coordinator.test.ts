import { describe, expect, it, vi } from 'vitest';
import { REGISTERED_TOOLS } from '../tools/registry.js';
import {
  ToolRuntimeCoordinatorError,
  runToolRuntimeCoordinator,
} from '../services/tool-runtime-coordinator.js';
import { withToolSynthesisContext } from '../services/chat-tool-execution.js';

function completion(content: string, providerId = 'planner', model = 'planner-model') {
  return {
    ok: true as const,
    status: 200,
    providerId,
    model,
    body: {
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    },
  };
}

describe('tool runtime coordinator', () => {
  it('builds a normal answer-model request from bounded untrusted tool context', () => {
    const request = withToolSynthesisContext({
      model: 'answer-model',
      messages: [{ role: 'user', content: 'What is current?' }],
      toolRound: { internal: true },
    }, '<tool_result>untrusted current data</tool_result>');

    expect(request).not.toHaveProperty('toolRound');
    expect(request.messages).toEqual([
      { role: 'user', content: 'What is current?' },
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('<tool_result>untrusted current data</tool_result>'),
      }),
    ]);
    expect(request.messages[1]!.content).toContain('untrusted');
  });

  it('pins the first successful provider/model and completes a real tool round', async () => {
    const modelRound = vi.fn()
      .mockResolvedValueOnce({
        ...completion(''),
        body: {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"giá vàng hôm nay"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        },
      })
      .mockResolvedValueOnce(completion('Giá vàng hôm nay là ...'));
    const execute = vi.fn(async () => ({
      content: 'Kết quả giá vàng hiện tại',
      sources: [{ title: 'Nguồn', url: 'https://example.com/gold', snippet: null }],
      truncated: false,
    }));

    const outcome = await runToolRuntimeCoordinator({
      eligibleTools: [REGISTERED_TOOLS[0]!],
      requireToolCall: true,
      modelRound,
      execute,
    });

    expect(outcome.result.body).toEqual(completion('Giá vàng hôm nay là ...').body);
    expect(outcome.pinned).toEqual({ providerId: 'planner', model: 'planner-model' });
    expect(outcome.totalCalls).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(modelRound).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pinned: { providerId: 'planner', model: 'planner-model' },
      toolRound: expect.objectContaining({
        calls: [expect.objectContaining({ id: 'call_1', toolId: 'web_search' })],
        results: [expect.objectContaining({ callId: 'call_1', isError: false })],
      }),
    }));
  });

  it('fails closed if a later model round escapes the pinned route', async () => {
    const modelRound = vi.fn()
      .mockResolvedValueOnce({
        ...completion(''),
        body: { choices: [{ message: { tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"news"}' },
        }] } }] },
      })
      .mockResolvedValueOnce(completion('changed', 'other-provider', 'other-model'));

    await expect(runToolRuntimeCoordinator({
      eligibleTools: [REGISTERED_TOOLS[0]!],
      modelRound,
      execute: async () => ({ content: 'result', sources: [], truncated: false }),
    })).rejects.toMatchObject({ code: 'tool_route_changed' });
  });

  it('reports force requests that complete without invoking an eligible tool', async () => {
    await expect(runToolRuntimeCoordinator({
      eligibleTools: [REGISTERED_TOOLS[0]!],
      requireToolCall: true,
      modelRound: async () => completion('I answered from memory.'),
      execute: async () => ({ content: '', sources: [], truncated: false }),
    })).rejects.toEqual(expect.objectContaining<ToolRuntimeCoordinatorError>({
      code: 'tool_not_used',
    }));
  });

  it('normalizes provider protocol failures instead of leaking an internal error', async () => {
    await expect(runToolRuntimeCoordinator({
      eligibleTools: [REGISTERED_TOOLS[0]!],
      modelRound: async () => ({
        ...completion(''),
        body: {
          choices: [{
            message: {
              tool_calls: [{
                id: 'unknown_call',
                type: 'function',
                function: { name: 'unknown_tool', arguments: '{}' },
              }],
            },
          }],
        },
      }),
      execute: async () => ({ content: '', sources: [], truncated: false }),
    })).rejects.toMatchObject({
      code: 'openai_chat_unknown_tool',
      status: 502,
    });
  });

  it('normalizes a tool that becomes unauthorized during the loop', async () => {
    await expect(runToolRuntimeCoordinator({
      eligibleTools: [REGISTERED_TOOLS[0]!],
      modelRound: async () => ({
        ...completion(''),
        body: {
          choices: [{
            message: {
              tool_calls: [{
                id: 'revoked_call',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"latest"}' },
              }],
            },
          }],
        },
      }),
      reauthorize: async () => false,
      execute: async () => ({ content: '', sources: [], truncated: false }),
    })).rejects.toMatchObject({
      code: 'tool_not_allowed',
      status: 409,
    });
  });
});
