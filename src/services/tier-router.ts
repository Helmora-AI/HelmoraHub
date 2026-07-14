import type { HubMode } from '../types.js';
import { MODE_PROFILES } from '../types.js';
import { rates, listProviders } from '../db/index.js';
import { buildFallbackChain } from './mode-router.js';
import type { ProviderToggle } from '../types.js';
import { requestHasImages } from '../lib/vision.js';
import { isChatProtocolReady } from '../providers/catalog/index.js';
import { dispatchChat, dispatchChatStream } from '../providers/dispatch.js';
import {
  demoCompletion,
  demoCompletionStream,
  type ChatRequest,
  type UpstreamResult,
  type UpstreamStreamResult,
} from './upstream.js';
import {
  prepareUpstreamMessages,
  resolvePublicModelName,
  type IdentitySurface,
} from './identity-context.js';

export interface RouteChatIdentityOptions {
  enabled: boolean;
  surface: IdentitySurface;
  requestedModelRef: string;
  meta: boolean;
  /** Catalog / product display name when available (API publicModelName). */
  displayName?: string | null;
}

export type CrossModelRetryReason =
  | 'network'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'invalid_credentials'
  | 'model_missing'
  | 'request_invalid'
  | 'context_limit'
  | 'unsupported_request';

export type CrossModelRetryDecision = {
  retryable: boolean;
  reason: CrossModelRetryReason;
  healthEffect: 'none' | 'degraded' | 'invalid_credentials';
};

export function normalizeCrossModelRetry(input: {
  status: number;
  error?: string;
  body?: unknown;
}): CrossModelRetryDecision {
  const detail = `${input.error ?? ''} ${
    typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? '')
  }`.toLowerCase();

  if (/context.{0,20}(?:length|limit|window)|maximum context|too many tokens/.test(detail)) {
    return { retryable: false, reason: 'context_limit', healthEffect: 'none' };
  }
  if (input.status === 422 || /unsupported (?:option|parameter|request)/.test(detail)) {
    return { retryable: false, reason: 'unsupported_request', healthEffect: 'none' };
  }
  if (input.status === 401 || input.status === 403) {
    return {
      retryable: true,
      reason: 'invalid_credentials',
      healthEffect: 'invalid_credentials',
    };
  }
  if (input.status === 404) {
    return { retryable: true, reason: 'model_missing', healthEffect: 'degraded' };
  }
  if (input.status === 429) {
    return { retryable: true, reason: 'rate_limited', healthEffect: 'degraded' };
  }
  if (
    input.status === 0
    || /network|fetch failed|timeout|timed out|econn|socket|dns/.test(detail)
  ) {
    return { retryable: true, reason: 'network', healthEffect: 'degraded' };
  }
  if (input.status >= 500) {
    return { retryable: true, reason: 'upstream_unavailable', healthEffect: 'degraded' };
  }
  return { retryable: false, reason: 'request_invalid', healthEffect: 'none' };
}

export interface RouteChatOptions {
  mode: HubMode;
  role?: string | null;
  lane?: string | null;
  sessionKey?: string | null;
  signal?: AbortSignal;
  /** Pin routing to this provider only (catalog model selection). */
  onlyProviderId?: string | null;
  /**
   * Prefixed provider chain (e.g. Helmora Mini multi-model pool).
   * When set, replaces the mode tier chain as the base order.
   */
  preferredChain?: ProviderToggle[] | null;
  /** Per-provider upstream model pin (Mini candidate modelId). */
  modelByProvider?: Record<string, string> | null;
  /** Attempt-scoped Helmora identity injection (rev 2). */
  identity?: RouteChatIdentityOptions | null;
}

function withAttemptIdentity(
  request: ChatRequest,
  provider: ProviderToggle,
  identity: RouteChatIdentityOptions | null | undefined
): ChatRequest {
  if (!identity?.enabled) return request;
  const upstreamModelId =
    (typeof request.model === 'string' && request.model.trim()) ||
    provider.defaultModel ||
    'auto';
  const prepared = prepareUpstreamMessages(request.messages, {
    surface: identity.surface,
    identityEnabled: true,
    attempt: {
      providerId: provider.id,
      providerLabel: provider.label,
      meta: identity.meta,
      identity: {
        requestedModelRef: identity.requestedModelRef,
        upstreamModelId,
        publicModelName: resolvePublicModelName({
          meta: identity.meta,
          displayName: identity.displayName,
          upstreamModelId,
        }),
      },
    },
  });
  return { ...request, messages: prepared.messagesForAdapter };
}

export interface RouteChatResult extends UpstreamResult {
  mode: HubMode;
  attempts: Array<{ providerId: string; status: number; error?: string }>;
}

export type RouteChatStreamResult =
  | {
      ok: true;
      mode: HubMode;
      providerId: string;
      model: string;
      attempts: Array<{ providerId: string; status: number; error?: string }>;
      stream: Extract<UpstreamStreamResult, { ok: true }>;
    }
  | {
      ok: false;
      mode: HubMode;
      status: number;
      providerId: string;
      model: string;
      body: unknown;
      error?: string;
      attempts: Array<{ providerId: string; status: number; error?: string }>;
    };

const DEFAULT_COOLDOWN_SECONDS = 30;
const RPM_SOFT_LIMIT = 60;

function applyModelPin(
  request: ChatRequest,
  provider: ProviderToggle,
  modelByProvider: Record<string, string> | null | undefined
): ChatRequest {
  const pinned = modelByProvider?.[provider.id];
  if (!pinned) return request;
  return { ...request, model: pinned };
}

async function prepareChain(
  options: RouteChatOptions,
  request?: ChatRequest
): Promise<{
  chain: ProviderToggle[];
  attempts: Array<{ providerId: string; status: number; error?: string }>;
}> {
  const rate = rates();
  const preferVision = request ? requestHasImages(request.messages) : false;
  let chain =
    options.preferredChain && options.preferredChain.length > 0
      ? options.preferredChain.filter((p) => p.enabled)
      : await buildFallbackChain(options.mode, { preferVision });
  const attempts: Array<{ providerId: string; status: number; error?: string }> = [];

  if (options.onlyProviderId) {
    const all = await listProviders();
    const pinned = all.find((p) => p.id === options.onlyProviderId && p.enabled);
    chain = pinned ? [pinned] : [];
  } else if (options.sessionKey) {
    const stickyId = await rate.getSticky(options.sessionKey);
    if (stickyId) {
      const sticky = chain.find((p) => p.id === stickyId);
      const cooling = sticky ? await rate.isCoolingDown(sticky.id) : true;
      // Sticky only if still preferred when vision needed
      const stickyOk =
        sticky &&
        !cooling &&
        (!preferVision || sticky.capabilities.includes('vision') || !chain.some((p) => p.capabilities.includes('vision')));
      if (stickyOk && sticky) {
        chain = [sticky, ...chain.filter((p) => p.id !== sticky.id)];
      }
    }
  }

  return { chain, attempts };
}

export async function routeChat(
  request: ChatRequest,
  options: RouteChatOptions
): Promise<RouteChatResult> {
  const rate = rates();
  const { chain, attempts } = await prepareChain(options, request);

  if (chain.length === 0) {
    return {
      ok: false,
      status: 503,
      providerId: 'none',
      model: request.model ?? 'auto',
      body: {
        error: {
          message: `No enabled providers for mode "${options.mode}". Enable toggles or configure upstream.`,
          type: 'helmora_no_providers',
        },
      },
      error: 'No providers',
      mode: options.mode,
      attempts,
    };
  }

  for (const provider of chain) {
    if (await rate.isCoolingDown(provider.id)) {
      attempts.push({
        providerId: provider.id,
        status: 429,
        error: 'provider_cooldown',
      });
      continue;
    }

    if (
      provider.baseUrl &&
      !isChatProtocolReady(provider.protocol, provider.catalogReady)
    ) {
      attempts.push({
        providerId: provider.id,
        status: 503,
        error: 'protocol_not_ready',
      });
      continue;
    }

    const rpm = await rate.incrRpm(provider.id);
    if (rpm > RPM_SOFT_LIMIT) {
      await rate.setCooldown(provider.id, DEFAULT_COOLDOWN_SECONDS);
      attempts.push({
        providerId: provider.id,
        status: 429,
        error: `rpm_soft_limit_${RPM_SOFT_LIMIT}`,
      });
      continue;
    }

    const pinnedReq = applyModelPin(
      { ...request, stream: false },
      provider,
      options.modelByProvider
    );
    const attemptReq = withAttemptIdentity(
      pinnedReq,
      provider,
      options.identity
    );
    const result = provider.baseUrl
      ? await dispatchChat(provider, attemptReq, options.signal)
      : demoCompletion(provider, attemptReq);

    attempts.push({
      providerId: provider.id,
      status: result.status,
      error: result.error,
    });

    if (result.ok) {
      if (options.sessionKey) {
        await rate.setSticky(options.sessionKey, provider.id);
      }
      return { ...result, mode: options.mode, attempts };
    }

    if (result.status === 429 || result.status >= 500) {
      await rate.setCooldown(provider.id, DEFAULT_COOLDOWN_SECONDS);
      continue;
    }

    if (result.status >= 400 && result.status < 500 && provider.baseUrl) {
      return { ...result, mode: options.mode, attempts };
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    status: last?.status ?? 502,
    providerId: last?.providerId ?? 'none',
    model: request.model ?? 'auto',
    body: {
      error: {
        message: 'All providers in the fallback chain failed',
        type: 'helmora_failover_exhausted',
        attempts,
        mode: options.mode,
        profile: MODE_PROFILES[options.mode].label,
      },
    },
    error: 'Failover exhausted',
    mode: options.mode,
    attempts,
  };
}

export async function routeChatStream(
  request: ChatRequest,
  options: RouteChatOptions
): Promise<RouteChatStreamResult> {
  const rate = rates();
  const { chain, attempts } = await prepareChain(options, request);

  if (chain.length === 0) {
    return {
      ok: false,
      status: 503,
      providerId: 'none',
      model: request.model ?? 'auto',
      body: {
        error: {
          message: `No enabled providers for mode "${options.mode}".`,
          type: 'helmora_no_providers',
        },
      },
      error: 'No providers',
      mode: options.mode,
      attempts,
    };
  }

  for (const provider of chain) {
    if (await rate.isCoolingDown(provider.id)) {
      attempts.push({ providerId: provider.id, status: 429, error: 'provider_cooldown' });
      continue;
    }

    if (
      provider.baseUrl &&
      !isChatProtocolReady(provider.protocol, provider.catalogReady)
    ) {
      attempts.push({
        providerId: provider.id,
        status: 503,
        error: 'protocol_not_ready',
      });
      continue;
    }

    const rpm = await rate.incrRpm(provider.id);
    if (rpm > RPM_SOFT_LIMIT) {
      await rate.setCooldown(provider.id, DEFAULT_COOLDOWN_SECONDS);
      attempts.push({
        providerId: provider.id,
        status: 429,
        error: `rpm_soft_limit_${RPM_SOFT_LIMIT}`,
      });
      continue;
    }

    const pinnedReq = applyModelPin(
      { ...request, stream: true },
      provider,
      options.modelByProvider
    );
    const attemptReq = withAttemptIdentity(
      pinnedReq,
      provider,
      options.identity
    );
    const result = provider.baseUrl
      ? await dispatchChatStream(provider, attemptReq, options.signal)
      : demoCompletionStream(provider, attemptReq);

    if (!result.ok) {
      attempts.push({
        providerId: provider.id,
        status: result.status,
        error: result.error,
      });
      if (result.status === 429 || result.status >= 500) {
        await rate.setCooldown(provider.id, DEFAULT_COOLDOWN_SECONDS);
        continue;
      }
      if (result.status >= 400 && result.status < 500 && provider.baseUrl) {
        return {
          ok: false,
          status: result.status,
          providerId: result.providerId,
          model: result.model,
          body: result.body,
          error: result.error,
          mode: options.mode,
          attempts,
        };
      }
      continue;
    }

    attempts.push({ providerId: provider.id, status: 200 });
    if (options.sessionKey) {
      await rate.setSticky(options.sessionKey, provider.id);
    }

    return {
      ok: true,
      mode: options.mode,
      providerId: result.providerId,
      model: result.model,
      attempts,
      stream: result,
    };
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    status: last?.status ?? 502,
    providerId: last?.providerId ?? 'none',
    model: request.model ?? 'auto',
    body: {
      error: {
        message: 'All providers in the fallback chain failed (stream)',
        type: 'helmora_failover_exhausted',
        attempts,
      },
    },
    error: 'Failover exhausted',
    mode: options.mode,
    attempts,
  };
}
