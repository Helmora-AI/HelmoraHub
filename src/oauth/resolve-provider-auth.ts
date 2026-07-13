import type { ProviderToggle } from '../types.js';
import { getActiveConfig } from '../lib/config.js';
import { getConfigStore } from '../storage/index.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import { createOAuthCore } from './create-core.js';
import { getBundle } from './vault.js';
import { getOAuthHandler } from './registry.js';
import type { OAuthTokenBundle } from './types.js';
import { CLAUDE_OAUTH_BETA } from './handlers/claude-config.js';

/**
 * Ensure OAuth bundle is fresh (singleflight refresh when near expiry).
 */
export async function ensureFreshBundle(
  providerId: string
): Promise<OAuthTokenBundle | null> {
  const store = getConfigStore();
  if (!(store instanceof SqliteConfigStore)) return null;

  const config = getActiveConfig();
  const encryptionKey = config.encryptionKey?.trim();
  if (!encryptionKey) return null;

  const db = store.getOAuthVault().getDatabase();
  const handler = getOAuthHandler(providerId);
  let bundle = getBundle(db, providerId, encryptionKey);
  if (!bundle) return null;

  if (handler?.supportsRefresh && handler.shouldRefresh(bundle, Date.now())) {
    try {
      const core = createOAuthCore();
      await core.refreshOAuth(providerId);
      bundle = getBundle(db, providerId, encryptionKey);
    } catch {
      // Soft failure — proceed with existing bundle; hard fail sets needs_reconnect in core.
      bundle = getBundle(db, providerId, encryptionKey);
    }
  }

  return bundle;
}

/**
 * Resolve active auth for upstream calls.
 * For oauth mode, injects accessToken into apiKey so existing adapters can run.
 */
export async function resolveProviderAuth(
  provider: ProviderToggle
): Promise<ProviderToggle> {
  if (provider.authMode !== 'oauth') return provider;

  const bundle = await ensureFreshBundle(provider.id);
  if (!bundle?.accessToken) {
    return { ...provider, apiKey: null };
  }

  const extraHeaders: Record<string, string> = {
    ...(provider.extraHeaders ?? {}),
  };
  if (provider.id === 'claude') {
    extraHeaders['anthropic-beta'] = CLAUDE_OAUTH_BETA;
  }

  return {
    ...provider,
    apiKey: bundle.accessToken,
    extraHeaders,
  };
}
