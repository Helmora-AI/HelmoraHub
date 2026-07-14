import { describe, expect, it, vi } from 'vitest';
import { ProcessQuota, BoundedTtlCache } from '../services/tool-limits.js';
import { executeWithToolRetry } from '../services/tool-retry.js';
import { TinyFishConnectorError } from '../tools/connectors/tinyfish-client.js';
import { TinyFishToolExecutor } from '../services/tool-executor.js';
import type { ToolRuntimeConfig } from '../tools/types.js';

function runtimeConfig(overrides: Partial<ToolRuntimeConfig['connectors']['tinyfish']> = {}): ToolRuntimeConfig {
  return {
    version: 1,
    enabled: true,
    orchestrator: { primaryCatalogId: null, fallbackCatalogId: null },
    connectors: {
      tinyfish: {
        enabled: true,
        searchRequestsPerMinute: 25,
        fetchUrlsPerMinute: 120,
        searchCacheSeconds: 60,
        fetchCacheSeconds: 300,
        ...overrides,
      },
    },
    toolOverrides: [],
  };
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('process-local tool limits', () => {
  it('reserves a Fetch URL batch atomically and reports the exact retry boundary', () => {
    let now = 10_000;
    const quota = new ProcessQuota({ limit: 5, windowMs: 60_000, now: () => now });

    expect(quota.tryReserve(3)).toEqual({ ok: true, remaining: 2 });
    expect(quota.tryReserve(3)).toEqual({
      ok: false,
      remaining: 2,
      required: 3,
      retryAfterMs: 60_000,
    });
    expect(quota.remaining()).toBe(2);

    now += 60_000;
    expect(quota.tryReserve(5)).toEqual({ ok: true, remaining: 0 });
  });

  it('waits until enough staggered quota expires for the entire atomic batch', () => {
    let now = 0;
    const quota = new ProcessQuota({ limit: 5, windowMs: 60_000, now: () => now });
    expect(quota.tryReserve(2).ok).toBe(true);
    now = 10_000;
    expect(quota.tryReserve(2).ok).toBe(true);
    expect(quota.tryReserve(4)).toEqual({
      ok: false,
      remaining: 1,
      required: 4,
      retryAfterMs: 60_000,
    });
  });

  it('keeps cache entries bounded by TTL, entry bytes, total bytes, and LRU count', () => {
    let now = 1_000;
    const cache = new BoundedTtlCache<string>({
      maxEntries: 2,
      maxEntryBytes: 5,
      maxTotalBytes: 8,
      now: () => now,
    });

    expect(cache.set('a', 'one', { ttlMs: 100, sizeBytes: 3 })).toBe(true);
    expect(cache.set('b', 'two', { ttlMs: 100, sizeBytes: 3 })).toBe(true);
    expect(cache.get('a')).toBe('one'); // touches a, so b is least recently used
    expect(cache.set('c', 'tri', { ttlMs: 100, sizeBytes: 3 })).toBe(true);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('one');
    expect(cache.set('large', 'oversized', { ttlMs: 100, sizeBytes: 9 })).toBe(false);

    now += 101;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('bounded connector retry', () => {
  it('honors Retry-After and retries only within attempt and wall-clock budgets', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const attempt = vi.fn()
      .mockRejectedValueOnce(new TinyFishConnectorError(
        'rate_limited',
        'TinyFish rate limit exceeded.',
        429,
        true,
        1_500,
      ))
      .mockResolvedValue('ok');

    const result = await executeWithToolRetry({
      attempt,
      maxAttempts: 3,
      maxWallClockMs: 5_000,
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(result).toEqual({ value: 'ok', attempts: 2 });
    expect(sleeps).toEqual([1_500]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry deterministic failures or sleep beyond the wall-clock budget', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const deterministic = vi.fn(async () => {
      throw new TinyFishConnectorError('upstream_invalid_request', 'Rejected.', 400, false);
    });
    await expect(executeWithToolRetry({
      attempt: deterministic,
      now: () => now,
      sleep,
    })).rejects.toMatchObject({ code: 'upstream_invalid_request' });
    expect(deterministic).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();

    const throttled = vi.fn(async () => {
      throw new TinyFishConnectorError('rate_limited', 'Throttled.', 429, true, 2_000);
    });
    await expect(executeWithToolRetry({
      attempt: throttled,
      maxAttempts: 3,
      maxWallClockMs: 1_000,
      now: () => now,
      sleep,
      random: () => 0,
    })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(throttled).toHaveBeenCalledOnce();
  });
});

describe('TinyFish tool executor', () => {
  it('serves Search cache hits before quota reservation or upstream execution', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      query: 'current release',
      results: [{ title: 'Release', snippet: 'Current', url: 'https://example.com/release' }],
    }));
    const executor = new TinyFishToolExecutor({
      config: runtimeConfig(),
      apiKey: 'tf-key',
      fetchImpl,
    });

    const first = await executor.execute('web_search', { query: 'current release' });
    const cached = await executor.execute('web_search', { query: 'current release' });

    expect(first).toMatchObject({ cacheHits: 0, attempts: 1 });
    expect(cached).toMatchObject({ cacheHits: 1, attempts: 0 });
    expect(cached.result).toEqual(first.result);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(executor.getQuotaState()).toMatchObject({ searchRemaining: 24 });
  });

  it('reserves every uncached Fetch URL atomically and reuses per-URL cache entries', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      const target = body.urls[0]!;
      return jsonResponse({
        results: [{
          url: target,
          final_url: target,
          title: new URL(target).pathname,
          description: null,
          text: `Content for ${target}`,
          format: 'markdown',
        }],
        errors: [],
      });
    });
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const executor = new TinyFishToolExecutor({
      config: runtimeConfig({ fetchUrlsPerMinute: 3 }),
      apiKey: 'tf-key',
      fetchImpl,
      lookup,
    });

    await executor.execute('web_fetch', { urls: ['https://example.com/a'] });
    const mixed = await executor.execute('web_fetch', {
      urls: [
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
      ],
    });

    expect(mixed).toMatchObject({ cacheHits: 1, attempts: 2 });
    expect(mixed.result.sources).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(executor.getQuotaState()).toMatchObject({ fetchRemaining: 0 });
  });

  it('rejects an over-budget Fetch batch before any partial upstream work', async () => {
    const fetchImpl = vi.fn();
    const executor = new TinyFishToolExecutor({
      config: runtimeConfig({ fetchUrlsPerMinute: 2 }),
      apiKey: 'tf-key',
      fetchImpl,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    await expect(executor.execute('web_fetch', {
      urls: [
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c',
      ],
    })).rejects.toMatchObject({
      code: 'tool_rate_limited',
      remaining: 2,
      required: 3,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executor.getHealth()).toMatchObject({
      status: 'throttled',
      lastErrorCode: 'tool_rate_limited',
    });
  });

  it('records throttled health, honors Retry-After, and recovers without losing diagnostics', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { 'Retry-After': '0.5' },
      }))
      .mockResolvedValueOnce(jsonResponse({ query: 'news', results: [] }));
    const executor = new TinyFishToolExecutor({
      config: runtimeConfig(),
      apiKey: 'tf-key',
      fetchImpl,
      now: () => now,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    const execution = await executor.execute('web_search', { query: 'news' });

    expect(execution.attempts).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(executor.getHealth()).toEqual({
      status: 'ready',
      lastErrorCode: 'rate_limited',
      lastOccurredAt: 0,
    });
  });
});
