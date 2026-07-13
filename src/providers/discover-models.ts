import type { ProviderToggle } from '../types.js';
import { resolveUpstreamAuth } from './resolve-auth.js';

export type DiscoveredModel = {
  id: string;
  ownedBy: string | null;
};

export type DiscoverModelsResult = {
  models: DiscoveredModel[];
  source: string;
  error?: string;
  unsupported?: boolean;
};

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

function fromOpenAiList(body: unknown): DiscoveredModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const id = String((row as { id?: unknown }).id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = (row as { owned_by?: unknown }).owned_by;
    out.push({
      id,
      ownedBy: ownedBy == null ? null : String(ownedBy),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function fromGeminiList(body: unknown): DiscoveredModel[] {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const row of models) {
    if (!row || typeof row !== 'object') continue;
    let name = String((row as { name?: unknown }).name ?? '').trim();
    if (name.startsWith('models/')) name = name.slice('models/'.length);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: name, ownedBy: 'google' });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Probe upstream model list for openai-compatible + gemini providers. */
export async function discoverProviderModels(
  provider: ProviderToggle
): Promise<DiscoverModelsResult> {
  const timeoutMs = Math.min(Math.max(provider.timeoutMs ?? 20_000, 5_000), 60_000);
  const auth = resolveUpstreamAuth(provider);

  if (auth.error) {
    return { models: [], source: 'none', error: auth.error };
  }

  const protocol = provider.protocol;
  const supportsOpenAiList =
    protocol === 'openai' ||
    protocol === 'keyless' ||
    protocol === 'custom' ||
    protocol === 'local';

  if (protocol === 'gemini') {
    if (!auth.baseUrl) {
      return {
        models: [],
        source: 'gemini',
        error: 'Provider baseUrl is required to discover Gemini models',
      };
    }
    if (!auth.apiKey && provider.authStyle === 'query-key') {
      return {
        models: [],
        source: 'gemini',
        error: 'Credential required to discover Gemini models',
      };
    }
    const root = normalizeBase(auth.baseUrl).replace(/\/v1beta$/i, '');
    const url = new URL(`${root}/v1beta/models`);
    if (auth.apiKey) url.searchParams.set('key', auth.apiKey);
    url.searchParams.set('pageSize', '100');
    const res = await fetchJson(url.toString(), { Accept: 'application/json' }, timeoutMs);
    if (!res.ok) {
      return {
        models: [],
        source: 'gemini',
        error: `Upstream ${res.status}: ${res.text.slice(0, 200)}`,
      };
    }
    return { models: fromGeminiList(res.body), source: 'gemini' };
  }

  if (!supportsOpenAiList) {
    return {
      models: [],
      source: protocol,
      unsupported: true,
      error:
        'This protocol does not expose a model list API. Add model ids manually and pin them.',
    };
  }

  if (!auth.baseUrl) {
    return {
      models: [],
      source: 'openai',
      error: 'Provider baseUrl is required to discover models',
    };
  }

  const base = normalizeBase(auth.baseUrl);
  const url = `${base}/models`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(provider.extraHeaders ?? {}),
  };
  if (auth.apiKey) {
    if (provider.authStyle === 'x-api-key') headers['x-api-key'] = auth.apiKey;
    else headers.Authorization = `Bearer ${auth.apiKey}`;
  }

  const res = await fetchJson(url, headers, timeoutMs);
  if (!res.ok) {
    return {
      models: [],
      source: 'openai',
      error: `Upstream ${res.status}: ${res.text.slice(0, 200)}`,
    };
  }
  return { models: fromOpenAiList(res.body), source: 'openai' };
}
