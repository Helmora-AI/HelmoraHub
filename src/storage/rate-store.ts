import { createClient, type RedisClientType } from 'redis';
import { HEL_REDIS_PREFIX } from '../lib/hel-env.js';
import type { RateStore } from './types.js';

type CooldownEntry = { until: number };
type StickyEntry = { providerId: string; until: number };

export class MemoryRateStore implements RateStore {
  readonly backend = 'memory' as const;
  private cooldowns = new Map<string, CooldownEntry>();
  private rpm = new Map<string, { count: number; resetAt: number }>();
  private sticky = new Map<string, StickyEntry>();

  async isCoolingDown(providerId: string): Promise<boolean> {
    const entry = this.cooldowns.get(providerId);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      this.cooldowns.delete(providerId);
      return false;
    }
    return true;
  }

  async setCooldown(providerId: string, ttlSeconds: number): Promise<void> {
    this.cooldowns.set(providerId, { until: Date.now() + ttlSeconds * 1000 });
  }

  async incrRpm(providerId: string, windowSeconds = 60): Promise<number> {
    const now = Date.now();
    const key = providerId;
    const cur = this.rpm.get(key);
    if (!cur || now >= cur.resetAt) {
      this.rpm.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  }

  async getSticky(sessionKey: string): Promise<string | null> {
    const entry = this.sticky.get(sessionKey);
    if (!entry) return null;
    if (Date.now() >= entry.until) {
      this.sticky.delete(sessionKey);
      return null;
    }
    return entry.providerId;
  }

  async setSticky(sessionKey: string, providerId: string, ttlSeconds = 1800): Promise<void> {
    this.sticky.set(sessionKey, {
      providerId,
      until: Date.now() + ttlSeconds * 1000,
    });
  }

  async close(): Promise<void> {
    this.cooldowns.clear();
    this.rpm.clear();
    this.sticky.clear();
  }
}

export class RedisRateStore implements RateStore {
  readonly backend = 'redis' as const;
  private client: RedisClientType;
  private prefix: string;

  private constructor(client: RedisClientType, prefix = HEL_REDIS_PREFIX) {
    this.client = client;
    this.prefix = prefix;
  }

  static async connect(redisUrl: string, prefix = HEL_REDIS_PREFIX): Promise<RedisRateStore> {
    const client = createClient({ url: redisUrl }) as RedisClientType;
    client.on('error', (err) => {
      console.error('[redis]', err);
    });
    await client.connect();
    return new RedisRateStore(client, prefix);
  }

  private key(...parts: string[]): string {
    return [this.prefix, ...parts].join(':');
  }

  async isCoolingDown(providerId: string): Promise<boolean> {
    const exists = await this.client.exists(this.key('cooldown', providerId));
    return exists > 0;
  }

  async setCooldown(providerId: string, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key('cooldown', providerId), '1', { EX: Math.max(1, ttlSeconds) });
  }

  async incrRpm(providerId: string, windowSeconds = 60): Promise<number> {
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const k = this.key('rpm', providerId, String(bucket));
    const count = await this.client.incr(k);
    if (count === 1) {
      await this.client.expire(k, windowSeconds + 5);
    }
    return count;
  }

  async getSticky(sessionKey: string): Promise<string | null> {
    return this.client.get(this.key('sticky', sessionKey));
  }

  async setSticky(sessionKey: string, providerId: string, ttlSeconds = 1800): Promise<void> {
    await this.client.set(this.key('sticky', sessionKey), providerId, {
      EX: Math.max(1, ttlSeconds),
    });
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}
