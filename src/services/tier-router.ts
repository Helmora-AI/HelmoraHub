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

export interface RouteChatOptions {
  mode: HubMode;
  role?: string | null;
  lane?: string | null;
  sessionKey?: string | null;
  signal?: AbortSignal;
  /** Pin routing to this provider only (catalog model selection). */
  onlyProviderId?: string | null;
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

async function prepareChain(
  options: RouteChatOptions,
  request?: ChatRequest
): Promise<{
  chain: ProviderToggle[];
  attempts: Array<{ providerId: string; status: number; error?: string }>;
}> {
  const rate = rates();
  const preferVision = request ? requestHasImages(request.messages) : false;
  let chain = await buildFallbackChain(options.mode, { preferVision });
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

    const result = provider.baseUrl
      ? await dispatchChat(provider, { ...request, stream: false }, options.signal)
      : demoCompletion(provider, request);

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

    const result = provider.baseUrl
      ? await dispatchChatStream(
          provider,
          { ...request, stream: true },
          options.signal
        )
      : demoCompletionStream(provider, request);

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
