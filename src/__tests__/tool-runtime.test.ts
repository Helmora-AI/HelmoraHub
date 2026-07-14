import { describe, expect, it, vi } from 'vitest';
import { ProcessQuota, BoundedTtlCache } from '../services/tool-limits.js';
import { executeWithToolRetry } from '../services/tool-retry.js';
import { TinyFishConnectorError } from '../tools/connectors/tinyfish-client.js';

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
