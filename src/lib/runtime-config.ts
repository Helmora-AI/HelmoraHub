import fs from 'node:fs';
import path from 'node:path';
import { helEnv } from './hel-env.js';
import type { RateBackend, StorageBackend } from './config.js';

/** UI-facing storage choice (Settings). */
export type StorageChoice = 'local' | 'sql';

/** Named Cloudflare Tunnel (token connector). */
export interface TunnelConfig {
  enabled: boolean;
  autoStart: boolean;
  token: string | null;
  hostname: string | null;
}

/** Control-plane admin auth (password + admin API token). */
export interface AdminAuthConfig {
  passwordHash: string | null;
  adminTokenHash: string | null;
  sessionSecret: string | null;
}

export interface RuntimeConfigFile {
  storageChoice: StorageChoice;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  encryptionKey: string | null;
  rateBackend: RateBackend;
  redisUrl: string | null;
  tunnel: TunnelConfig;
  admin: AdminAuthConfig;
}

export const DEFAULT_TUNNEL_CONFIG: TunnelConfig = {
  enabled: false,
  autoStart: true,
  token: null,
  hostname: null,
};

export const DEFAULT_ADMIN_CONFIG: AdminAuthConfig = {
  passwordHash: null,
  adminTokenHash: null,
  sessionSecret: null,
};

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfigFile = {
  storageChoice: 'local',
  supabaseUrl: null,
  supabaseServiceRoleKey: null,
  encryptionKey: null,
  rateBackend: 'memory',
  redisUrl: null,
  tunnel: { ...DEFAULT_TUNNEL_CONFIG },
  admin: { ...DEFAULT_ADMIN_CONFIG },
};

export function storageChoiceToBackend(choice: StorageChoice): StorageBackend {
  return choice === 'sql' ? 'supabase' : 'sqlite';
}

export function backendToStorageChoice(backend: StorageBackend): StorageChoice {
  return backend === 'supabase' ? 'sql' : 'local';
}

export function runtimeConfigPath(dataDir: string): string {
  return path.join(dataDir, 'runtime-config.json');
}

function parseTunnel(raw: unknown): TunnelConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TUNNEL_CONFIG };
  const t = raw as Record<string, unknown>;
  return {
    enabled: Boolean(t.enabled),
    autoStart: t.autoStart === undefined ? true : Boolean(t.autoStart),
    token: typeof t.token === 'string' ? t.token.trim() || null : null,
    hostname: typeof t.hostname === 'string' ? t.hostname.trim() || null : null,
  };
}

function parseAdmin(raw: unknown): AdminAuthConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ADMIN_CONFIG };
  const a = raw as Record<string, unknown>;
  return {
    passwordHash: typeof a.passwordHash === 'string' ? a.passwordHash : null,
    adminTokenHash: typeof a.adminTokenHash === 'string' ? a.adminTokenHash : null,
    sessionSecret: typeof a.sessionSecret === 'string' ? a.sessionSecret : null,
  };
}

export function readRuntimeConfig(dataDir: string): RuntimeConfigFile {
  const file = runtimeConfigPath(dataDir);
  if (!fs.existsSync(file)) {
    return {
      ...DEFAULT_RUNTIME_CONFIG,
      tunnel: { ...DEFAULT_TUNNEL_CONFIG },
      admin: { ...DEFAULT_ADMIN_CONFIG },
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const rawChoice = String(raw.storageChoice ?? 'local');
    let choice: StorageChoice = 'local';
    if (rawChoice === 'sql' || rawChoice === 'supabase') choice = 'sql';
    if (rawChoice === 'local' || rawChoice === 'sqlite') choice = 'local';

    return {
      storageChoice: choice,
      supabaseUrl: typeof raw.supabaseUrl === 'string' ? raw.supabaseUrl.trim() || null : null,
      supabaseServiceRoleKey:
        typeof raw.supabaseServiceRoleKey === 'string'
          ? raw.supabaseServiceRoleKey.trim() || null
          : null,
      encryptionKey:
        typeof raw.encryptionKey === 'string' ? raw.encryptionKey.trim() || null : null,
      rateBackend: raw.rateBackend === 'redis' ? 'redis' : 'memory',
      redisUrl: typeof raw.redisUrl === 'string' ? raw.redisUrl.trim() || null : null,
      tunnel: parseTunnel(raw.tunnel),
      admin: parseAdmin(raw.admin),
    };
  } catch {
    return {
      ...DEFAULT_RUNTIME_CONFIG,
      tunnel: { ...DEFAULT_TUNNEL_CONFIG },
      admin: { ...DEFAULT_ADMIN_CONFIG },
    };
  }
}

export function writeRuntimeConfig(dataDir: string, next: RuntimeConfigFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = runtimeConfigPath(dataDir);
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
}

export function updateTunnelConfig(
  dataDir: string,
  patch: Partial<TunnelConfig>
): RuntimeConfigFile {
  const prev = readRuntimeConfig(dataDir);
  const next: RuntimeConfigFile = {
    ...prev,
    tunnel: {
      ...prev.tunnel,
      ...patch,
    },
  };
  writeRuntimeConfig(dataDir, next);
  return next;
}

export function updateAdminConfig(
  dataDir: string,
  patch: Partial<AdminAuthConfig>
): RuntimeConfigFile {
  const prev = readRuntimeConfig(dataDir);
  const next: RuntimeConfigFile = {
    ...prev,
    admin: {
      ...prev.admin,
      ...patch,
    },
  };
  writeRuntimeConfig(dataDir, next);
  return next;
}

export function maskRuntimeConfig(cfg: RuntimeConfigFile) {
  return {
    storageChoice: cfg.storageChoice,
    storageLabel: cfg.storageChoice === 'sql' ? 'SQL (Supabase)' : 'Local (SQLite)',
    supabaseUrl: cfg.supabaseUrl,
    hasSupabaseServiceRoleKey: Boolean(cfg.supabaseServiceRoleKey),
    hasEncryptionKey: Boolean(cfg.encryptionKey || process.env.ENCRYPTION_KEY),
    rateBackend: cfg.rateBackend,
    hasRedisUrl: Boolean(cfg.redisUrl || process.env.REDIS_URL),
    tunnel: {
      enabled: cfg.tunnel.enabled,
      autoStart: cfg.tunnel.autoStart,
      hasToken: Boolean(cfg.tunnel.token || process.env.CLOUDFLARE_TUNNEL_TOKEN),
      hostname: cfg.tunnel.hostname || process.env.CLOUDFLARE_TUNNEL_HOSTNAME || null,
    },
    admin: {
      configured: Boolean(cfg.admin.passwordHash || helEnv('ADMIN_PASSWORD')),
      hasAdminToken: Boolean(cfg.admin.adminTokenHash || helEnv('ADMIN_TOKEN')),
    },
  };
}
