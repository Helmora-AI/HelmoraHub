import { describe, expect, it } from 'vitest';
import {
  SetupAttemptLimiter,
  verifySetupToken,
} from '../lib/setup-token.js';

describe('setup token verification', () => {
  it('accepts only the exact configured value', () => {
    const configured = 'a'.repeat(64);
    expect(verifySetupToken(configured, configured)).toBe(true);
    expect(verifySetupToken(configured, 'a'.repeat(63))).toBe(false);
    expect(verifySetupToken(configured, 'b'.repeat(64))).toBe(false);
    expect(verifySetupToken(configured, undefined)).toBe(false);
  });
});

describe('process-local setup limiter', () => {
  it('allows ten attempts per socket source in one fifteen-minute window', () => {
    const limiter = new SetupAttemptLimiter();
    const now = Date.parse('2026-07-16T00:00:00.000Z');

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(limiter.consume('127.0.0.1', now)).toEqual({ allowed: true });
    }
    expect(limiter.consume('127.0.0.1', now)).toEqual({
      allowed: false,
      retryAfterSeconds: 900,
    });
    expect(limiter.consume('127.0.0.2', now)).toEqual({ allowed: true });
  });

  it('applies the process-wide bound and reports the later applicable reset', () => {
    const limiter = new SetupAttemptLimiter();
    const start = Date.parse('2026-07-16T00:00:00.000Z');

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const source = `source-${attempt}`;
      expect(limiter.consume(source, start + attempt * 1000)).toEqual({
        allowed: true,
      });
    }
    expect(limiter.consume('source-99', start + 100_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 800,
    });
  });

  it('clears all process and source state after successful setup', () => {
    const limiter = new SetupAttemptLimiter();
    const now = Date.parse('2026-07-16T00:00:00.000Z');
    for (let attempt = 0; attempt < 11; attempt += 1) {
      limiter.consume('source', now);
    }
    limiter.clear();
    expect(limiter.consume('source', now)).toEqual({ allowed: true });
  });
});
