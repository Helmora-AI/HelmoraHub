import { getActiveConfig } from '../lib/config.js';
import { getConfigStore } from '../storage/index.js';
import { SqliteConfigStore } from '../storage/sqlite-store.js';
import { OAuthCore } from './core.js';
import type { OAuthRuntimeState, ProviderAuthMode } from './credential-flags.js';

function requireOAuthUrls(): { publicUrl: string; frontendUrl: string; encryptionKey: string } {
  const config = getActiveConfig();
  const publicUrl = config.publicUrl?.trim();
  const frontendUrl = config.frontendUrl?.trim();
  const encryptionKey = config.encryptionKey?.trim();
  if (!publicUrl) {
    throw Object.assign(new Error('HELMORA_PUBLIC_URL is not configured'), {
      status: 503,
      code: 'oauth_misconfigured',
    });
  }
  if (!frontendUrl) {
    throw Object.assign(new Error('HELMORA_FRONTEND_URL is not configured'), {
      status: 503,
      code: 'oauth_misconfigured',
    });
  }
  if (!encryptionKey) {
    throw Object.assign(new Error('ENCRYPTION_KEY is required for OAuth'), {
      status: 503,
      code: 'oauth_misconfigured',
    });
  }
  return { publicUrl, frontendUrl, encryptionKey };
}

/** Build core with sync provider flag helpers bound to the sqlite store. */
export function createOAuthCore(): OAuthCore {
  const store = getConfigStore();
  if (!(store instanceof SqliteConfigStore)) {
    throw Object.assign(new Error('OAuth requires local SQLite storage'), {
      status: 503,
      code: 'oauth_unavailable',
    });
  }
  const { publicUrl, frontendUrl, encryptionKey } = requireOAuthUrls();
  const vault = store.getOAuthVault();
  const db = vault.getDatabase();

  return new OAuthCore({
    db,
    encryptionKey,
    publicUrl,
    frontendUrl,
    setProviderOAuthFlags: (providerId, flags) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (flags.authMode != null) {
        sets.push('auth_mode = ?');
        vals.push(flags.authMode);
      }
      if (flags.oauthState != null) {
        sets.push('oauth_state = ?');
        vals.push(flags.oauthState);
      }
      if (sets.length === 0) return;
      vals.push(providerId);
      db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    getProviderOAuthSnapshot: (providerId) => {
      const row = db
        .prepare('SELECT enabled, auth_mode, oauth_state FROM providers WHERE id = ?')
        .get(providerId) as
        | { enabled: number; auth_mode: string; oauth_state: string }
        | undefined;
      if (!row) return null;
      return {
        enabled: Boolean(row.enabled),
        authMode: row.auth_mode as ProviderAuthMode,
        oauthState: row.oauth_state as OAuthRuntimeState,
      };
    },
  });
}
