import { ProcessQuota, BoundedTtlCache, type QuotaReservation } from './tool-limits.js';
import { executeWithToolRetry } from './tool-retry.js';
import { tinyFishSearch, validateWebSearchInput } from '../tools/connectors/tinyfish-search.js';
import { tinyFishFetch, validateWebFetchInput } from '../tools/connectors/tinyfish-fetch.js';
import {
  TinyFishConnectorError,
  type FetchLike,
} from '../tools/connectors/tinyfish-client.js';
import type { NormalizedToolResult, RegisteredToolId, ToolRuntimeConfig } from '../tools/types.js';
import type { DnsAddress, DnsLookup } from '../tools/url-policy.js';
import { boundedUtf8 } from '../tools/validation.js';

export type TinyFishConnectorHealth = {
  status: 'ready' | 'degraded' | 'throttled' | 'credentials_required';
  lastErrorCode: string | null;
  lastOccurredAt: number | null;
};

export type ToolExecutionResult = {
  result: NormalizedToolResult;
  cacheHits: number;
  attempts: number;
};

export const TINYFISH_SEARCH_TIMEOUT_MS = 10_000;
export const TINYFISH_FETCH_TIMEOUT_MS = 115_000;

export class ToolRateLimitError extends TinyFishConnectorError {
  constructor(
    public readonly remaining: number,
    public readonly required: number,
    public readonly retryAfterMs: number,
  ) {
    super('tool_rate_limited', 'The local TinyFish quota is exhausted.', 429, false, retryAfterMs);
  }
}

function quotaOrThrow(reservation: QuotaReservation): void {
  if (!reservation.ok) {
    throw new ToolRateLimitError(
      reservation.remaining,
      reservation.required,
      reservation.retryAfterMs,
    );
  }
}

function resultBytes(result: NormalizedToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function copyResult(result: NormalizedToolResult): NormalizedToolResult {
  return structuredClone(result);
}

function mergeFetchResults(results: NormalizedToolResult[]): NormalizedToolResult {
  const fullContent = results.map((result) => result.content).filter(Boolean).join('\n\n---\n\n');
  const content = boundedUtf8(fullContent, 64 * 1_024);
  return {
    content: content.value,
    structuredContent: {
      items: results.map((result) => result.structuredContent ?? {}),
    },
    sources: results.flatMap((result) => result.sources),
    truncated: content.truncated || results.some((result) => result.truncated),
  };
}

export class TinyFishToolExecutor {
  private readonly searchQuota: ProcessQuota;
  private readonly fetchQuota: ProcessQuota;
  private readonly searchCache: BoundedTtlCache<NormalizedToolResult>;
  private readonly fetchCache: BoundedTtlCache<NormalizedToolResult>;
  private health: TinyFishConnectorHealth = {
    status: 'ready',
    lastErrorCode: null,
    lastOccurredAt: null,
  };

  constructor(private readonly options: {
    config: ToolRuntimeConfig;
    apiKey: string;
    fetchImpl?: FetchLike;
    lookup?: DnsLookup;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
  }) {
    const profile = options.config.connectors.tinyfish;
    const clock = options.now;
    this.searchQuota = new ProcessQuota({
      limit: profile.searchRequestsPerMinute,
      now: clock,
    });
    this.fetchQuota = new ProcessQuota({
      limit: profile.fetchUrlsPerMinute,
      now: clock,
    });
    this.searchCache = new BoundedTtlCache({
      maxEntries: 100,
      maxEntryBytes: 128 * 1_024,
      maxTotalBytes: 4 * 1_024 * 1_024,
      now: clock,
    });
    this.fetchCache = new BoundedTtlCache({
      maxEntries: 200,
      maxEntryBytes: 128 * 1_024,
      maxTotalBytes: 16 * 1_024 * 1_024,
      now: clock,
    });
  }

  getHealth(): TinyFishConnectorHealth {
    return { ...this.health };
  }

  getQuotaState(): { searchRemaining: number; fetchRemaining: number } {
    return {
      searchRemaining: this.searchQuota.remaining(),
      fetchRemaining: this.fetchQuota.remaining(),
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private markFailure(error: unknown): void {
    const code = error instanceof TinyFishConnectorError ? error.code : 'tool_execution_failed';
    this.health = {
      status: code === 'invalid_credentials'
        ? 'credentials_required'
        : code === 'rate_limited' || code === 'tool_rate_limited'
          ? 'throttled'
          : 'degraded',
      lastErrorCode: code,
      lastOccurredAt: this.now(),
    };
  }

  private markReady(): void {
    this.health = { ...this.health, status: 'ready' };
  }

  private reserve(quota: ProcessQuota, amount: number): void {
    try {
      quotaOrThrow(quota.tryReserve(amount));
    } catch (error) {
      this.markFailure(error);
      throw error;
    }
  }

  private async withRetry<T>(attempt: (attempt: number) => Promise<T>, signal?: AbortSignal) {
    return executeWithToolRetry({
      attempt: async (number) => {
        try {
          const value = await attempt(number);
          this.markReady();
          return value;
        } catch (error) {
          this.markFailure(error);
          throw error;
        }
      },
      signal,
      now: this.options.now,
      sleep: this.options.sleep,
      random: this.options.random,
    });
  }

  async execute(
    toolId: RegisteredToolId,
    input: unknown,
    execution: { bypassCache?: boolean; signal?: AbortSignal } = {},
  ): Promise<ToolExecutionResult> {
    if (toolId === 'web_search') return this.executeSearch(input, execution);
    if (toolId === 'web_fetch') return this.executeFetch(input, execution);
    throw new TinyFishConnectorError('tool_unavailable', 'Tool is not registered.', null, false);
  }

  private async executeSearch(
    input: unknown,
    execution: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<ToolExecutionResult> {
    const normalized = validateWebSearchInput(input);
    const key = `tinyfish:search:v1:${JSON.stringify(normalized)}`;
    const cached = execution.bypassCache ? undefined : this.searchCache.get(key);
    if (cached) return { result: copyResult(cached), cacheHits: 1, attempts: 0 };

    const outcome = await this.withRetry(async () => {
      this.reserve(this.searchQuota, 1);
      return tinyFishSearch({
        apiKey: this.options.apiKey,
        input: normalized,
        fetchImpl: this.options.fetchImpl,
        timeoutMs: TINYFISH_SEARCH_TIMEOUT_MS,
        signal: execution.signal,
      });
    }, execution.signal);
    if (!execution.bypassCache) {
      this.searchCache.set(key, copyResult(outcome.value), {
        ttlMs: this.options.config.connectors.tinyfish.searchCacheSeconds * 1_000,
        sizeBytes: resultBytes(outcome.value),
      });
    }
    return { result: outcome.value, cacheHits: 0, attempts: outcome.attempts };
  }

  private memoizedLookup(): DnsLookup | undefined {
    if (!this.options.lookup) return undefined;
    const values = new Map<string, Promise<readonly DnsAddress[]>>();
    return (hostname) => {
      let pending = values.get(hostname);
      if (!pending) {
        pending = this.options.lookup!(hostname);
        values.set(hostname, pending);
      }
      return pending;
    };
  }

  private async executeFetch(
    input: unknown,
    execution: { bypassCache?: boolean; signal?: AbortSignal },
  ): Promise<ToolExecutionResult> {
    const lookup = this.memoizedLookup();
    const normalized = await validateWebFetchInput(input, { lookup });
    const cachedResults = new Map<string, NormalizedToolResult>();
    const misses = normalized.targets.filter((target) => {
      if (execution.bypassCache) return true;
      const key = `tinyfish:fetch:v1:${normalized.format}:${target.url}`;
      const cached = this.fetchCache.get(key);
      if (!cached) return true;
      cachedResults.set(target.url, copyResult(cached));
      return false;
    });
    if (misses.length > 0) this.reserve(this.fetchQuota, misses.length);

    const outcomes = await Promise.all(misses.map(async (target) => {
      const outcome = await this.withRetry(async (attempt) => {
        if (attempt > 1) this.reserve(this.fetchQuota, 1);
        return tinyFishFetch({
          apiKey: this.options.apiKey,
          input: { urls: [target.url], format: normalized.format },
          lookup,
          fetchImpl: this.options.fetchImpl,
          timeoutMs: TINYFISH_FETCH_TIMEOUT_MS,
          signal: execution.signal,
        });
      }, execution.signal);
      if (!execution.bypassCache && target.cacheable) {
        this.fetchCache.set(
          `tinyfish:fetch:v1:${normalized.format}:${target.url}`,
          copyResult(outcome.value),
          {
            ttlMs: this.options.config.connectors.tinyfish.fetchCacheSeconds * 1_000,
            sizeBytes: resultBytes(outcome.value),
          },
        );
      }
      return { url: target.url, ...outcome };
    }));

    const fresh = new Map(outcomes.map((outcome) => [outcome.url, outcome.value]));
    const ordered = normalized.targets.map((target) => cachedResults.get(target.url) ?? fresh.get(target.url));
    if (ordered.some((result) => !result)) {
      throw new TinyFishConnectorError('tool_execution_failed', 'Fetch result was incomplete.', null, false);
    }
    return {
      result: mergeFetchResults(ordered as NormalizedToolResult[]),
      cacheHits: cachedResults.size,
      attempts: outcomes.reduce((total, outcome) => total + outcome.attempts, 0),
    };
  }
}
