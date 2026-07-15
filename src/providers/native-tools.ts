import type { ProposedToolCall } from '../services/tool-loop.js';
import type { RegisteredTool } from '../tools/types.js';
import type { ModelToolResult } from '../tools/untrusted-context.js';
import type { ProviderToggle } from '../types.js';

export type NativeToolAdapter = 'openai_chat' | 'openai_responses';

export type NativeToolCapability = {
  adapter: NativeToolAdapter;
  /** Native tool rounds are completed before the public answer stream starts. */
  streaming: false;
};

export type ProviderToolRound = {
  definitions: readonly RegisteredTool[];
  calls?: readonly ProposedToolCall[];
  results?: readonly ModelToolResult[];
};

export class ProviderToolProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderToolProtocolError';
  }
}

export function nativeToolCapabilityFor(
  provider: Pick<ProviderToggle, 'id' | 'protocol' | 'authMode' | 'capabilities'>,
): NativeToolCapability | null {
  if (!provider.capabilities.includes('tools')) return null;
  if (provider.id === 'codex' && provider.protocol === 'oauth' && provider.authMode === 'oauth') {
    return { adapter: 'openai_responses', streaming: false };
  }
  if (provider.protocol === 'openai' || provider.protocol === 'keyless' || provider.protocol === 'custom') {
    return { adapter: 'openai_chat', streaming: false };
  }
  if (provider.protocol === 'oauth') {
    return { adapter: 'openai_chat', streaming: false };
  }
  return null;
}

export function parseToolArguments(input: {
  protocol: 'openai_chat' | 'openai_responses';
  value: unknown;
}): Record<string, unknown> {
  const code = `${input.protocol}_invalid_tool_arguments`;
  if (typeof input.value !== 'string') {
    throw new ProviderToolProtocolError(code, 'Tool arguments must be a JSON string.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.value);
  } catch {
    throw new ProviderToolProtocolError(code, 'Tool arguments contain invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderToolProtocolError(code, 'Tool arguments must decode to an object.');
  }
  return parsed as Record<string, unknown>;
}

export function assertKnownTool(input: {
  protocol: 'openai_chat' | 'openai_responses';
  name: unknown;
  definitions: readonly RegisteredTool[];
}): RegisteredTool['id'] {
  if (typeof input.name !== 'string') {
    throw new ProviderToolProtocolError(`${input.protocol}_invalid_tool_call`, 'Tool name is invalid.');
  }
  const tool = input.definitions.find((candidate) => candidate.id === input.name);
  if (!tool) {
    throw new ProviderToolProtocolError(`${input.protocol}_unknown_tool`, 'Provider proposed an unavailable tool.');
  }
  return tool.id;
}

export function assertCallId(input: {
  protocol: 'openai_chat' | 'openai_responses';
  value: unknown;
  seen?: Set<string>;
}): string {
  if (typeof input.value !== 'string' || !input.value.trim() || input.value.length > 200) {
    throw new ProviderToolProtocolError(`${input.protocol}_invalid_tool_call`, 'Tool call id is invalid.');
  }
  const id = input.value.trim();
  if (input.seen?.has(id)) {
    throw new ProviderToolProtocolError(`${input.protocol}_duplicate_tool_call`, 'Tool call ids must be unique.');
  }
  input.seen?.add(id);
  return id;
}

export function serializeModelToolResult(result: ModelToolResult): string {
  return JSON.stringify({
    isError: result.isError,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    content: result.content,
    sources: result.sources,
    truncated: result.truncated,
  });
}

export function pairToolResults(
  protocol: 'openai_chat' | 'openai_responses',
  calls: readonly ProposedToolCall[],
  results: readonly ModelToolResult[],
): Array<{ call: ProposedToolCall; result: ModelToolResult }> {
  const callIds = new Set<string>();
  for (const call of calls) assertCallId({ protocol, value: call.id, seen: callIds });
  const byCall = new Map<string, ModelToolResult>();
  for (const result of results) {
    const call = calls.find((candidate) => candidate.id === result.callId);
    if (!call || byCall.has(result.callId) || result.toolId !== call.toolId) {
      throw new ProviderToolProtocolError(`${protocol}_invalid_tool_result`, 'Tool result does not match one unique call.');
    }
    byCall.set(result.callId, result);
  }
  if (byCall.size !== calls.length) {
    throw new ProviderToolProtocolError(`${protocol}_invalid_tool_result`, 'Every tool call requires one result.');
  }
  return calls.map((call) => ({ call, result: byCall.get(call.id)! }));
}
