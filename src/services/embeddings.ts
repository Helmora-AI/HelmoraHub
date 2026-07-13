import type { ProviderToggle } from '../types.js';
import { resolveUpstreamAuth } from '../providers/resolve-auth.js';
import { createHash } from 'node:crypto';
import { listProviders } from '../db/index.js';
import { isChatProtocolReady } from '../providers/catalog/index.js';

export type EmbeddingsRequest = {
  model?: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
};

export type EmbeddingsResult = {
  ok: boolean;
  status: number;
  providerId: string;
  model: string;
  body: unknown;
  error?: string;
  usage: { prompt_tokens: number; total_tokens: number };
};

function normalizeInputs(input: string | string[]): string[] {
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((s) => String(s)).filter((s) => s.length > 0);
}

function estimateTokens(texts: string[]): number {
  const chars = texts.reduce((a, t) => a + t.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Deterministic demo embedding when no upstream is configured. */
export function demoEmbeddingVector(text: string, dims = 8): number[] {
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    const h = createHash('sha256').update(`${text}::${i}`).digest();
    const n = h.readUInt32BE(0) / 0xffffffff;
    out.push(Number((n * 2 - 1).toFixed(6)));
  }
  return out;
}

export function demoEmbeddingsResponse(
  providerId: string,
  model: string,
  texts: string[]
): EmbeddingsResult {
  const data = texts.map((t, i) => ({
    object: 'embedding',
    index: i,
    embedding: demoEmbeddingVector(t),
  }));
  const prompt_tokens = estimateTokens(texts);
  return {
    ok: true,
    status: 200,
    providerId,
    model,
    body: {
      object: 'list',
      data,
      model,
      usage: { prompt_tokens, total_tokens: prompt_tokens },
    },
    usage: { prompt_tokens, total_tokens: prompt_tokens },
  };
}

async function callOpenAIEmbeddings(
  provider: ProviderToggle,
  model: string,
  texts: string[],
  dimensions: number | undefined,
  signal?: AbortSignal
): Promise<EmbeddingsResult> {
  const auth = resolveUpstreamAuth(provider);
  if (auth.error || !auth.baseUrl) {
    return {
      ok: false,
      status: 503,
      providerId: provider.id,
      model,
      body: null,
      error: auth.error ?? 'no_base_url',
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  }

  const url = `${auth.baseUrl.replace(/\/$/, '')}/embeddings`;
  const payload: Record<string, unknown> = {
    model,
    input: texts.length === 1 ? texts[0] : texts,
    encoding_format: 'float',
  };
  if (dimensions != null) payload.dimensions = dimensions;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        providerId: provider.id,
        model,
        body,
        error: `upstream_${res.status}`,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    }
    const usageObj =
      body && typeof body === 'object' && 'usage' in body
        ? (body as { usage?: { prompt_tokens?: number; total_tokens?: number } }).usage
        : null;
    const prompt_tokens =
      usageObj?.prompt_tokens ?? usageObj?.total_tokens ?? estimateTokens(texts);
    return {
      ok: true,
      status: 200,
      providerId: provider.id,
      model,
      body,
      usage: {
        prompt_tokens,
        total_tokens: usageObj?.total_tokens ?? prompt_tokens,
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
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  }
}

/**
 * Route embeddings through enabled OpenAI-compatible providers.
 * Falls back to deterministic demo vectors when no upstream succeeds.
 */
export async function routeEmbeddings(
  request: EmbeddingsRequest,
  signal?: AbortSignal
): Promise<EmbeddingsResult> {
  const texts = normalizeInputs(request.input);
  if (texts.length === 0) {
    return {
      ok: false,
      status: 400,
      providerId: 'none',
      model: request.model ?? 'embedding',
      body: {
        error: {
          message: 'input is required (string or non-empty array of strings)',
          type: 'invalid_request_error',
        },
      },
      error: 'empty_input',
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  }
  if (texts.length > 64) {
    return {
      ok: false,
      status: 400,
      providerId: 'none',
      model: request.model ?? 'embedding',
      body: {
        error: {
          message: 'input array may contain at most 64 strings',
          type: 'invalid_request_error',
        },
      },
      error: 'input_too_large',
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  }

  const providers = (await listProviders()).filter(
    (p) =>
      p.enabled &&
      p.baseUrl &&
      isChatProtocolReady(p.protocol, p.catalogReady) &&
      (p.protocol === 'openai' ||
        p.protocol === 'keyless' ||
        p.protocol === 'custom' ||
        p.protocol === 'oauth')
  );

  const model =
    request.model?.trim() ||
    providers[0]?.defaultModel ||
    'text-embedding-3-small';

  for (const provider of providers) {
    const result = await callOpenAIEmbeddings(
      provider,
      model,
      texts,
      request.dimensions,
      signal
    );
    if (result.ok) return result;
  }

  // Demo path — always available for smoke / offline
  return demoEmbeddingsResponse('demo-embeddings', model, texts);
}
