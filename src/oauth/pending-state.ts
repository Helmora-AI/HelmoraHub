import type Database from 'better-sqlite3';
import { decryptOAuthPayload, encryptOAuthPayload } from './crypto.js';
import { hashOAuthState } from './pkce.js';
import { ensureOAuthVaultSchema } from './vault.js';

export const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;

export type PendingOAuthRow = {
  stateHash: string;
  providerId: string;
  codeVerifier: string;
  initiatingSessionId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  returnPath: string;
};

export function oauthPendingAad(stateHash: string): Buffer {
  return Buffer.from(`oauth_pending|${stateHash}`, 'utf8');
}

export type CreatePendingInput = {
  statePlain: string;
  providerId: string;
  codeVerifier: string;
  initiatingSessionId: string;
  encryptionKey: string;
  returnPath?: string;
  ttlMs?: number;
  now?: number;
};

export function createPending(db: Database.Database, input: CreatePendingInput): PendingOAuthRow {
  ensureOAuthVaultSchema(db);
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? PENDING_OAUTH_TTL_MS;
  const stateHash = hashOAuthState(input.statePlain);
  const returnPath = input.returnPath ?? '/providers';
  const expiresAt = now + ttlMs;
  const encryptedVerifier = encryptOAuthPayload(
    input.codeVerifier,
    input.encryptionKey,
    oauthPendingAad(stateHash)
  );

  db.prepare(
    `INSERT INTO oauth_pending_states
      (state_hash, provider_id, encrypted_verifier, initiating_session_id,
       created_at, expires_at, consumed_at, return_path)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    stateHash,
    input.providerId,
    encryptedVerifier,
    input.initiatingSessionId,
    now,
    expiresAt,
    returnPath
  );

  return {
    stateHash,
    providerId: input.providerId,
    codeVerifier: input.codeVerifier,
    initiatingSessionId: input.initiatingSessionId,
    createdAt: now,
    expiresAt,
    consumedAt: null,
    returnPath,
  };
}

/**
 * Atomically consume a pending state: only if not consumed and not expired.
 * Returns the decrypted row, or null if missing / expired / already consumed.
 */
export function consumePending(
  db: Database.Database,
  statePlain: string,
  encryptionKey: string,
  now = Date.now()
): PendingOAuthRow | null {
  ensureOAuthVaultSchema(db);
  const stateHash = hashOAuthState(statePlain);

  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT state_hash, provider_id, encrypted_verifier, initiating_session_id,
                created_at, expires_at, consumed_at, return_path
         FROM oauth_pending_states
         WHERE state_hash = ?`
      )
      .get(stateHash) as
      | {
          state_hash: string;
          provider_id: string;
          encrypted_verifier: string;
          initiating_session_id: string;
          created_at: number;
          expires_at: number;
          consumed_at: number | null;
          return_path: string;
        }
      | undefined;

    if (!row) return null;
    if (row.consumed_at != null) return null;
    if (row.expires_at <= now) return null;

    const result = db
      .prepare(
        `UPDATE oauth_pending_states
         SET consumed_at = ?
         WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`
      )
      .run(now, stateHash, now);

    if (result.changes === 0) return null;

    const codeVerifier = decryptOAuthPayload(
      row.encrypted_verifier,
      encryptionKey,
      oauthPendingAad(row.state_hash)
    );

    return {
      stateHash: row.state_hash,
      providerId: row.provider_id,
      codeVerifier,
      initiatingSessionId: row.initiating_session_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: now,
      returnPath: row.return_path,
    } satisfies PendingOAuthRow;
  });

  return tx();
}

/** Delete expired (and optionally already-consumed) pending rows. */
export function purgeExpired(db: Database.Database, now = Date.now()): number {
  ensureOAuthVaultSchema(db);
  return db
    .prepare(
      `DELETE FROM oauth_pending_states
       WHERE expires_at <= ? OR consumed_at IS NOT NULL`
    )
    .run(now).changes;
}
