import type { ProviderToggle } from '../../types.js';
import type {
  ChatMessage,
  ChatRequest,
  UpstreamResult,
  UpstreamStreamResult,
} from '../../services/upstream.js';
import { CODEX_DEFAULT_BASE_URL } from '../../oauth/handlers/codex-config.js';
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

type ResponsesMessageInput = { role: 'user' | 'assistant'; content: string };
type ResponsesFunctionCall = {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
};
type ResponsesFunctionOutput = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};
type ResponsesInputItem = ResponsesMessageInput | ResponsesFunctionCall | ResponsesFunctionOutput;

export type ResponsesToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
};

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    try {
      return content == null ? '' : JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const p = part as { type?: string; text?: string };
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      return typeof (part as { text?: string }).text === 'string'
        ? (part as { text: string }).text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** OpenAI chat messages → Responses API input + optional instructions. */
export function toResponsesInput(messages: ChatMessage[]): {
  instructions?: string;
  input: ResponsesMessageInput[] | string;
} {
  const systemParts: string[] = [];
  const input: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const m of messages) {
    const text = textFromContent(m.content);
    if (m.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    input.push({ role, content: text || ' ' });
  }

  if (input.length === 0) {
    return {
      instructions: systemParts.length ? systemParts.join('\n\n') : undefined,
      input: 'ping',
    };
  }

  return {
    instructions: systemParts.length ? systemParts.join('\n\n') : undefined,
    input,
  };
}

export function toResponsesTools(
  definitions: readonly RegisteredTool[],
): ResponsesToolDefinition[] {
  return definitions.map((tool) => ({
    type: 'function',
    name: tool.id,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

export function toResponsesToolItems(
  calls: readonly ProposedToolCall[],
  results: readonly ModelToolResult[],
): ResponsesInputItem[] {
  const pairs = pairToolResults('openai_responses', calls, results);
  return [
    ...calls.map((call): ResponsesFunctionCall => ({
      type: 'function_call',
      call_id: call.id,
      name: call.toolId,
      arguments: JSON.stringify(call.arguments),
    })),
    ...pairs.map(({ call, result }): ResponsesFunctionOutput => ({
      type: 'function_call_output',
      call_id: call.id,
      output: serializeModelToolResult(result),
    })),
  ];
}

export function parseResponsesToolCalls(
  body: unknown,
  definitions: readonly RegisteredTool[],
): ProposedToolCall[] {
  if (!body || typeof body !== 'object') return [];
  const output = (body as { output?: unknown }).output;
  if (output === undefined) return [];
  if (!Array.isArray(output)) {
    throw new ProviderToolProtocolError('openai_responses_invalid_tool_call', 'Responses output must be an array.');
  }
  const seen = new Set<string>();
  return output.flatMap((raw): ProposedToolCall[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
    if (item.type !== 'function_call') return [];
    return [{
      id: assertCallId({ protocol: 'openai_responses', value: item.call_id, seen }),
      toolId: assertKnownTool({ protocol: 'openai_responses', name: item.name, definitions }),
      arguments: parseToolArguments({ protocol: 'openai_responses', value: item.arguments }),
    }];
  });
}

function extractOutputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === 'string') return body.output_text;
  const output = body.output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const it = item as {
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
      text?: string;
    };
    if (typeof it.text === 'string') parts.push(it.text);
    if (Array.isArray(it.content)) {
      for (const c of it.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
        else if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('');
}

function toOpenAIBody(
  providerId: string,
  model: string,
  body: Record<string, unknown>,
  definitions: readonly RegisteredTool[] = [],
): unknown {
  const text = extractOutputText(body);
  const calls = definitions.length > 0 ? parseResponsesToolCalls(body, definitions) : [];
  const usage = (body.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  return {
    id: typeof body.id === 'string' ? body.id : `chatcmpl-${providerId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || (calls.length > 0 ? null : ''),
          ...(calls.length > 0 ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.toolId, arguments: JSON.stringify(call.arguments) },
            })),
          } : {}),
        },
        finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens:
        usage.total_tokens ??
        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

function codexHeaders(provider: ProviderToggle): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
    originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.136.0',
    ...(provider.extraHeaders ?? {}),
  };
}

function responsesUrl(provider: ProviderToggle): string {
  return (provider.baseUrl || CODEX_DEFAULT_BASE_URL).replace(/\/$/, '');
}

/**
 * Minimal OpenAI Responses API → Hub chat completion (non-stream required).
 */
export async function callCodexResponses(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamResult> {
  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? 'gpt-5.6-sol';

  if (!provider.apiKey) {
    return {
      ok: false,
      status: 401,
      providerId: provider.id,
      model,
      body: null,
      error: 'apiKey required',
    };
  }

  const { instructions, input: baseInput } = toResponsesInput(request.messages);
  const toolRound = request.toolRound;
  let input: ResponsesInputItem[] | string = baseInput;
  if (toolRound?.calls?.length) {
    if (!toolRound.results) {
      return {
        ok: false,
        status: 400,
        providerId: provider.id,
        model,
        body: null,
        error: 'openai_responses_invalid_tool_result',
      };
    }
    const messages: ResponsesInputItem[] = typeof baseInput === 'string'
      ? [{ role: 'user', content: baseInput }]
      : [...baseInput];
    try {
      messages.push(...toResponsesToolItems(toolRound.calls, toolRound.results));
    } catch (error) {
      if (error instanceof ProviderToolProtocolError) {
        return {
          ok: false,
          status: 400,
          providerId: provider.id,
          model,
          body: null,
          error: error.code,
        };
      }
      throw error;
    }
    input = messages;
  } else if (toolRound?.results?.length) {
    return {
      ok: false,
      status: 400,
      providerId: provider.id,
      model,
      body: null,
      error: 'openai_responses_invalid_tool_result',
    };
  }
  const url = responsesUrl(provider);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: codexHeaders(provider),
      body: JSON.stringify({
        model,
        input,
        ...(toolRound ? { tools: toResponsesTools(toolRound.definitions) } : {}),
        ...(toolRound?.required ? { tool_choice: 'required' } : {}),
        ...(instructions ? { instructions } : {}),
        store: false,
        stream: false,
        ...(typeof request.max_tokens === 'number' && request.max_tokens > 0
          ? { max_output_tokens: request.max_tokens }
          : {}),
        ...(typeof request.temperature === 'number'
          ? { temperature: request.temperature }
          : {}),
      }),
      signal,
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        providerId: provider.id,
        model,
        body,
        error:
          typeof body === 'object' && body && 'error' in body
            ? JSON.stringify((body as { error: unknown }).error)
            : `Codex ${response.status}`,
      };
    }

    try {
      return {
        ok: true,
        status: 200,
        providerId: provider.id,
        model,
        body: toOpenAIBody(
          provider.id,
          model,
          (body ?? {}) as Record<string, unknown>,
          toolRound?.definitions,
        ),
      };
    } catch (error) {
      if (error instanceof ProviderToolProtocolError) {
        return {
          ok: false,
          status: 502,
          providerId: provider.id,
          model,
          body: null,
          error: error.code,
        };
      }
      throw error;
    }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      providerId: provider.id,
      model,
      body: null,
      error: err instanceof ProviderToolProtocolError
        ? err.code
        : err instanceof Error ? err.message : String(err),
    };
  }
}

/** Stream nice-to-have: synthesize chunks from non-stream response. */
export async function callCodexResponsesStream(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamStreamResult> {
  if (request.toolRound) {
    return {
      ok: false,
      status: 503,
      providerId: provider.id,
      model: request.model ?? provider.defaultModel ?? 'unknown',
      body: null,
      error: 'native_tool_streaming_unsupported',
    };
  }
  const result = await callCodexResponses(provider, request, signal);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      providerId: result.providerId,
      model: result.model,
      body: result.body,
      error: result.error,
    };
  }

  const content =
    typeof result.body === 'object' &&
    result.body &&
    'choices' in result.body &&
    Array.isArray((result.body as { choices: unknown[] }).choices)
      ? (
          (result.body as { choices: Array<{ message?: { content?: string } }> }).choices[0]
            ?.message?.content ?? ''
        )
      : '';

  async function* chunks(): AsyncGenerator<Record<string, unknown>, void, unknown> {
    yield {
      id: `chatcmpl-${provider.id}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    };
    yield {
      id: `chatcmpl-${provider.id}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
  }

  return {
    ok: true,
    providerId: provider.id,
    model: result.model,
    chunks: chunks(),
    getAssembledContent: () => content,
    getUsage: () => null,
  };
}
