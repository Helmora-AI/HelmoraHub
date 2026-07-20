import type { ProviderToggle } from '../types.js';
import { summarizeUserContent, countImagesInContent } from '../lib/vision.js';
import { resolveUpstreamAuth } from '../providers/resolve-auth.js';
import type { ProviderToolRound } from '../providers/native-tools.js';
import { ProviderToolProtocolError } from '../providers/native-tools.js';
import {
  parseOpenAIChatToolCalls,
  toOpenAIChatToolMessages,
  toOpenAIChatTools,
} from '../providers/adapters/openai-tools.js';

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** Helmora-internal native tool state. This field is never sent upstream. */
  toolRound?: ProviderToolRound;
  [key: string]: unknown;
}

export interface UpstreamResult {
  ok: boolean;
  status: number;
  providerId: string;
  model: string;
  body: unknown;
  error?: string;
}

export interface StreamChunkMeta {
  providerId: string;
  model: string;
}

export interface UpstreamStreamOk {
  ok: true;
  providerId: string;
  model: string;
  /** Async iterator of OpenAI chat.completion.chunk objects (not including [DONE]) */
  chunks: AsyncGenerator<Record<string, unknown>, void, unknown>;
  /** Full assistant text accumulated while streaming (for billing) */
  getAssembledContent: () => string;
  /** Usage if upstream sent it in a final chunk */
  getUsage: () => { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface UpstreamStreamErr {
  ok: false;
  status: number;
  providerId: string;
  model: string;
  body: unknown;
  error?: string;
}

export type UpstreamStreamResult = UpstreamStreamOk | UpstreamStreamErr;

function openAIChatRequestBody(
  request: ChatRequest,
  model: string,
  stream: boolean,
): Record<string, unknown> {
  const { toolRound, ...upstreamRequest } = request;
  const messages = [...request.messages];
  if (toolRound?.calls?.length) {
    if (!toolRound.results) {
      throw new ProviderToolProtocolError(
        'openai_chat_invalid_tool_result',
        'Tool call continuation requires results.',
      );
    }
    messages.push(...toOpenAIChatToolMessages(toolRound.calls, toolRound.results));
  } else if (toolRound?.results?.length) {
    throw new ProviderToolProtocolError(
      'openai_chat_invalid_tool_result',
      'Tool results require their originating calls.',
    );
  }
  return {
    ...upstreamRequest,
    messages,
    ...(toolRound ? { tools: toOpenAIChatTools(toolRound.definitions) } : {}),
    ...(toolRound?.required ? { tool_choice: 'required' } : {}),
    model,
    stream,
  };
}

export async function callOpenAICompatible(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamResult> {
  const auth = resolveUpstreamAuth(provider);
  if (auth.error) {
    return {
      ok: false,
      status: 400,
      providerId: provider.id,
      model: request.model ?? provider.defaultModel ?? 'unknown',
      body: null,
      error: auth.error,
    };
  }
  if (!auth.baseUrl) {
    return {
      ok: false,
      status: 503,
      providerId: provider.id,
      model: request.model ?? provider.defaultModel ?? 'unknown',
      body: null,
      error: `Provider ${provider.id} has no base_url configured`,
    };
  }

  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? 'gpt-4o-mini';

  const url = `${auth.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(provider.extraHeaders ?? {}),
  };
  if (auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(openAIChatRequestBody(request, model, false)),
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
            : `Upstream ${response.status}`,
      };
    }

    if (request.toolRound) {
      try {
        parseOpenAIChatToolCalls(body, request.toolRound.definitions);
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
    }

    return {
      ok: true,
      status: response.status,
      providerId: provider.id,
      model,
      body,
    };
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

/** Stream from OpenAI-compatible upstream (SSE). */
export async function callOpenAICompatibleStream(
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
  const auth = resolveUpstreamAuth(provider);
  if (auth.error) {
    return {
      ok: false,
      status: 400,
      providerId: provider.id,
      model: request.model ?? provider.defaultModel ?? 'unknown',
      body: null,
      error: auth.error,
    };
  }
  if (!auth.baseUrl) {
    return {
      ok: false,
      status: 503,
      providerId: provider.id,
      model: request.model ?? provider.defaultModel ?? 'unknown',
      body: null,
      error: `Provider ${provider.id} has no base_url configured`,
    };
  }

  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? 'gpt-4o-mini';

  const url = `${auth.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(provider.extraHeaders ?? {}),
  };
  if (auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }

  let assembled = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(openAIChatRequestBody(request, model, true)),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
      return {
        ok: false,
        status: response.status,
        providerId: provider.id,
        model,
        body,
        error: `Upstream ${response.status}`,
      };
    }

    if (!response.body) {
      return {
        ok: false,
        status: 502,
        providerId: provider.id,
        model,
        body: null,
        error: 'Upstream returned empty body',
      };
    }

    const chunks = parseUpstreamSse(response.body, {
      onDelta: (t) => {
        assembled += t;
      },
      onUsage: (u) => {
        usage = u;
      },
    });

    return {
      ok: true,
      providerId: provider.id,
      model,
      chunks,
      getAssembledContent: () => assembled,
      getUsage: () => usage,
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

async function* parseUpstreamSse(
  body: ReadableStream<Uint8Array>,
  hooks: {
    onDelta: (text: string) => void;
    onUsage: (u: { prompt_tokens?: number; completion_tokens?: number }) => void;
  }
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          const delta = extractDeltaContent(json);
          if (delta) hooks.onDelta(delta);
          if (json.usage && typeof json.usage === 'object') {
            hooks.onUsage(json.usage as { prompt_tokens?: number; completion_tokens?: number });
          }
          yield json;
        } catch {
          // skip malformed
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractDeltaContent(chunk: Record<string, unknown>): string {
  const choices = chunk.choices;
  if (!Array.isArray(choices) || !choices[0]) return '';
  const delta = (choices[0] as { delta?: { content?: string } }).delta;
  return typeof delta?.content === 'string' ? delta.content : '';
}

/** Demo response when no real upstream is configured (Phase 1 local demo). */
export function demoCompletion(
  provider: ProviderToggle,
  request: ChatRequest
): UpstreamResult {
  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? `demo/${provider.id}`;

  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  const userText = summarizeUserContent(lastUser?.content);
  const imageCount = countImagesInContent(lastUser?.content);

  const content =
    `[Helmora AI demo · ${provider.label} · tier ${provider.tier}` +
    (imageCount > 0 ? ` · vision:${imageCount}` : '') +
    `]\n\n` +
    `Received: ${userText.slice(0, 800) || '(empty)'}\n\n` +
    (imageCount > 0
      ? `Noted ${imageCount} image(s). Configure a vision-capable upstream (base_url + model) for real image understanding.\n\n`
      : '') +
    `Configure UPSTREAM_BASE_URL / provider base_url for real inference.`;

  return {
    ok: true,
    status: 200,
    providerId: provider.id,
    model,
    body: {
      id: `chatcmpl-helmora-demo`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: Math.max(1, Math.ceil(userText.length / 4) + imageCount * 85),
        completion_tokens: Math.ceil(content.length / 4) || 1,
        total_tokens: 0,
      },
    },
  };
}

/** Demo SSE stream (chunked for clients that require streaming). */
export function demoCompletionStream(
  provider: ProviderToggle,
  request: ChatRequest
): UpstreamStreamOk {
  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? `demo/${provider.id}`;

  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  const userText = summarizeUserContent(lastUser?.content);
  const imageCount = countImagesInContent(lastUser?.content);

  const full =
    `[Helmora AI demo · ${provider.label} · tier ${provider.tier}` +
    (imageCount > 0 ? ` · vision:${imageCount}` : '') +
    `]\n\n` +
    `Received: ${userText.slice(0, 800) || '(empty)'}\n\n` +
    (imageCount > 0
      ? `Noted ${imageCount} image(s). Configure a vision-capable upstream for real image understanding.\n\n`
      : '') +
    `Configure UPSTREAM_BASE_URL / provider base_url for real inference.`;

  let assembled = '';
  const id = `chatcmpl-helmora-demo-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  async function* chunks(): AsyncGenerator<Record<string, unknown>, void, unknown> {
    // role chunk
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };

    const pieceSize = 24;
    for (let i = 0; i < full.length; i += pieceSize) {
      const piece = full.slice(i, i + pieceSize);
      assembled += piece;
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      };
      // tiny yield to event loop
      await Promise.resolve();
    }

    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: Math.ceil(userText.length / 4) || 1,
        completion_tokens: Math.ceil(full.length / 4) || 1,
      },
    };
  }

  return {
    ok: true,
    providerId: provider.id,
    model,
    chunks: chunks(),
    getAssembledContent: () => assembled || full,
    getUsage: () => ({
      prompt_tokens: Math.max(1, Math.ceil(userText.length / 4) + imageCount * 85),
      completion_tokens: Math.ceil(full.length / 4) || 1,
    }),
  };
}
