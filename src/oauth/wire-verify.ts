import { getActiveConfig } from '../lib/config.js';
import { getConfigStore } from '../storage/index.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import { getBundle } from './vault.js';
import { getOAuthHandler } from './registry.js';
import { setOAuthVerifyProcessor } from './verify-queue.js';

let wired = false;

/**
 * Wire Hub-side OAuth verify processor once.
 * Callback enqueues; processor calls handler.verify and updates oauth_state + verifyStatus.
 * SPA refetch must not call verify on load.
 */
export function ensureOAuthVerifyProcessorWired(): void {
  if (wired) return;
  wired = true;

  setOAuthVerifyProcessor(async (providerId) => {
    const store = getConfigStore();
    if (!(store instanceof SqliteConfigStore)) return;

    const config = getActiveConfig();
    const encryptionKey = config.encryptionKey?.trim();
    if (!encryptionKey) return;

    const handler = getOAuthHandler(providerId);
    if (!handler) return;

    const db = store.getOAuthVault().getDatabase();
    const bundle = getBundle(db, providerId, encryptionKey);
    if (!bundle) {
      await store.updateProvider(providerId, {
        oauthState: 'needs_reconnect',
        verifyStatus: 'fail',
        verifyError: 'oauth_bundle_missing',
        verifiedAt: Date.now(),
      });
      return;
    }

    const result = await handler.verify(bundle);
    await store.updateProvider(providerId, {
      oauthState: result.ok ? 'connected' : 'needs_reconnect',
      verifyStatus: result.ok ? 'ok' : 'fail',
      verifyError: result.ok ? null : result.error ?? 'oauth_verify_failed',
      verifiedAt: Date.now(),
      // Do not flip admin enabled — verify success does not auto-enable.
    });
  });
}

/** Test helper — allow re-wire after clear. */
export function resetOAuthVerifyProcessorWired(): void {
  wired = false;
  setOAuthVerifyProcessor(null);
}
