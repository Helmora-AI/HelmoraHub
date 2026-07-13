import fs from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  helEnv,
  HEL_DB_FILE,
  LEGACY_DB_FILE,
} from './hel-env.js';
import {
  readRuntimeConfig,
  runtimeConfigPath,
  storageChoiceToBackend,
  type StorageChoice,
} from './runtime-config.js';

loadDotenv();

export type StorageBackend = 'sqlite' | 'supabase';
export type RateBackend = 'memory' | 'redis';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  apiKeyEnv: string | null;
  upstreamBaseUrl: string | null;
  upstreamApiKey: string | null;
  upstreamModel: string | null;
  /** Master key for AES-GCM of provider API keys. Required for supabase; recommended for sqlite. */
  encryptionKey: string | null;
  storageBackend: StorageBackend;
  /** UI choice: local | sql */
  storageChoice: StorageChoice;
  rateBackend: RateBackend;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  redisUrl: string | null;
  /** Public Hub origin for OAuth redirect_uri (HELMORA_PUBLIC_URL). */
  publicUrl: string | null;
  /** SPA origin for post-callback redirects (HELMORA_FRONTEND_URL). */
  frontendUrl: string | null;
}

let activeConfig: Config | null = null;

/** Pterodactyl / panel often inject SERVER_PORT; some eggs use P_SERVER_PORT. */
export function resolveListenPort(env: NodeJS.ProcessEnv = process.env): number {
  const candidates = [env.PORT, env.SERVER_PORT, env.P_SERVER_PORT, env.SERVERPORT];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 20800;
}

/**
 * Local default: 127.0.0.1
 * Docker / VPS / Pterodactyl: 0.0.0.0 (HOST, or production / HELMORA_PUBLIC)
 */
export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOST?.trim()) return env.HOST.trim();
  const pub = helEnv('PUBLIC', env);
  if (pub === '1' || pub === 'true') return '0.0.0.0';
  if (env.NODE_ENV === 'production') return '0.0.0.0';
  return '127.0.0.1';
}

/** Prefer helmora.db; keep ctrlhub.db when that is the only existing file. */
export function resolveDbPath(dataDir: string): string {
  const primary = path.join(dataDir, HEL_DB_FILE);
  const legacy = path.join(dataDir, LEGACY_DB_FILE);
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

function resolveRateBackend(
  fromFile: RateBackend | null,
  redisUrl: string | null
): RateBackend {
  const raw = (process.env.RATE_BACKEND ?? '').trim().toLowerCase();
  if (raw === 'redis') return 'redis';
  if (raw === 'memory') return 'memory';
  if (fromFile) return fromFile;
  if (redisUrl) return 'redis';
  return 'memory';
}

/**
 * Load config with Settings preference (runtime-config.json).
 * Default storage is **local**. Env STORAGE_BACKEND is legacy fallback only
 * when no runtime-config file exists yet.
 */
export function loadConfig(): Config {
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));
  const runtime = readRuntimeConfig(dataDir);
  const runtimeFileExists = fs.existsSync(runtimeConfigPath(dataDir));

  let storageChoice: StorageChoice = runtime.storageChoice ?? 'local';

  // Legacy env only if user has never saved Settings
  if (!runtimeFileExists) {
    const raw = (process.env.STORAGE_BACKEND ?? '').trim().toLowerCase();
    if (raw === 'supabase' || raw === 'sql') storageChoice = 'sql';
    if (raw === 'sqlite' || raw === 'local') storageChoice = 'local';
  }

  const supabaseUrl =
    runtime.supabaseUrl || process.env.SUPABASE_URL?.trim() || null;
  const supabaseServiceRoleKey =
    runtime.supabaseServiceRoleKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    null;
  const encryptionKey =
    process.env.ENCRYPTION_KEY?.trim() || runtime.encryptionKey || null;
  const redisUrl = runtime.redisUrl || process.env.REDIS_URL?.trim() || null;
  const publicUrl = helEnv('PUBLIC_URL') || null;
  const frontendUrl = helEnv('FRONTEND_URL') || null;

  const config: Config = {
    port: resolveListenPort(),
    host: resolveListenHost(),
    dataDir,
    dbPath: resolveDbPath(dataDir),
    apiKeyEnv: helEnv('API_KEY') || null,
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL?.trim() || null,
    upstreamApiKey: process.env.UPSTREAM_API_KEY?.trim() || null,
    upstreamModel: process.env.UPSTREAM_MODEL?.trim() || null,
    encryptionKey,
    storageChoice,
    storageBackend: storageChoiceToBackend(storageChoice),
    rateBackend: resolveRateBackend(runtime.rateBackend, redisUrl),
    supabaseUrl,
    supabaseServiceRoleKey,
    redisUrl,
    publicUrl,
    frontendUrl,
  };

  activeConfig = config;
  return config;
}

export function getActiveConfig(): Config {
  if (!activeConfig) return loadConfig();
  return activeConfig;
}

export function setActiveConfig(config: Config): void {
  activeConfig = config;
}

export function assertCloudConfig(config: Config): void {
  if (config.storageBackend === 'supabase') {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error(
        'SQL (Supabase) storage requires Supabase URL and service role key — set them in Settings'
      );
    }
    if (!config.encryptionKey) {
      throw new Error(
        'SQL (Supabase) storage requires ENCRYPTION_KEY (Settings or env) for AES-256-GCM'
      );
    }
  }
  if (config.rateBackend === 'redis' && !config.redisUrl) {
    throw new Error('Redis rate backend requires REDIS_URL (Settings or env)');
  }
}
