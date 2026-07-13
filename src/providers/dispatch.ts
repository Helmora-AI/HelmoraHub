import type { ProviderToggle } from '../types.js';
import {
  callOpenAICompatible,
  callOpenAICompatibleStream,
  type ChatRequest,
  type UpstreamResult,
  type UpstreamStreamResult,
} from '../services/upstream.js';
import { callAnthropicCompatible, callAnthropicCompatibleStream } from './adapters/anthropic.js';
import { callGeminiCompatible, callGeminiCompatibleStream } from './adapters/gemini.js';
import { callCodexResponses, callCodexResponsesStream } from './adapters/codex-responses.js';
import { isChatProtocolReady } from './catalog/index.js';
import { resolveProviderAuth } from '../oauth/resolve-provider-auth.js';

function notReady(
  provider: ProviderToggle,
  request: ChatRequest
): UpstreamResult {
  return {
    ok: false,
    status: 503,
    providerId: provider.id,
    model: request.model ?? provider.defaultModel ?? 'unknown',
    body: null,
    error: `protocol_not_ready: ${provider.protocol}`,
  };
}

export async function dispatchChat(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamResult> {
  if (!isChatProtocolReady(provider.protocol, provider.catalogReady)) {
    return notReady(provider, request);
  }

  // Claude OAuth → Anthropic Messages with Bearer access token.
  if (provider.id === 'claude' && provider.authMode === 'oauth') {
    const resolved = await resolveProviderAuth(provider);
    return callAnthropicCompatible(resolved, request, signal);
  }

  // Codex OAuth → Responses API.
  if (provider.id === 'codex' && provider.authMode === 'oauth') {
    const resolved = await resolveProviderAuth(provider);
    return callCodexResponses(resolved, request, signal);
  }

  switch (provider.protocol) {
    case 'anthropic':
      return callAnthropicCompatible(provider, request, signal);
    case 'gemini':
      return callGeminiCompatible(provider, request, signal);
    case 'oauth':
    case 'openai':
    case 'keyless':
    case 'custom':
    default:
      return callOpenAICompatible(provider, request, signal);
  }
}

export async function dispatchChatStream(
  provider: ProviderToggle,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<UpstreamStreamResult> {
  if (!isChatProtocolReady(provider.protocol, provider.catalogReady)) {
    return {
      ok: false,
      status: 503,
      providerId: provider.id,
      model: request.model ?? provider.defaultModel ?? 'unknown',
      body: null,
      error: `protocol_not_ready: ${provider.protocol}`,
    };
  }

  if (provider.id === 'claude' && provider.authMode === 'oauth') {
    const resolved = await resolveProviderAuth(provider);
    return callAnthropicCompatibleStream(resolved, request, signal);
  }

  if (provider.id === 'codex' && provider.authMode === 'oauth') {
    const resolved = await resolveProviderAuth(provider);
    return callCodexResponsesStream(resolved, request, signal);
  }

  switch (provider.protocol) {
    case 'anthropic':
      return callAnthropicCompatibleStream(provider, request, signal);
    case 'gemini':
      return callGeminiCompatibleStream(provider, request, signal);
    case 'oauth':
    case 'openai':
    case 'keyless':
    case 'custom':
    default:
      return callOpenAICompatibleStream(provider, request, signal);
  }
}
