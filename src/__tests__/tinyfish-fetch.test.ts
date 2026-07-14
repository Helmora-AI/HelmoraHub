import { describe, expect, it, vi } from 'vitest';
import {
  tinyFishFetch,
  validateWebFetchInput,
} from '../tools/connectors/tinyfish-fetch.js';
import {
  redactFetchUrlForDisplay,
  validatePublicHttpsUrl,
  type DnsLookup,
} from '../tools/url-policy.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const publicDns: DnsLookup = vi.fn(async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
]);

describe('TinyFish Fetch URL policy', () => {
  it('canonicalizes public HTTPS targets, strips fragments, and redacts activity URLs', async () => {
    const target = await validatePublicHttpsUrl(
      'https://Example.COM/docs?q=public&token=secret#section',
      { lookup: publicDns },
    );

    expect(target.url).toBe('https://example.com/docs?q=public&token=secret');
    expect(target.displayUrl).toBe('https://example.com/docs?[redacted]');
    expect(target.cacheable).toBe(false);
    expect(redactFetchUrlForDisplay(target.url)).toBe(target.displayUrl);

    const ipv6 = await validatePublicHttpsUrl(
      'https://[2606:2800:220:1:248:1893:25c8:1946]/',
      { lookup: publicDns },
    );
    expect(ipv6.url).toBe('https://[2606:2800:220:1:248:1893:25c8:1946]/');
  });

  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com:8443',
    'https://localhost.',
    'https://127.0.0.1',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://2130706433',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://xn--80ak6aa92e.com',
  ])('rejects an unsafe target before connector dispatch: %s', async (url) => {
    await expect(validatePublicHttpsUrl(url, { lookup: publicDns })).rejects.toMatchObject({
      code: 'tool_invalid_arguments',
    });
  });

  it('rejects a hostname when any current DNS answer is non-public', async () => {
    const lookup: DnsLookup = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);

    await expect(validatePublicHttpsUrl('https://rebind.example/path', { lookup })).rejects.toMatchObject({
      code: 'unsafe_fetch_target',
    });
    expect(lookup).toHaveBeenCalledWith('rebind.example');
  });
});

describe('TinyFish Fetch connector', () => {
  it('validates 1-10 URLs and posts only the bounded Search + Fetch Free projection', async () => {
    const lookup: DnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{
        url: 'https://example.com/a#old',
        final_url: 'https://www.example.com/final?ref=1#new',
        title: 'Example',
        description: 'Public page',
        text: '# Hello',
        format: 'markdown',
      }],
      errors: [],
    }));

    const result = await tinyFishFetch({
      apiKey: 'tf-secret-key',
      input: { urls: ['https://example.com/a#old'], format: 'markdown' },
      lookup,
      fetchImpl,
      timeoutMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImpl.mock.calls[0]!;
    expect(String(requestUrl)).toBe('https://api.fetch.tinyfish.ai/');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': 'tf-secret-key',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      urls: ['https://example.com/a'],
      format: 'markdown',
    });
    expect(result.sources).toEqual([{
      title: 'Example',
      url: 'https://www.example.com/final?ref=1',
      snippet: 'Public page',
    }]);
    expect(JSON.stringify(result)).not.toContain('tf-secret-key');
    expect(lookup).toHaveBeenCalledWith('example.com');
    expect(lookup).toHaveBeenCalledWith('www.example.com');
  });

  it('rejects malformed batches and unknown fields before network I/O', async () => {
    const fetchImpl = vi.fn();
    await expect(validateWebFetchInput({ urls: [] }, { lookup: publicDns })).rejects.toMatchObject({
      code: 'tool_invalid_arguments',
    });
    await expect(validateWebFetchInput({
      urls: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`),
    }, { lookup: publicDns })).rejects.toMatchObject({ code: 'tool_invalid_arguments' });
    await expect(validateWebFetchInput({
      urls: ['https://example.com'],
      format: 'html',
    }, { lookup: publicDns })).rejects.toMatchObject({ code: 'tool_invalid_arguments' });
    await expect(validateWebFetchInput({
      urls: ['https://example.com'],
      links: true,
    }, { lookup: publicDns })).rejects.toMatchObject({ code: 'tool_invalid_arguments' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing credential before DNS or connector network work', async () => {
    const lookup: DnsLookup = vi.fn();
    const fetchImpl = vi.fn();

    await expect(tinyFishFetch({
      apiKey: ' ',
      input: { urls: ['https://example.com'] },
      lookup,
      fetchImpl,
    })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unsafe redirect reported by TinyFish instead of exposing its content', async () => {
    const lookup: DnsLookup = vi.fn(async (hostname) => hostname === 'example.com'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '10.0.0.4', family: 4 }]);
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{
        url: 'https://example.com',
        final_url: 'https://internal.example/admin',
        title: 'Internal',
        description: null,
        text: 'secret',
        format: 'markdown',
      }],
      errors: [],
    }));

    await expect(tinyFishFetch({
      apiKey: 'tf-key',
      input: { urls: ['https://example.com'] },
      lookup,
      fetchImpl,
    })).rejects.toMatchObject({ code: 'unsafe_redirect_target' });
  });

  it('bounds Markdown/JSON content and keeps per-URL errors free of sensitive query strings', async () => {
    const long = '🚀'.repeat(20_000);
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [
        {
          url: 'https://example.com/markdown',
          final_url: 'https://example.com/markdown',
          title: long,
          description: long,
          text: long,
          format: 'markdown',
        },
        {
          url: 'https://example.com/json',
          final_url: 'https://example.com/json',
          title: 'JSON',
          description: null,
          text: { heading: 'Safe object', ignored: long },
          format: 'json',
        },
      ],
      errors: [{
        url: 'https://example.com/private?token=super-secret',
        error: 'target_unreachable',
      }],
    }));

    const result = await tinyFishFetch({
      apiKey: 'tf-key',
      input: {
        urls: [
          'https://example.com/markdown',
          'https://example.com/json',
          'https://example.com/private?token=super-secret',
        ],
      },
      lookup: publicDns,
      fetchImpl,
    });

    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(64 * 1_024);
    expect(result.sources).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(result.structuredContent).toMatchObject({
      errors: [{
        url: 'https://example.com/private?[redacted]',
        code: 'target_unreachable',
      }],
    });
  });
});
