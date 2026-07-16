import { createHash, randomBytes } from 'node:crypto';
import { getActiveConfig } from './config.js';
import {
  getAdminAuthStore,
  type AdminSessionKind,
  type StoredAdminSession,
} from './admin-auth-store.js';
import { HEL_SESSION_PREFIX, isHelSessionToken } from './hel-env.js';

export type PreparedAdminSession = {
  token: string;
  expiresAt: string;
  record: StoredAdminSession;
};

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sessionTtlSec(): number {
  return getActiveConfig().sessionTtlSec;
}

export function prepareAdminSession(
  kind: AdminSessionKind,
  now = Date.now()
): PreparedAdminSession {
  const token = `${HEL_SESSION_PREFIX}${randomBytes(32).toString('hex')}`;
  const expiresAtMs = now + sessionTtlSec() * 1000;
  return {
    token,
    expiresAt: new Date(expiresAtMs).toISOString(),
    record: {
      hash: hashSessionToken(token),
      kind,
      createdAt: now,
      expiresAt: expiresAtMs,
    },
  };
}

export function issueAdminSession(
  kind: AdminSessionKind = 'spa'
): { token: string; expiresAt: string } {
  const config = getActiveConfig();
  const prepared = prepareAdminSession(kind);
  const store = getAdminAuthStore(config.dataDir);
  store.pruneExpired(Date.now(), 100);
  store.insertSession(prepared.record);
  return { token: prepared.token, expiresAt: prepared.expiresAt };
}

export type SessionVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

export function verifyAdminSession(
  token: string | null | undefined,
  expectedKind?: AdminSessionKind
): SessionVerifyResult {
  if (!token?.trim()) return { ok: false, reason: 'missing' };
  const trimmed = token.trim();
  if (!isHelSessionToken(trimmed)) return { ok: false, reason: 'invalid' };

  const config = getActiveConfig();
  const store = getAdminAuthStore(config.dataDir);
  const hash = hashSessionToken(trimmed);
  const session = store.readSession(hash);
  if (!session) return { ok: false, reason: 'invalid' };
  if (session.expiresAt <= Date.now()) {
    store.deleteSessions([hash]);
    store.pruneExpired(Date.now(), 100);
    return { ok: false, reason: 'expired' };
  }
  if (expectedKind && session.kind !== expectedKind) {
    return { ok: false, reason: 'invalid' };
  }
  store.pruneExpired(Date.now(), 100);
  return { ok: true };
}

export function revokeAdminSessions(tokens: Array<string | null | undefined>): number {
  const config = getActiveConfig();
  const hashes = tokens
    .map((token) => token?.trim())
    .filter((token): token is string => Boolean(token))
    .map(hashSessionToken);
  return getAdminAuthStore(config.dataDir).deleteSessions(hashes);
}

export function revokeAdminSession(token: string | null | undefined): boolean {
  return revokeAdminSessions([token]) > 0;
}
