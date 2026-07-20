import type { ProviderToggle } from '../../types.js';
import type { ChatMessage, ChatRequest, UpstreamResult, UpstreamStreamResult } from '../../services/upstream.js';
import type { ProposedToolCall } from '../../services/tool-loop.js';
import type { RegisteredTool } from '../../tools/types.js';
import type { ModelToolResult } from '../../tools/untrusted-context.js';
import {
  ProviderToolProtocolError,
  assertKnownTool,
  pairToolResults,
  serializeModelToolResult,
} from '../native-tools.js';

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    try {
      return content == null ? '' : JSON.stringify(content);
    } catch {
      return '';
    }
  }
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string };
    if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
  }
  return texts.join('\n');
}

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
};
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

export function toGeminiTools(definitions: readonly RegisteredTool[]) {
  return [{
    functionDeclarations: definitions.map((tool) => ({
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  }];
}

export function parseGeminiToolCalls(
  body: unknown,
  definitions: readonly RegisteredTool[],
  round: number,
): ProposedToolCall[] {
  if (!body || typeof body !== 'object') return [];
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  const first = candidates[0];
  const parts = first && typeof first === 'object'
    ? (first as { content?: { parts?: unknown } }).content?.parts
    : undefined;
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((raw, index): ProposedToolCall[] => {
    if (!raw || typeof raw !== 'object') return [];
    const call = (raw as { functionCall?: unknown }).functionCall;
    if (!call || typeof call !== 'object') return [];
    const value = call as { name?: unknown; args?: unknown };
    if (!value.args || typeof value.args !== 'object' || Array.isArray(value.args)) {
      throw new ProviderToolProtocolError('gemini_invalid_tool_arguments', 'Tool arguments must be an object.');
    }
    return [{
      id: `gemini_call_${round}_${index}`,
      toolId: assertKnownTool({ protocol: 'gemini', name: value.name, definitions }),
      arguments: value.args as Record<string, unknown>,
    }];
  });
}

export function toGeminiToolContents(
  calls: readonly ProposedToolCall[],
  results: readonly ModelToolResult[],
) {
  const pairs = pairToolResults('gemini', calls, results);
  return [
    {
      role: 'model' as const,
      parts: calls.map((call) => ({
        functionCall: { name: call.toolId, args: call.arguments },
      })),
    },
    {
      role: 'user' as const,
      parts: pairs.map(({ call, result }) => ({
        functionResponse: {
          name: call.toolId,
          response: { result: serializeModelToolResult(result) },
        },
      })),
    },
  ];
}

export function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    const text = textFromContent(m.content);
    if (m.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: text || ' ' });
    } else {
      contents.push({ role, parts: [{ text: text || ' ' }] });
    }
  }

  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: 'ping' }] });
  if (contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: 'Continue.' }] });
  }

  return {
    systemInstruction: systemParts.length
      ? { parts: [{ text: systemParts.join('\n\n') }] }
      : undefined,
    contents,
  };
}

function geminiRoot(provider: ProviderToggle): string {
  let base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(
    /\/$/,
    ''
  );
  // Strip trailing /models if present (9Router style)
  if (base.endsWith('/models')) base = base.slice(0, -'/models'.length);
  return base;
}

function buildGeminiUrl(
  provider: ProviderToggle,
  model: string,
  stream: boolean
): string {
  const root = geminiRoot(provider);
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  const path = `${root}/models/${encodeURIComponent(model)}:${action}`;
  const key = provider.apiKey ? `key=${encodeURIComponent(provider.apiKey)}` : '';
  const alt = stream ? 'alt=sse' : '';
  const qs = [key, alt].filter(Boolean).join('&');
  return qs ? `${path}?${qs}` : path;
}

function extractGeminiText(body: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

export async function callGeminiCompatible(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamResult> {
  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? 'gemini-2.5-flash';

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

  const { systemInstruction, contents: baseContents } = toGeminiContents(request.messages);
  const contents: GeminiContent[] = [...baseContents];
  if (request.toolRound?.calls?.length) {
    if (!request.toolRound.results) {
      return { ok: false, status: 400, providerId: provider.id, model, body: null, error: 'gemini_invalid_tool_result' };
    }
    contents.push(...toGeminiToolContents(request.toolRound.calls, request.toolRound.results));
  } else if (request.toolRound?.results?.length) {
    return { ok: false, status: 400, providerId: provider.id, model, body: null, error: 'gemini_invalid_tool_result' };
  }
  const url = buildGeminiUrl(provider, model, false);
  const maxTokens =
    typeof request.max_tokens === 'number' && request.max_tokens > 0
      ? request.max_tokens
      : undefined;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        contents,
        ...(request.toolRound ? { tools: toGeminiTools(request.toolRound.definitions) } : {}),
        ...(request.toolRound?.required
          ? { toolConfig: { functionCallingConfig: { mode: 'ANY' } } }
          : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: {
          ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
          ...(typeof request.temperature === 'number'
            ? { temperature: request.temperature }
            : {}),
        },
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
            : `Gemini ${response.status}`,
      };
    }

    const content = extractGeminiText(
      body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    );
    const usageMeta = (body as {
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    }).usageMetadata;
    const calls = request.toolRound
      ? parseGeminiToolCalls(body, request.toolRound.definitions, request.toolRound.round ?? 0)
      : [];

    return {
      ok: true,
      status: 200,
      providerId: provider.id,
      model,
      body: {
        id: `chatcmpl-${provider.id}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: content || (calls.length > 0 ? null : ''),
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
          prompt_tokens: usageMeta?.promptTokenCount ?? 0,
          completion_tokens: usageMeta?.candidatesTokenCount ?? 0,
          total_tokens:
            (usageMeta?.promptTokenCount ?? 0) + (usageMeta?.candidatesTokenCount ?? 0),
        },
      },
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

export async function callGeminiCompatibleStream(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamStreamResult> {
  const model =
    request.model && request.model !== 'auto'
      ? request.model
      : provider.defaultModel ?? 'gemini-2.5-flash';

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

  const { systemInstruction, contents } = toGeminiContents(request.messages);
  const url = buildGeminiUrl(provider, model, true);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
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
      error: `Gemini stream ${response.status}`,
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
        if (!data) continue;
        let evt: {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          };
        };
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = extractGeminiText(evt);
        if (delta) {
          // Gemini SSE often re-sends full text; take suffix if prefix matches
          let piece = delta;
          if (assembled && delta.startsWith(assembled)) {
            piece = delta.slice(assembled.length);
            assembled = delta;
          } else {
            assembled += piece;
          }
          if (piece) {
            yield {
              id: `chatcmpl-${provider.id}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            };
          }
        }
        if (evt.usageMetadata) {
          usage = {
            prompt_tokens: evt.usageMetadata.promptTokenCount,
            completion_tokens: evt.usageMetadata.candidatesTokenCount,
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
