import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getActiveConfig } from './config.js';
import { helEnv, HEL_SESSION_PREFIX, isHelSessionToken } from './hel-env.js';

const DEFAULT_TTL_SEC = 60 * 60 * 24;

export type AdminSessionRecord = {
  hash: string;
  expiresAt: number;
  createdAt: number;
};

type SessionFile = { sessions: AdminSessionRecord[] };

function sessionsPath(dataDir: string): string {
  return path.join(dataDir, 'admin-sessions.json');
}

function readFile(dataDir: string): SessionFile {
  const p = sessionsPath(dataDir);
  if (!fs.existsSync(p)) return { sessions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as SessionFile;
    return { sessions: Array.isArray(raw.sessions) ? raw.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}

function writeFile(dataDir: string, data: SessionFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(sessionsPath(dataDir), JSON.stringify(data, null, 2), 'utf8');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sessionTtlSec(): number {
  const raw = helEnv('SESSION_TTL_SEC');
  const n = raw ? Number(raw) : DEFAULT_TTL_SEC;
  return Number.isFinite(n) && n > 60 ? Math.floor(n) : DEFAULT_TTL_SEC;
}

export function issueAdminSession(): { token: string; expiresAt: string } {
  const config = getActiveConfig();
  const token = `${HEL_SESSION_PREFIX}${randomBytes(32).toString('hex')}`;
  const now = Date.now();
  const expiresAtMs = now + sessionTtlSec() * 1000;
  const file = readFile(config.dataDir);
  const pruned = file.sessions.filter((s) => s.expiresAt > now);
  pruned.push({
    hash: hashSessionToken(token),
    expiresAt: expiresAtMs,
    createdAt: now,
  });
  writeFile(config.dataDir, { sessions: pruned });
  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

export type SessionVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

function hashEquals(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyAdminSession(token: string | null | undefined): SessionVerifyResult {
  if (!token?.trim()) return { ok: false, reason: 'missing' };
  const trimmed = token.trim();
  if (!isHelSessionToken(trimmed)) return { ok: false, reason: 'invalid' };

  const config = getActiveConfig();
  const want = hashSessionToken(trimmed);
  const now = Date.now();
  const file = readFile(config.dataDir);

  let matched: AdminSessionRecord | undefined;
  let matchedExpired = false;
  const kept: AdminSessionRecord[] = [];

  for (const s of file.sessions) {
    const isMatch = hashEquals(s.hash, want);
    if (s.expiresAt <= now) {
      if (isMatch) matchedExpired = true;
      continue;
    }
    kept.push(s);
    if (isMatch) matched = s;
  }

  if (kept.length !== file.sessions.length) {
    writeFile(config.dataDir, { sessions: kept });
  }

  if (matched) return { ok: true };
  if (matchedExpired) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'invalid' };
}

export function revokeAdminSession(token: string | null | undefined): boolean {
  if (!token?.trim()) return false;
  const config = getActiveConfig();
  const want = hashSessionToken(token.trim());
  const file = readFile(config.dataDir);
  const next = file.sessions.filter((s) => !hashEquals(s.hash, want));
  if (next.length === file.sessions.length) return false;
  writeFile(config.dataDir, { sessions: next });
  return true;
}
