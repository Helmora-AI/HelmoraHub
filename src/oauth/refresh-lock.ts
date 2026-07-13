/**
 * Per-providerId singleflight for OAuth refresh.
 * Waiters share the same Promise; CAS persist happens inside the runner.
 */

const inflight = new Map<string, Promise<unknown>>();

export function withRefreshSingleflight<T>(
  providerId: string,
  run: () => Promise<T>
): Promise<T> {
  const existing = inflight.get(providerId);
  if (existing) return existing as Promise<T>;

  const promise = run().finally(() => {
    if (inflight.get(providerId) === promise) {
      inflight.delete(providerId);
    }
  });

  inflight.set(providerId, promise);
  return promise;
}

/** Clear locks (tests). */
export function clearRefreshLocks(): void {
  inflight.clear();
}

export type OAuthRefreshErrorLike = {
  code?: string;
  error?: string;
  status?: number;
  statusCode?: number;
  message?: string;
};

/**
 * Hard failures force `needs_reconnect` (invalid_grant, revoked, definitive 401).
 * Soft/transient (timeout, DNS, 429, 5xx) keep the bundle and do not force reconnect.
 */
export function isHardOAuthRefreshError(err: unknown): boolean {
  if (err == null) return false;

  const e = err as OAuthRefreshErrorLike;
  const code = String(e.code ?? e.error ?? '').toLowerCase();
  if (
    code === 'invalid_grant' ||
    code === 'revoked' ||
    code === 'needs_reconnect' ||
    code === 'unauthorized_client'
  ) {
    return true;
  }

  const status = e.status ?? e.statusCode;
  if (status === 401) return true;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('invalid_grant') || msg.includes('token revoked')) return true;
  }

  return false;
}

export function isSoftOAuthRefreshError(err: unknown): boolean {
  if (isHardOAuthRefreshError(err)) return false;
  if (err == null) return false;

  const e = err as OAuthRefreshErrorLike;
  const status = e.status ?? e.statusCode;
  if (status != null && status >= 500) return true;
  if (status === 429) return true;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('network')
    ) {
      return true;
    }
  }

  // Default unknown non-hard errors to soft (keep bundle).
  return true;
}
