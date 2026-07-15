import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getActiveConfig } from './config.js';
import {
  HEL_RECOVERY_SESSION_PREFIX,
  isHelRecoverySessionToken,
} from './hel-env.js';

export const RECOVERY_SESSION_AUDIENCE = 'helmora-recovery' as const;
export const RECOVERY_SESSION_TTL_SEC = 15 * 60;

type RecoverySessionRecord = {
  hash: string;
  aud: typeof RECOVERY_SESSION_AUDIENCE;
  createdAt: number;
  expiresAt: number;
};

type RecoverySessionFile = { sessions: RecoverySessionRecord[] };

function isRecoverySessionRecord(value: unknown): value is RecoverySessionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<RecoverySessionRecord>;
  return (
    typeof record.hash === 'string' &&
    record.aud === RECOVERY_SESSION_AUDIENCE &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  );
}

function recoverySessionsPath(dataDir: string): string {
  return path.join(dataDir, 'recovery-sessions.json');
}

function readSessions(dataDir: string): RecoverySessionFile {
  const file = recoverySessionsPath(dataDir);
  if (!fs.existsSync(file)) return { sessions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RecoverySessionFile;
    return {
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.filter(isRecoverySessionRecord)
        : [],
    };
  } catch {
    return { sessions: [] };
  }
}

function writeSessions(dataDir: string, value: RecoverySessionFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    recoverySessionsPath(dataDir),
    JSON.stringify(value, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );
}

function hashSession(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashEquals(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    if (a.length !== 32 || b.length !== 32) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type RecoverySessionVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

export function issueRecoverySession(): {
  token: string;
  scope: 'recovery';
  expiresAt: string;
} {
  const dataDir = getActiveConfig().dataDir;
  const token = `${HEL_RECOVERY_SESSION_PREFIX}${randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const expiresAt = now + RECOVERY_SESSION_TTL_SEC * 1000;
  const current = readSessions(dataDir).sessions.filter(
    (session) => session.expiresAt > now
  );
  current.push({
    hash: hashSession(token),
    aud: RECOVERY_SESSION_AUDIENCE,
    createdAt: now,
    expiresAt,
  });
  writeSessions(dataDir, { sessions: current });
  return {
    token,
    scope: 'recovery',
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function verifyRecoverySession(
  token: string | null | undefined
): RecoverySessionVerifyResult {
  if (!token?.trim()) return { ok: false, reason: 'missing' };
  const trimmed = token.trim();
  if (!isHelRecoverySessionToken(trimmed)) {
    return { ok: false, reason: 'invalid' };
  }

  const dataDir = getActiveConfig().dataDir;
  const want = hashSession(trimmed);
  const now = Date.now();
  const file = readSessions(dataDir);
  let matched = false;
  let matchedExpired = false;
  const kept: RecoverySessionRecord[] = [];

  for (const session of file.sessions) {
    const same = hashEquals(session.hash, want);
    const validAudience = session.aud === RECOVERY_SESSION_AUDIENCE;
    if (session.expiresAt <= now) {
      if (same && validAudience) matchedExpired = true;
      continue;
    }
    kept.push(session);
    if (same && validAudience) matched = true;
  }

  if (kept.length !== file.sessions.length) {
    writeSessions(dataDir, { sessions: kept });
  }
  if (matched) return { ok: true };
  if (matchedExpired) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'invalid' };
}
