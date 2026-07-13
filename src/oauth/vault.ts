import type Database from 'better-sqlite3';
import {
  decryptOAuthPayload,
  encryptOAuthPayload,
  oauthBundleAad,
} from './crypto.js';
import type { OAuthTokenBundle } from './types.js';

/** Matches `enc:oauth:v1:` payload prefix. */
export const OAUTH_ENCRYPTION_VERSION = 1;

type CredentialRow = {
  provider_id: string;
  encrypted_bundle: string;
  encryption_version: number;
  schema_version: number;
  connected_at: number;
  refreshed_at: number | null;
  updated_at: number;
  credential_version: number;
};

export function ensureOAuthVaultSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_oauth_credentials (
      provider_id TEXT PRIMARY KEY,
      encrypted_bundle TEXT NOT NULL,
      encryption_version INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      connected_at INTEGER NOT NULL,
      refreshed_at INTEGER,
      updated_at INTEGER NOT NULL,
      credential_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS oauth_pending_states (
      state_hash TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      encrypted_verifier TEXT NOT NULL,
      initiating_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      return_path TEXT NOT NULL DEFAULT '/providers'
    );

    CREATE INDEX IF NOT EXISTS oauth_pending_states_expires_idx
      ON oauth_pending_states (expires_at)
      WHERE consumed_at IS NULL;
  `);
}

/**
 * Idempotent backfill: rows with a non-empty api_key and auth_mode='none' → 'api_key'.
 * Never sets auth_mode='oauth'.
 */
export function backfillAuthMode(db: Database.Database): void {
  db.exec(`
    UPDATE providers
    SET auth_mode = 'api_key'
    WHERE auth_mode = 'none'
      AND api_key IS NOT NULL
      AND trim(api_key) != ''
  `);
}

export function putBundle(
  db: Database.Database,
  providerId: string,
  bundle: OAuthTokenBundle,
  encryptionKey: string,
  now = Date.now()
): number {
  const aad = oauthBundleAad(providerId, bundle.schemaVersion);
  const encrypted = encryptOAuthPayload(JSON.stringify(bundle), encryptionKey, aad);
  const existing = db
    .prepare('SELECT connected_at, credential_version FROM provider_oauth_credentials WHERE provider_id = ?')
    .get(providerId) as { connected_at: number; credential_version: number } | undefined;

  if (existing) {
    const nextVersion = existing.credential_version + 1;
    db.prepare(
      `UPDATE provider_oauth_credentials SET
        encrypted_bundle = ?,
        encryption_version = ?,
        schema_version = ?,
        refreshed_at = ?,
        updated_at = ?,
        credential_version = ?
       WHERE provider_id = ?`
    ).run(
      encrypted,
      OAUTH_ENCRYPTION_VERSION,
      bundle.schemaVersion,
      now,
      now,
      nextVersion,
      providerId
    );
    return nextVersion;
  }

  db.prepare(
    `INSERT INTO provider_oauth_credentials
      (provider_id, encrypted_bundle, encryption_version, schema_version,
       connected_at, refreshed_at, updated_at, credential_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    providerId,
    encrypted,
    OAUTH_ENCRYPTION_VERSION,
    bundle.schemaVersion,
    now,
    now,
    now
  );
  return 1;
}

/** CAS upsert: updates only when current credential_version === expectedVersion. */
export function putBundleIfVersion(
  db: Database.Database,
  providerId: string,
  bundle: OAuthTokenBundle,
  expectedVersion: number,
  encryptionKey: string,
  now = Date.now()
): boolean {
  const aad = oauthBundleAad(providerId, bundle.schemaVersion);
  const encrypted = encryptOAuthPayload(JSON.stringify(bundle), encryptionKey, aad);

  if (expectedVersion === 0) {
    try {
      db.prepare(
        `INSERT INTO provider_oauth_credentials
          (provider_id, encrypted_bundle, encryption_version, schema_version,
           connected_at, refreshed_at, updated_at, credential_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        providerId,
        encrypted,
        OAUTH_ENCRYPTION_VERSION,
        bundle.schemaVersion,
        now,
        now,
        now
      );
      return true;
    } catch {
      return false;
    }
  }

  const result = db
    .prepare(
      `UPDATE provider_oauth_credentials SET
        encrypted_bundle = ?,
        encryption_version = ?,
        schema_version = ?,
        refreshed_at = ?,
        updated_at = ?,
        credential_version = credential_version + 1
       WHERE provider_id = ? AND credential_version = ?`
    )
    .run(
      encrypted,
      OAUTH_ENCRYPTION_VERSION,
      bundle.schemaVersion,
      now,
      now,
      providerId,
      expectedVersion
    );
  return result.changes > 0;
}

export function getBundle(
  db: Database.Database,
  providerId: string,
  encryptionKey: string
): OAuthTokenBundle | null {
  const row = db
    .prepare(
      `SELECT provider_id, encrypted_bundle, schema_version
       FROM provider_oauth_credentials WHERE provider_id = ?`
    )
    .get(providerId) as Pick<
    CredentialRow,
    'provider_id' | 'encrypted_bundle' | 'schema_version'
  > | undefined;
  if (!row) return null;

  const aad = oauthBundleAad(row.provider_id, row.schema_version);
  const plain = decryptOAuthPayload(row.encrypted_bundle, encryptionKey, aad);
  return JSON.parse(plain) as OAuthTokenBundle;
}

export function deleteBundle(db: Database.Database, providerId: string): boolean {
  return (
    db.prepare('DELETE FROM provider_oauth_credentials WHERE provider_id = ?').run(providerId)
      .changes > 0
  );
}

export function getCredentialVersion(
  db: Database.Database,
  providerId: string
): number | null {
  const row = db
    .prepare('SELECT credential_version FROM provider_oauth_credentials WHERE provider_id = ?')
    .get(providerId) as { credential_version: number } | undefined;
  return row?.credential_version ?? null;
}

/** Thin helper bound to a db + encryption key (for SqliteConfigStore / tests). */
export class OAuthVault {
  constructor(
    private readonly db: Database.Database,
    private readonly encryptionKey: string
  ) {
    ensureOAuthVaultSchema(this.db);
  }

  /** Exposed for pending-state + OAuthCore (same SQLite connection). */
  getDatabase(): Database.Database {
    return this.db;
  }

  putBundle(providerId: string, bundle: OAuthTokenBundle, now = Date.now()): number {
    return putBundle(this.db, providerId, bundle, this.encryptionKey, now);
  }

  putBundleIfVersion(
    providerId: string,
    bundle: OAuthTokenBundle,
    expectedVersion: number,
    now = Date.now()
  ): boolean {
    return putBundleIfVersion(
      this.db,
      providerId,
      bundle,
      expectedVersion,
      this.encryptionKey,
      now
    );
  }

  getBundle(providerId: string): OAuthTokenBundle | null {
    return getBundle(this.db, providerId, this.encryptionKey);
  }

  deleteBundle(providerId: string): boolean {
    return deleteBundle(this.db, providerId);
  }

  getCredentialVersion(providerId: string): number | null {
    return getCredentialVersion(this.db, providerId);
  }
}
