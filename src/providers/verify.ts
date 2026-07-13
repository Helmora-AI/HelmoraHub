import type { ProviderToggle } from '../types.js';
import { getCatalogEntry, isChatProtocolReady } from './catalog/index.js';
import { dispatchChat } from './dispatch.js';

export type VerifyResult = {
  ok: boolean;
  verifyStatus: ProviderToggle['verifyStatus'];
  verifyError: string | null;
  verifiedAt: number | null;
  enabled: boolean;
  latencyMs: number;
  model: string | null;
};

function truncateError(msg: string, max = 200): string {
  const t = msg.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function resolveCloudflareBaseUrl(baseUrl: string, apiKey: string): string | null {
  const sep = apiKey.indexOf(':');
  if (sep <= 0) return null;
  const accountId = apiKey.slice(0, sep);
  return baseUrl.replace('{accountId}', accountId);
}

function resolveProbeProvider(
  provider: ProviderToggle,
  overrides?: { apiKey?: string | null; baseUrl?: string | null; model?: string | null }
): { provider: ProviderToggle; model: string; error?: string } {
  const catalog = getCatalogEntry(provider.id);
  let apiKey: string | null =
    overrides?.apiKey !== undefined ? overrides.apiKey : provider.apiKey;
  let baseUrl =
    overrides?.baseUrl !== undefined ? overrides.baseUrl : provider.baseUrl;

  if (provider.authStyle === 'account_token' && baseUrl?.includes('{accountId}')) {
    if (!apiKey) {
      return {
        provider,
        model: '',
        error: 'Cloudflare key must be account_id:api_token',
      };
    }
    const resolved = resolveCloudflareBaseUrl(baseUrl, apiKey);
    if (!resolved) {
      return {
        provider,
        model: '',
        error: 'Cloudflare key must be account_id:api_token',
      };
    }
    baseUrl = resolved;
    const sep = apiKey.indexOf(':');
    apiKey = apiKey.slice(sep + 1);
  }

  const model =
    overrides?.model ||
    provider.benchmarkModel ||
    provider.defaultModel ||
    catalog?.defaultModel ||
    null;

  if (!model) {
    return { provider, model: '', error: 'benchmark model required' };
  }

  const keyless =
    provider.protocol === 'keyless' ||
    provider.authStyle === 'none' ||
    catalog?.keyless === true;

  const probe: ProviderToggle = {
    ...provider,
    baseUrl,
    apiKey: keyless ? apiKey || '0000000000' : apiKey,
    defaultModel: model,
  };

  return { provider: probe, model };
}

/**
 * Probe upstream with a tiny chat completion. Persists nothing — caller writes DB.
 */
export async function verifyProvider(
  provider: ProviderToggle,
  overrides?: { apiKey?: string | null; baseUrl?: string | null; benchmarkModel?: string | null }
): Promise<VerifyResult> {
  const started = Date.now();

  if (!isChatProtocolReady(provider.protocol, provider.catalogReady)) {
    return {
      ok: false,
      verifyStatus: 'unsupported',
      verifyError: truncateError(
        `protocol_not_ready: ${provider.protocol} (adapter planned; cannot enable yet)`
      ),
      verifiedAt: null,
      enabled: false,
      latencyMs: Date.now() - started,
      model: overrides?.benchmarkModel ?? provider.benchmarkModel ?? provider.defaultModel,
    };
  }

  // Demo / custom without baseUrl: local demo path — treat as ok if no baseUrl needed
  if (
    (provider.id === 'subscription-demo' || provider.id === 'free-pool') &&
    !provider.baseUrl &&
    !(overrides?.baseUrl)
  ) {
    return {
      ok: true,
      verifyStatus: 'ok',
      verifyError: null,
      verifiedAt: Date.now(),
      enabled: true,
      latencyMs: Date.now() - started,
      model: provider.defaultModel,
    };
  }

  const resolved = resolveProbeProvider(provider, {
    apiKey: overrides?.apiKey,
    baseUrl: overrides?.baseUrl,
    model: overrides?.benchmarkModel ?? undefined,
  });
  if (resolved.error) {
    return {
      ok: false,
      verifyStatus: 'fail',
      verifyError: truncateError(resolved.error),
      verifiedAt: null,
      enabled: false,
      latencyMs: Date.now() - started,
      model: null,
    };
  }

  if (!resolved.provider.baseUrl) {
    return {
      ok: false,
      verifyStatus: 'fail',
      verifyError: 'baseUrl required',
      verifiedAt: null,
      enabled: false,
      latencyMs: Date.now() - started,
      model: resolved.model,
    };
  }

  const needsKey =
    resolved.provider.protocol !== 'keyless' &&
    resolved.provider.authStyle !== 'none';
  if (needsKey && !resolved.provider.apiKey) {
    return {
      ok: false,
      verifyStatus: 'fail',
      verifyError: 'apiKey required',
      verifiedAt: null,
      enabled: false,
      latencyMs: Date.now() - started,
      model: resolved.model,
    };
  }

  const timeoutMs = provider.timeoutMs ?? getCatalogEntry(provider.id)?.timeoutMs ?? 15_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const result = await dispatchChat(
      resolved.provider,
      {
        model: resolved.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: Math.max(16, 1),
        stream: false,
      },
      ac.signal
    );

    if (!result.ok) {
      const detail =
        result.error ||
        (typeof result.body === 'object' && result.body && 'error' in (result.body as object)
          ? JSON.stringify((result.body as { error?: unknown }).error)
          : `HTTP ${result.status}`);
      return {
        ok: false,
        verifyStatus: 'fail',
        verifyError: truncateError(`${result.status}: ${detail}`),
        verifiedAt: null,
        enabled: false,
        latencyMs: Date.now() - started,
        model: resolved.model,
      };
    }

    return {
      ok: true,
      verifyStatus: 'ok',
      verifyError: null,
      verifiedAt: Date.now(),
      enabled: true,
      latencyMs: Date.now() - started,
      model: resolved.model,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      verifyStatus: 'fail',
      verifyError: truncateError(message),
      verifiedAt: null,
      enabled: false,
      latencyMs: Date.now() - started,
      model: resolved.model,
    };
  } finally {
    clearTimeout(timer);
  }
}
