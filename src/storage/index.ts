import type { Config } from '../lib/config.js';
import { assertCloudConfig, setActiveConfig } from '../lib/config.js';
import { SqliteConfigStore } from './sqlite-store.js';
import { SupabaseConfigStore } from './supabase-store.js';
import { HybridConfigStore } from './hybrid-store.js';
import type { ControlHealthSnapshot } from './control-plane.js';
import { MemoryRateStore, RedisRateStore } from './rate-store.js';
import type { ConfigStore, RateStore, StorageBundle } from './types.js';

let bundle: StorageBundle | null = null;

async function createConfigStore(config: Config): Promise<ConfigStore> {
  if (config.storageBackend === 'supabase') {
    // Local SQLite always hosts workspace + control vault mirror.
    const workspace = new SqliteConfigStore(config);
    const supabase = new SupabaseConfigStore(config);
    await supabase.bootstrap(config);
    const hybrid = new HybridConfigStore({
      control: supabase,
      workspace,
      vault: workspace.getControlVault(),
      hybrid: true,
    });
    await hybrid.refreshVaultFromControl();
    console.log(
      '[storage] config backend: Hybrid (Supabase control + local vault/workspace)'
    );
    return hybrid;
  }
  console.log(
    `[storage] config backend: Local (SQLite)${config.encryptionKey ? ' · encrypted secrets' : ' · set ENCRYPTION_KEY to encrypt secrets'}`
  );
  return new SqliteConfigStore(config);
}

async function createRateStore(config: Config): Promise<RateStore> {
  if (config.rateBackend === 'redis') {
    console.log('[storage] rate backend: redis');
    return RedisRateStore.connect(config.redisUrl!);
  }
  console.log('[storage] rate backend: memory');
  return new MemoryRateStore();
}

export async function initStorage(config: Config): Promise<StorageBundle> {
  assertCloudConfig(config);

  if (bundle) {
    await closeStorage();
  }

  const configStore = await createConfigStore(config);
  const rateStore = await createRateStore(config);

  bundle = { config: configStore, rate: rateStore };
  setActiveConfig(config);
  return bundle;
}

/** Hot-switch storage after Settings save (closes previous stores). */
export async function reinitStorage(config: Config): Promise<StorageBundle> {
  return initStorage(config);
}

export function getStorage(): StorageBundle {
  if (!bundle) throw new Error('Storage not initialized. Call initStorage() first.');
  return bundle;
}

export function getConfigStore(): ConfigStore {
  return getStorage().config;
}

export function getControlHealth(): ControlHealthSnapshot {
  const store = getConfigStore();
  if (store instanceof HybridConfigStore) return store.getControlHealth();
  return { controlPlane: 'online', vault: 'fresh', outboxPending: 0 };
}

export function getRateStore(): RateStore {
  return getStorage().rate;
}

export async function closeStorage(): Promise<void> {
  if (!bundle) return;
  await Promise.all([bundle.config.close(), bundle.rate.close()]);
  bundle = null;
}
