import { describe, expect, it } from 'vitest';
import { normalizeCrossModelRetry } from '../services/tier-router.js';

describe('normalizeCrossModelRetry', () => {
  it.each([
    [{ status: 0, error: 'fetch failed: network error' }, 'network', 'degraded'],
    [{ status: 504, error: 'request timeout' }, 'network', 'degraded'],
    [{ status: 429, error: 'rate limited' }, 'rate_limited', 'degraded'],
    [{ status: 503, error: 'upstream unavailable' }, 'upstream_unavailable', 'degraded'],
    [{ status: 401, error: 'invalid api key' }, 'invalid_credentials', 'invalid_credentials'],
    [{ status: 403, error: 'forbidden' }, 'invalid_credentials', 'invalid_credentials'],
    [{ status: 404, error: 'model not found' }, 'model_missing', 'degraded'],
  ] as const)('retries %o as %s', (input, reason, healthEffect) => {
    expect(normalizeCrossModelRetry(input)).toEqual({
      retryable: true,
      reason,
      healthEffect,
    });
  });

  it.each([
    [{ status: 400, error: 'invalid request body' }, 'request_invalid'],
    [{ status: 422, error: 'unsupported option: logprobs' }, 'unsupported_request'],
    [{ status: 400, error: 'maximum context length exceeded' }, 'context_limit'],
  ] as const)('stops %o as %s', (input, reason) => {
    expect(normalizeCrossModelRetry(input)).toEqual({
      retryable: false,
      reason,
      healthEffect: 'none',
    });
  });
});
