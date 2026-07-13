import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { Request, Response } from 'express';
import { getActiveConfig } from './config.js';
import {
  helEnv,
  HEL_ADMIN_TOKEN_PREFIX,
  HEL_COOKIE_NAME,
  LEGACY_COOKIE_NAME,
  isHelSessionToken,
} from './hel-env.js';
import {
  readRuntimeConfig,
  updateAdminConfig,
  type AdminAuthConfig,
} from './runtime-config.js';
import { timingSafeEqualString } from './auth.js';
import { verifyAdminSession } from './admin-sessions.js';

const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function generateAdminToken(): string {
  return `${HEL_ADMIN_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
}

export function hashAdminToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString('base64url');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expected = parts[5];
  if (!salt || !expected || !Number.isFinite(N)) return false;
  try {
    const actual = scryptSync(password, salt, SCRYPT_KEYLEN, { N, r, p }).toString(
      'base64url'
    );
    return timingSafeEqualString(actual, expected);
  } catch {
    return false;
  }
}

export function getAdminAuthConfig(): AdminAuthConfig {
  const config = getActiveConfig();
  return readRuntimeConfig(config.dataDir).admin;
}

export function isSetupRequired(): boolean {
  const admin = getAdminAuthConfig();
  if (admin.passwordHash) return false;
  if (helEnv('ADMIN_PASSWORD')) return false;
  return true;
}

export function verifyAdminPassword(password: string): boolean {
  const admin = getAdminAuthConfig();
  if (admin.passwordHash) return verifyPassword(password, admin.passwordHash);
  const fromEnv = helEnv('ADMIN_PASSWORD');
  if (fromEnv) return timingSafeEqualString(password, fromEnv);
  return false;
}

export function verifyAdminTokenPlain(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;

  const fromEnv = helEnv('ADMIN_TOKEN');
  if (fromEnv && timingSafeEqualString(trimmed, fromEnv)) return true;

  const admin = getAdminAuthConfig();
  if (!admin.adminTokenHash) return false;
  const actual = hashAdminToken(trimmed);
  try {
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(admin.adminTokenHash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function resolveSessionSecret(): string {
  const admin = getAdminAuthConfig();
  if (admin.sessionSecret) return admin.sessionSecret;
  const fromEnv = helEnv('SESSION_SECRET') || process.env.ENCRYPTION_KEY?.trim();
  if (fromEnv) return fromEnv;
  return 'helmora-dev-session-secret';
}

export function ensureSessionSecret(): string {
  const config = getActiveConfig();
  const admin = getAdminAuthConfig();
  if (admin.sessionSecret) return admin.sessionSecret;
  const secret = randomBytes(32).toString('hex');
  updateAdminConfig(config.dataDir, { sessionSecret: secret });
  return secret;
}

type SessionPayload = { iat: number; exp: number };

export function createSessionToken(): string {
  const secret = ensureSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { iat: now, exp: now + SESSION_TTL_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const secret = resolveSessionSecret();
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!timingSafeEqualString(sig, expected)) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    ) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionFromRequest(req: Request): string | null {
  const cookies = parseCookies(req.header('cookie'));
  return cookies[HEL_COOKIE_NAME] || cookies[LEGACY_COOKIE_NAME] || null;
}

export function extractAdminToken(req: Request): string | null {
  const header = req.header('x-admin-token')?.trim();
  if (header) return header;
  const auth = req.header('authorization');
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function isAdminAuthenticated(req: Request): boolean {
  if (verifySessionToken(getSessionFromRequest(req))) return true;
  const token = extractAdminToken(req);
  if (!token) return false;
  if (verifyAdminTokenPlain(token)) return true;
  // Opaque SPA sessions checked in requireAdmin (needs expired vs invalid)
  return false;
}

function cookieSecure(req: Request): boolean {
  const raw = helEnv('COOKIE_SECURE');
  if (raw === '1') return true;
  if (raw === '0') return false;
  const proto = (req.header('x-forwarded-proto') || '').split(',')[0]?.trim();
  return proto === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const parts = [
    `${HEL_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (cookieSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const parts = [
    `${HEL_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (cookieSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function authStatusPayload(req: Request) {
  const admin = getAdminAuthConfig();
  const setupRequired = isSetupRequired();
  let authenticated = false;
  if (!setupRequired) {
    if (verifySessionToken(getSessionFromRequest(req))) authenticated = true;
    else {
      const token = extractAdminToken(req);
      if (token && verifyAdminTokenPlain(token)) authenticated = true;
      else if (token && isHelSessionToken(token)) {
        authenticated = verifyAdminSession(token).ok;
      }
    }
  }
  return {
    setupRequired,
    authenticated,
    hasAdminToken: Boolean(admin.adminTokenHash || helEnv('ADMIN_TOKEN')),
    envPassword: Boolean(helEnv('ADMIN_PASSWORD')),
    envAdminToken: Boolean(helEnv('ADMIN_TOKEN')),
  };
}

export { HEL_COOKIE_NAME as COOKIE_NAME, SESSION_TTL_SEC };
