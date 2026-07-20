import type { ProviderToggle } from '../../types.js';
import type { ChatMessage, ChatRequest, UpstreamResult, UpstreamStreamResult } from '../../services/upstream.js';
import type { ProposedToolCall } from '../../services/tool-loop.js';
import type { RegisteredTool } from '../../tools/types.js';
import type { ModelToolResult } from '../../tools/untrusted-context.js';
import {
  ProviderToolProtocolError,
  assertCallId,
  assertKnownTool,
  pairToolResults,
  serializeModelToolResult,
} from '../native-tools.js';

const ANTHROPIC_VERSION = '2023-06-01';

export function toAnthropicTools(definitions: readonly RegisteredTool[]) {
  return definitions.map((tool) => ({
    name: tool.id,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function parseAnthropicToolCalls(
  body: unknown,
  definitions: readonly RegisteredTool[],
): ProposedToolCall[] {
  if (!body || typeof body !== 'object') return [];
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const seen = new Set<string>();
  return content.flatMap((raw): ProposedToolCall[] => {
    if (!raw || typeof raw !== 'object') return [];
    const block = raw as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (block.type !== 'tool_use') return [];
    if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
      throw new ProviderToolProtocolError('anthropic_invalid_tool_arguments', 'Tool input must be an object.');
    }
    return [{
      id: assertCallId({ protocol: 'anthropic', value: block.id, seen }),
      toolId: assertKnownTool({ protocol: 'anthropic', name: block.name, definitions }),
      arguments: block.input as Record<string, unknown>,
    }];
  });
}

export function toAnthropicToolMessages(
  calls: readonly ProposedToolCall[],
  results: readonly ModelToolResult[],
) {
  const pairs = pairToolResults('anthropic', calls, results);
  return [
    {
      role: 'assistant' as const,
      content: calls.map((call) => ({
        type: 'tool_use' as const,
        id: call.id,
        name: call.toolId,
        input: call.arguments,
      })),
    },
    {
      role: 'user' as const,
      content: pairs.map(({ call, result }) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        content: serializeModelToolResult(result),
        is_error: result.isError,
      })),
    },
  ];
}

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
      const p = part as { type?: string; text?: string; image_url?: { url?: string } };
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'image_url' && p.image_url?.url) {
        return `[image:${p.image_url.url.slice(0, 64)}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** OpenAI chat messages → Anthropic messages + optional system. */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const m of messages) {
    const text = textFromContent(m.content);
    if (m.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n${text}`;
    } else {
      out.push({ role, content: text || ' ' });
    }
  }

  if (out.length === 0) out.push({ role: 'user', content: 'ping' });
  if (out[0].role !== 'user') out.unshift({ role: 'user', content: 'Continue.' });

  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

function anthropicBase(provider: ProviderToggle): string {
  let base = (provider.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  if (!base.endsWith('/v1') && !base.includes('/messages')) {
    // leave as-is (z.ai / kimi already include path)
  }
  return base;
}

function messagesUrl(provider: ProviderToggle): string {
  const base = anthropicBase(provider);
  if (base.endsWith('/messages')) return base;
  return `${base}/messages`;
}

function anthropicHeaders(provider: ProviderToggle): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(provider.extraHeaders ?? {}),
  };
  if (provider.apiKey) {
    if (provider.authMode === 'oauth') {
      // Claude OAuth: Bearer only (no x-api-key).
      headers.Authorization = `Bearer ${provider.apiKey}`;
      delete headers['x-api-key'];
    } else {
      headers['x-api-key'] = provider.apiKey;
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
  }
  return headers;
}

function toOpenAIBody(
  providerId: string,
  model: string,
  anthropicBody: {
    id?: string;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  },
  definitions: readonly RegisteredTool[] = [],
): unknown {
  const text = (anthropicBody.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('');
  const calls = definitions.length > 0 ? parseAnthropicToolCalls(anthropicBody, definitions) : [];
  return {
    id: anthropicBody.id ?? `chatcmpl-${providerId}`,
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
        finish_reason: calls.length > 0
          ? 'tool_calls'
          : anthropicBody.stop_reason === 'max_tokens' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: anthropicBody.usage?.input_tokens ?? 0,
      completion_tokens: anthropicBody.usage?.output_tokens ?? 0,
      total_tokens:
        (anthropicBody.usage?.input_tokens ?? 0) + (anthropicBody.usage?.output_tokens ?? 0),
    },
  };
}

export async function callAnthropicCompatible(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamResult> {
  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? 'claude-sonnet-4-20250514';

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

  const { system, messages: baseMessages } = toAnthropicMessages(request.messages);
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [...baseMessages];
  if (request.toolRound?.calls?.length) {
    if (!request.toolRound.results) {
      return { ok: false, status: 400, providerId: provider.id, model, body: null, error: 'anthropic_invalid_tool_result' };
    }
    messages.push(...toAnthropicToolMessages(request.toolRound.calls, request.toolRound.results));
  } else if (request.toolRound?.results?.length) {
    return { ok: false, status: 400, providerId: provider.id, model, body: null, error: 'anthropic_invalid_tool_result' };
  }
  const maxTokens =
    typeof request.max_tokens === 'number' && request.max_tokens > 0
      ? request.max_tokens
      : 1024;

  const url = messagesUrl(provider);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: anthropicHeaders(provider),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages,
        ...(request.toolRound ? { tools: toAnthropicTools(request.toolRound.definitions) } : {}),
        ...(request.toolRound?.required ? { tool_choice: { type: 'any' } } : {}),
        ...(system ? { system } : {}),
        ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
        stream: false,
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
            : `Anthropic ${response.status}`,
      };
    }

    return {
      ok: true,
      status: 200,
      providerId: provider.id,
      model,
      body: toOpenAIBody(
        provider.id,
        model,
        body as Parameters<typeof toOpenAIBody>[2],
        request.toolRound?.definitions,
      ),
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      providerId: provider.id,
      model,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Stream Anthropic SSE → OpenAI chat.completion.chunk objects. */
export async function callAnthropicCompatibleStream(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamStreamResult> {
  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? 'claude-sonnet-4-20250514';

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

  const { system, messages } = toAnthropicMessages(request.messages);
  const maxTokens =
    typeof request.max_tokens === 'number' && request.max_tokens > 0
      ? request.max_tokens
      : 1024;

  const url = messagesUrl(provider);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: anthropicHeaders(provider),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages,
        ...(system ? { system } : {}),
        stream: true,
      }),
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      providerId: provider.id,
      model,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep */
    }
    return {
      ok: false,
      status: response.status,
      providerId: provider.id,
      model,
      body,
      error: `Anthropic stream ${response.status}`,
    };
  }

  let assembled = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

  async function* chunks(): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt: {
          type?: string;
          delta?: { type?: string; text?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
          assembled += evt.delta.text;
          yield {
            id: `chatcmpl-${provider.id}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }],
          };
        }
        if (evt.type === 'message_delta' && evt.usage) {
          usage = {
            prompt_tokens: evt.usage.input_tokens,
            completion_tokens: evt.usage.output_tokens,
          };
        }
      }
    }
    yield {
      id: `chatcmpl-${provider.id}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
  }

  return {
    ok: true,
    providerId: provider.id,
    model,
    chunks: chunks(),
    getAssembledContent: () => assembled,
    getUsage: () => usage,
  };
}
