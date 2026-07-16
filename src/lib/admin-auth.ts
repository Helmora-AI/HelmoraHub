import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { Request, Response } from 'express';
import { getActiveConfig } from './config.js';
import {
  HEL_ADMIN_TOKEN_PREFIX,
  HEL_COOKIE_NAME,
  HEL_RECOVERY_TOKEN_PREFIX,
  HEL_SECURE_COOKIE_NAME,
  LEGACY_COOKIE_NAME,
  isHelRecoverySessionToken,
  isHelRecoveryToken,
  isHelSessionToken,
} from './hel-env.js';
import {
  readRuntimeConfig,
  type AdminAuthConfig,
} from './runtime-config.js';
import { timingSafeEqualString } from './auth.js';
import {
  issueAdminSession,
  sessionTtlSec,
  verifyAdminSession,
} from './admin-sessions.js';
import {
  getAdminAuthStore,
  getAdminAuthStoreHealth,
} from './admin-auth-store.js';

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

export function generateRecoveryToken(): string {
  return `${HEL_RECOVERY_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
}

export function hashRecoveryToken(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

function equalHexHash(actual: string, expected: string): boolean {
  try {
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== 32 || b.length !== 32) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function adminCredentialEnvironmentManaged(): boolean {
  return Boolean(getActiveConfig().adminTokenEnv);
}

export function recoveryCredentialEnvironmentManaged(): boolean {
  return Boolean(getActiveConfig().recoveryTokenEnv);
}

export function recoveryCredentialAvailable(): boolean {
  if (!getAdminAuthStoreHealth().ready) return false;
  if (isSetupRequired()) return false;
  const config = getActiveConfig();
  if (config.recoveryTokenEnv) return true;
  return Boolean(getAdminAuthConfig().recoveryTokenHash);
}

export function isRecoveryCredentialToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (isHelRecoveryToken(trimmed) || isHelRecoverySessionToken(trimmed)) return true;
  const fromEnv = getActiveConfig().recoveryTokenEnv;
  return fromEnv
    ? equalHexHash(hashRecoveryToken(trimmed), hashRecoveryToken(fromEnv))
    : false;
}

export function verifyRecoveryCredential(token: string): boolean {
  if (!getAdminAuthStoreHealth().ready) return false;
  if (isSetupRequired()) return false;
  const trimmed = token.trim();
  if (!trimmed) return false;
  const actual = hashRecoveryToken(trimmed);
  const fromEnv = getActiveConfig().recoveryTokenEnv;
  if (fromEnv) return equalHexHash(actual, hashRecoveryToken(fromEnv));

  const expected = getAdminAuthConfig().recoveryTokenHash;
  return expected ? equalHexHash(actual, expected) : false;
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

/**
 * Transitional reader for legacy files. AD-1C removes this fallback once the
 * durable one-time migration has completed.
 */
export function getAdminAuthConfig(): AdminAuthConfig {
  const config = getActiveConfig();
  if (!getAdminAuthStoreHealth().ready) {
    return {
      passwordHash: null,
      adminTokenHash: null,
      recoveryTokenHash: null,
      sessionSecret: null,
    };
  }
  const identity = getAdminAuthStore(config.dataDir).readIdentity();
  if (identity) {
    return {
      passwordHash: identity.passwordHash,
      adminTokenHash: identity.adminTokenHash,
      recoveryTokenHash: identity.recoveryTokenHash,
      sessionSecret: null,
    };
  }
  return readRuntimeConfig(config.dataDir).admin;
}

export function isSetupRequired(): boolean {
  if (!getAdminAuthStoreHealth().ready) return true;
  const config = getActiveConfig();
  if (config.adminPasswordEnv) return false;
  return !getAdminAuthConfig().passwordHash;
}

export function verifyAdminPassword(password: string): boolean {
  if (!getAdminAuthStoreHealth().ready) return false;
  const config = getActiveConfig();
  if (config.adminPasswordEnv) {
    return timingSafeEqualString(password, config.adminPasswordEnv);
  }
  const local = getAdminAuthConfig().passwordHash;
  return local ? verifyPassword(password, local) : false;
}

export function verifyAdminTokenPlain(token: string): boolean {
  if (!getAdminAuthStoreHealth().ready) return false;
  if (isSetupRequired()) return false;
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (isRecoveryCredentialToken(trimmed) || verifyRecoveryCredential(trimmed)) {
    return false;
  }

  const fromEnv = getActiveConfig().adminTokenEnv;
  if (fromEnv) return timingSafeEqualString(trimmed, fromEnv);

  const expected = getAdminAuthConfig().adminTokenHash;
  return expected ? equalHexHash(hashAdminToken(trimmed), expected) : false;
}

export function createSessionToken(): string {
  return issueAdminSession('cookie').token;
}

export function verifySessionToken(token: string | null | undefined): boolean {
  return verifyAdminSession(token, 'cookie').ok;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function getSessionFromRequest(req: Request): string | null {
  const cookies = parseCookies(req.header('cookie'));
  return (
    cookies[HEL_SECURE_COOKIE_NAME] ||
    cookies[HEL_COOKIE_NAME] ||
    cookies[LEGACY_COOKIE_NAME] ||
    null
  );
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
  if (isSetupRequired()) return false;
  if (verifySessionToken(getSessionFromRequest(req))) return true;
  const token = extractAdminToken(req);
  if (!token) return false;
  if (verifyAdminTokenPlain(token)) return true;
  return isHelSessionToken(token) && verifyAdminSession(token, 'spa').ok;
}

function serializeCookie(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(_req: Request, res: Response, token: string): void {
  const config = getActiveConfig();
  const name = config.cookieSecure ? HEL_SECURE_COOKIE_NAME : HEL_COOKIE_NAME;
  res.append(
    'Set-Cookie',
    serializeCookie(name, token, sessionTtlSec(), config.cookieSecure)
  );
}

export function clearSessionCookie(_req: Request, res: Response): void {
  res.append(
    'Set-Cookie',
    serializeCookie(HEL_SECURE_COOKIE_NAME, '', 0, true)
  );
  res.append('Set-Cookie', serializeCookie(HEL_COOKIE_NAME, '', 0, false));
  res.append('Set-Cookie', serializeCookie(LEGACY_COOKIE_NAME, '', 0, false));
}

export function authStatusPayload(req: Request) {
  const config = getActiveConfig();
  const storeHealth = getAdminAuthStoreHealth();
  const setupRequired = isSetupRequired();
  const setupAvailable =
    !setupRequired ||
    (storeHealth.ready && config.setupTokenState === 'valid');
  return {
    setupRequired,
    authenticated: setupRequired ? false : isAdminAuthenticated(req),
    setupTokenRequired: setupRequired,
    setupAvailable,
    ...(!setupAvailable
      ? {
          setupUnavailableReason: storeHealth.ready
            ? 'setup_token_not_configured'
            : 'auth_migration_incomplete',
        }
      : {}),
  };
}

export function authDiagnosticsPayload() {
  const config = getActiveConfig();
  const local = getAdminAuthConfig();
  const authSources = {
    password: config.adminPasswordEnv
      ? 'environment'
      : local.passwordHash
        ? 'local'
        : 'none',
    adminToken: config.adminTokenEnv
      ? 'environment'
      : local.adminTokenHash
        ? 'local'
        : 'none',
    recoveryToken: config.recoveryTokenEnv
      ? 'environment'
      : local.recoveryTokenHash
        ? 'local'
        : 'none',
  } as const;
  return {
    authSources,
    localAuthShadowed: Boolean(
      (config.adminPasswordEnv && local.passwordHash) ||
        (config.adminTokenEnv && local.adminTokenHash) ||
        (config.recoveryTokenEnv && local.recoveryTokenHash)
    ),
    authStoreMigrationVersion: getAdminAuthStoreHealth().migrationVersion,
  };
}

export {
  HEL_COOKIE_NAME as COOKIE_NAME,
  HEL_SECURE_COOKIE_NAME as SECURE_COOKIE_NAME,
};
