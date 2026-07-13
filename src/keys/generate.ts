import { createHash, randomBytes } from 'node:crypto';
import {
  HEL_API_KEY_DEV,
  HEL_API_KEY_PRO,
  LEGACY_API_KEY_DEV,
  LEGACY_API_KEY_PRO,
  isHelClientApiKey,
} from '../lib/hel-env.js';
import type { ApiKeyEnv, ApiKeyPublic, ApiKeyRecord } from './types.js';

export function keyPrefixForEnv(env: ApiKeyEnv): string {
  return env === 'pro' ? HEL_API_KEY_PRO : HEL_API_KEY_DEV;
}

export function generateClientApiKey(env: ApiKeyEnv): string {
  return `${keyPrefixForEnv(env)}${randomBytes(24).toString('hex')}`;
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext.trim(), 'utf8').digest('hex');
}

export function apiKeyHint(plaintext: string): string {
  const t = plaintext.trim();
  if (t.length <= 8) return '****';
  return t.slice(-4);
}

export function detectKeyEnv(plaintext: string): ApiKeyEnv {
  if (plaintext.startsWith(HEL_API_KEY_PRO) || plaintext.startsWith(LEGACY_API_KEY_PRO)) {
    return 'pro';
  }
  return 'dev';
}

/** Legacy ctrl_* keys count as dev/pro by prefix. */
export function normalizeImportedKeyEnv(plaintext: string): ApiKeyEnv {
  if (plaintext.startsWith(HEL_API_KEY_PRO) || plaintext.startsWith(LEGACY_API_KEY_PRO)) {
    return 'pro';
  }
  if (
    plaintext.startsWith(HEL_API_KEY_DEV) ||
    plaintext.startsWith(LEGACY_API_KEY_DEV) ||
    isHelClientApiKey(plaintext)
  ) {
    return 'dev';
  }
  return process.env.NODE_ENV === 'production' ? 'pro' : 'dev';
}

export function toPublicKey(row: ApiKeyRecord): ApiKeyPublic {
  const now = Date.now();
  const expired = row.expiresAt != null && row.expiresAt <= now;
  const overBudget = row.budgetUsd != null && row.spentUsd >= row.budgetUsd;
  return {
    id: row.id,
    name: row.name,
    keyEnv: row.keyEnv,
    keyPrefix: row.keyPrefix,
    keyHint: row.keyHint,
    budgetUsd: row.budgetUsd,
    spentUsd: row.spentUsd,
    expiresAt: row.expiresAt,
    enabled: row.enabled,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    keyPreview: `${row.keyPrefix}…${row.keyHint}`,
    remainingUsd:
      row.budgetUsd == null ? null : Math.max(0, row.budgetUsd - row.spentUsd),
    expired,
    overBudget,
  };
}

/** @deprecated Prefer generateClientApiKey('dev'|'pro') */
export function generateApiKey(): string {
  return generateClientApiKey(process.env.NODE_ENV === 'production' ? 'pro' : 'dev');
}
