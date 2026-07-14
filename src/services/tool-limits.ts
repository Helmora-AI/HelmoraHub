export type QuotaReservation =
  | { ok: true; remaining: number }
  | { ok: false; remaining: number; required: number; retryAfterMs: number };

export class ProcessQuota {
  private readonly reservations: Array<{ at: number; amount: number }> = [];

  constructor(private readonly options: {
    limit: number;
    windowMs?: number;
    now?: () => number;
  }) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError('Quota limit must be a positive integer.');
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private windowMs(): number {
    return this.options.windowMs ?? 60_000;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs();
    while (this.reservations[0] && this.reservations[0].at <= cutoff) {
      this.reservations.shift();
    }
  }

  private used(): number {
    return this.reservations.reduce((total, reservation) => total + reservation.amount, 0);
  }

  remaining(): number {
    this.prune(this.now());
    return Math.max(0, this.options.limit - this.used());
  }

  tryReserve(required: number): QuotaReservation {
    if (!Number.isInteger(required) || required < 1) {
      throw new RangeError('Quota reservation must be a positive integer.');
    }
    const now = this.now();
    this.prune(now);
    const remaining = Math.max(0, this.options.limit - this.used());
    if (required > remaining) {
      const deficit = required - remaining;
      let released = 0;
      let retryAfterMs = this.windowMs();
      for (const reservation of this.reservations) {
        released += reservation.amount;
        retryAfterMs = Math.max(1, reservation.at + this.windowMs() - now);
        if (released >= deficit) break;
      }
      return {
        ok: false,
        remaining,
        required,
        retryAfterMs,
      };
    }
    this.reservations.push({ at: now, amount: required });
    return { ok: true, remaining: remaining - required };
  }
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  sizeBytes: number;
};

export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;

  constructor(private readonly options: {
    maxEntries: number;
    maxEntryBytes: number;
    maxTotalBytes: number;
    now?: () => number;
  }) {}

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.sizeBytes;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, input: { ttlMs: number; sizeBytes: number }): boolean {
    if (
      !Number.isFinite(input.ttlMs)
      || input.ttlMs <= 0
      || !Number.isInteger(input.sizeBytes)
      || input.sizeBytes < 0
      || input.sizeBytes > this.options.maxEntryBytes
      || input.sizeBytes > this.options.maxTotalBytes
    ) return false;
    this.pruneExpired();
    this.remove(key);
    while (
      this.entries.size >= this.options.maxEntries
      || this.totalBytes + input.sizeBytes > this.options.maxTotalBytes
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    if (this.entries.size >= this.options.maxEntries) return false;
    this.entries.set(key, {
      value,
      expiresAt: this.now() + input.ttlMs,
      sizeBytes: input.sizeBytes,
    });
    this.totalBytes += input.sizeBytes;
    return true;
  }
}
