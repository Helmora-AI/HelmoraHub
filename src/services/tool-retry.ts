import { TinyFishConnectorError } from '../tools/connectors/tinyfish-client.js';

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new TinyFishConnectorError('tool_aborted', 'Tool request was cancelled.', null, false));
    return;
  }
  const cleanup = () => signal?.removeEventListener('abort', abort);
  const timeout = setTimeout(() => {
    cleanup();
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timeout);
    cleanup();
    reject(new TinyFishConnectorError('tool_aborted', 'Tool request was cancelled.', null, false));
  };
  signal?.addEventListener('abort', abort, { once: true });
});

export async function executeWithToolRetry<T>(options: {
  attempt: (attempt: number) => Promise<T>;
  maxAttempts?: number;
  maxWallClockMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: Sleep;
  random?: () => number;
}): Promise<{ value: T; attempts: number }> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 5));
  const maxWallClockMs = Math.max(1, options.maxWallClockMs ?? 30_000);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const startedAt = now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new TinyFishConnectorError('tool_aborted', 'Tool request was cancelled.', null, false);
    }
    try {
      return { value: await options.attempt(attempt), attempts: attempt };
    } catch (error) {
      if (
        !(error instanceof TinyFishConnectorError)
        || !error.retryable
        || attempt >= maxAttempts
      ) throw error;
      const exponential = 250 * (2 ** (attempt - 1));
      const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 100);
      const delayMs = error.retryAfterMs ?? exponential + jitter;
      if (now() - startedAt + delayMs >= maxWallClockMs) throw error;
      await sleep(delayMs, options.signal);
    }
  }
  throw new TinyFishConnectorError('tool_execution_failed', 'Tool retry budget exhausted.', null, false);
}
