import type { ProviderToggle } from '../types.js';

/** Resolve dynamic base URL + bearer token (e.g. Cloudflare account_id:token). */
export function resolveUpstreamAuth(provider: ProviderToggle): {
  baseUrl: string | null;
  apiKey: string | null;
  error?: string;
} {
  let baseUrl = provider.baseUrl;
  let apiKey = provider.apiKey;

  if (provider.authStyle === 'account_token' && baseUrl?.includes('{accountId}')) {
    if (!apiKey || !apiKey.includes(':')) {
      return {
        baseUrl: null,
        apiKey: null,
        error: 'Cloudflare key must be account_id:api_token',
      };
    }
    const sep = apiKey.indexOf(':');
    const accountId = apiKey.slice(0, sep);
    apiKey = apiKey.slice(sep + 1);
    baseUrl = baseUrl.replace('{accountId}', accountId);
  }

  return { baseUrl, apiKey };
}
