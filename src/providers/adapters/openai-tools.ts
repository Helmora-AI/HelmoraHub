import type { ChatMessage } from '../../services/upstream.js';
import type { ProposedToolCall } from '../../services/tool-loop.js';
import type { RegisteredTool } from '../../tools/types.js';
import type { ModelToolResult } from '../../tools/untrusted-context.js';
import {
  ProviderToolProtocolError,
  assertCallId,
  assertKnownTool,
  pairToolResults,
  parseToolArguments,
  serializeModelToolResult,
} from '../native-tools.js';

export type OpenAIChatToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: false;
  };
};

export type OpenAIChatToolMessage = ChatMessage & {
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export function toOpenAIChatTools(
  definitions: readonly RegisteredTool[],
): OpenAIChatToolDefinition[] {
  return definitions.map((tool) => ({
    type: 'function',
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
      // Helmora schemas intentionally contain optional properties. OpenAI
      // strict mode would require every property to be listed in `required`.
      strict: false,
    },
  }));
}

export function toOpenAIChatToolMessages(
  calls: readonly ProposedToolCall[],
  results: readonly ModelToolResult[],
): OpenAIChatToolMessage[] {
  const pairs = pairToolResults('openai_chat', calls, results);
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.toolId, arguments: JSON.stringify(call.arguments) },
      })),
    },
    ...pairs.map(({ call, result }) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: serializeModelToolResult(result),
    })),
  ];
}

export function parseOpenAIChatToolCalls(
  body: unknown,
  definitions: readonly RegisteredTool[],
): ProposedToolCall[] {
  if (!body || typeof body !== 'object') return [];
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const first = choices[0];
  if (!first || typeof first !== 'object') return [];
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return [];
  const rawCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (rawCalls === undefined) return [];
  if (!Array.isArray(rawCalls)) {
    throw new ProviderToolProtocolError('openai_chat_invalid_tool_call', 'Tool calls must be an array.');
  }
  const seen = new Set<string>();
  return rawCalls.map((raw): ProposedToolCall => {
    if (!raw || typeof raw !== 'object') {
      throw new ProviderToolProtocolError('openai_chat_invalid_tool_call', 'Tool call must be an object.');
    }
    const call = raw as { id?: unknown; type?: unknown; function?: unknown };
    if (call.type !== 'function' || !call.function || typeof call.function !== 'object') {
      throw new ProviderToolProtocolError('openai_chat_invalid_tool_call', 'Only function tool calls are supported.');
    }
    const fn = call.function as { name?: unknown; arguments?: unknown };
    return {
      id: assertCallId({ protocol: 'openai_chat', value: call.id, seen }),
      toolId: assertKnownTool({ protocol: 'openai_chat', name: fn.name, definitions }),
      arguments: parseToolArguments({ protocol: 'openai_chat', value: fn.arguments }),
    };
  });
}
