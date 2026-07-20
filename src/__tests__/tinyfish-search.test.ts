import { describe, expect, it, vi } from 'vitest';
import {
  TinyFishConnectorError,
  tinyFishSearch,
  validateWebSearchInput,
} from '../tools/connectors/tinyfish-search.js';
import {
  applyWebSearchContextDefaults,
  deriveWebSearchContextHints,
} from '../tools/search-context.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TinyFish Search connector', () => {
  it('adds Vietnamese locale and recent-news defaults without overriding explicit filters', () => {
    expect(applyWebSearchContextDefaults(
      { query: 'ti so chung ket World Cup 2026' },
      deriveWebSearchContextHints('Ti so tran chung ket World Cup 2026 hom qua la bao nhieu?'),
    )).toEqual({
      query: 'ti so chung ket World Cup 2026',
      location: 'VN',
      language: 'vi',
      recencyMinutes: 4_320,
      domainType: 'news',
      purpose: 'Find recent authoritative sources that directly verify this time-sensitive fact.',
    });
    expect(applyWebSearchContextDefaults(
      { query: 'gia xang', location: 'SG', language: 'en', afterDate: '2026-07-19' },
      deriveWebSearchContextHints('Gia xang hom nay'),
    )).toEqual({
      query: 'gia xang',
      location: 'SG',
      language: 'en',
      afterDate: '2026-07-19',
      purpose: 'Find recent authoritative sources that directly verify this time-sensitive fact.',
    });
  });
  it('accepts the published TinyFish recency and purpose bounds', () => {
    expect(validateWebSearchInput({
      query: 'release history',
      recencyMinutes: 5_256_000,
      purpose: 'x'.repeat(2_000),
    })).toMatchObject({ recencyMinutes: 5_256_000 });

    expect(() => validateWebSearchInput({
      query: 'release history',
      recencyMinutes: 5_256_001,
    })).toThrowError(expect.objectContaining({ code: 'tool_invalid_arguments' }));
  });
  it('emits only the canonical endpoint, allowlisted parameters, and server API key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      query: 'latest TypeScript release',
      page: 0,
      total_results: 1,
      results: [{
        position: 1,
        site_name: 'typescriptlang.org',
        title: 'TypeScript',
        snippet: 'Typed JavaScript at any scale.',
        url: 'https://www.typescriptlang.org/',
        date: '2026-07-19',
        publisher: 'TypeScript Team',
      }],
    }));

    const result = await tinyFishSearch({
      apiKey: 'tf-secret-key',
      input: {
        query: 'latest TypeScript release',
        location: 'US',
        language: 'en',
        page: 0,
        recencyMinutes: 60,
        domainType: 'web',
        purpose: 'Answer with current release notes',
      },
      fetchImpl,
      timeoutMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.origin + url.pathname).toBe('https://api.search.tinyfish.ai/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: 'latest TypeScript release',
      location: 'US',
      language: 'en',
      page: '0',
      recency_minutes: '60',
      domain_type: 'web',
      purpose: 'Answer with current release notes',
    });
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', 'X-API-Key': 'tf-secret-key' },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result.sources).toEqual([{
      title: 'TypeScript',
      url: 'https://www.typescriptlang.org/',
      snippet: 'Typed JavaScript at any scale.',
      publishedAt: '2026-07-19',
      publisher: 'TypeScript Team',
    }]);
    expect(result.content).toContain('Published: 2026-07-19');
    expect(result.content).toContain('Publisher: TypeScript Team');
    expect(JSON.stringify(result)).not.toContain('tf-secret-key');
  });

  it('rejects conflicting freshness filters and oversized inputs before network I/O', async () => {
    const fetchImpl = vi.fn();
    expect(() => validateWebSearchInput({
      query: 'news',
      recencyMinutes: 60,
      afterDate: '2026-01-01',
    })).toThrowError(expect.objectContaining({ code: 'conflicting_freshness_filters' }));
    expect(() => validateWebSearchInput({ query: 'x'.repeat(2_001) })).toThrowError(
      expect.objectContaining({ code: 'tool_invalid_arguments' })
    );
    expect(() => validateWebSearchInput({ query: 'ok', page: 11 })).toThrow();
    expect(() => validateWebSearchInput({ query: 'ok', afterDate: '2026-13-40' })).toThrow();
    expect(() => validateWebSearchInput({
      query: 'paper',
      domainType: 'research_paper',
      recencyMinutes: 60,
    })).toThrowError(expect.objectContaining({ code: 'conflicting_freshness_filters' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizes and bounds sources while dropping unsafe or malformed result URLs', async () => {
    const long = 'a'.repeat(70_000);
    const fetchImpl = vi.fn(async () => jsonResponse({
      query: 'bounded',
      results: [
        { position: 2, title: long, snippet: long, url: 'https://example.com/path' },
        { position: 1, title: 'Unsafe', snippet: 'drop', url: 'javascript:alert(1)' },
        { position: 3, title: 'Credentials', snippet: 'drop', url: 'https://user:pass@example.com' },
      ],
      total_results: 3,
    }));

    const result = await tinyFishSearch({
      apiKey: 'tf-key',
      input: { query: 'bounded' },
      fetchImpl,
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.title?.length).toBeLessThanOrEqual(500);
    expect(result.sources[0]!.snippet?.length).toBeLessThanOrEqual(2_000);
    expect(result.content.length).toBeLessThanOrEqual(64 * 1_024);
    expect(result.truncated).toBe(true);
  });

  it('returns redacted normalized errors without reading or exposing upstream bodies', async () => {
    const response = new Response(JSON.stringify({ error: 'tf-key-secret upstream details' }), {
      status: 401,
    });
    const textSpy = vi.spyOn(response, 'text');
    const fetchImpl = vi.fn(async () => response);

    let caught: unknown;
    try {
      await tinyFishSearch({
        apiKey: 'tf-key-secret',
        input: { query: 'hello' },
        fetchImpl,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TinyFishConnectorError);
    expect(caught).toMatchObject({ code: 'invalid_credentials', status: 401, retryable: false });
    expect(JSON.stringify(caught)).not.toContain('tf-key-secret');
    expect(textSpy).not.toHaveBeenCalled();
  });

  it.each([
    [429, 'rate_limited'],
    [503, 'upstream_unavailable'],
  ])('normalizes Retry-After on retryable HTTP %s for the bounded retry layer', async (status, code) => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status,
      headers: { 'Retry-After': '1.5' },
    }));

    await expect(tinyFishSearch({
      apiKey: 'tf-key',
      input: { query: 'hello' },
      fetchImpl,
    })).rejects.toMatchObject({
      code,
      retryAfterMs: 1_500,
    });
  });

  it('aborts through the root signal before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(tinyFishSearch({
      apiKey: 'tf-key',
      input: { query: 'hello' },
      fetchImpl,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'tool_aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
