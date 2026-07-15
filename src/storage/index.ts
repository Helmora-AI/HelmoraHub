import type { Config } from '../lib/config.js';
import { assertCloudConfig, setActiveConfig } from '../lib/config.js';
import { SqliteConfigStore } from './sqlite-store.js';
import { SupabaseConfigStore } from './supabase-store.js';
import { HybridConfigStore } from './hybrid-store.js';
import {
  CONTROL_PROBE_INTERVAL_MS,
  type ControlHealthSnapshot,
} from './control-plane.js';
import { MemoryRateStore, RedisRateStore } from './rate-store.js';
import type { ConfigStore, RateStore, StorageBundle } from './types.js';

let bundle: StorageBundle | null = null;
let controlProbeTimer: NodeJS.Timeout | null = null;
let controlProbeLoopStarted = false;
let controlProbeLoopInFlight: Promise<ControlHealthSnapshot> | null = null;

export type HybridControlClient = {
  store: ConfigStore;
  bootstrap: () => Promise<void>;
};

export type StorageInitDependencies = {
  createHybridControl?: (config: Config) => HybridControlClient;
};

async function createConfigStore(
  config: Config,
  dependencies: StorageInitDependencies
): Promise<ConfigStore> {
  if (config.storageBackend === 'supabase') {
    const workspace = new SqliteConfigStore(config);
    const client = dependencies.createHybridControl?.(config) ?? (() => {
      const supabase = new SupabaseConfigStore(config);
      return {
        store: supabase,
        bootstrap: () => supabase.bootstrap(config),
      };
    })();
    const vault = workspace.getControlVault();
    const snapshotAvailable =
      vault.getActiveSnapshotManifest() != null || vault.promoteLegacyGenerationZero().ok;
    const hybrid = new HybridConfigStore({
      control: client.store,
      workspace,
      vault,
      hybrid: true,
      initialSnapshotAvailable: snapshotAvailable,
      bootstrapControl: client.bootstrap,
    });
    console.log(
      `[storage] config backend: Hybrid (local-first; snapshot=${snapshotAvailable ? 'ready' : 'unavailable'})`
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

export async function initStorage(
  config: Config,
  dependencies: StorageInitDependencies = {}
): Promise<StorageBundle> {
  assertCloudConfig(config);

  if (bundle) {
    await closeStorage();
  }

  const configStore = await createConfigStore(config, dependencies);
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
  return {
    controlPlane: 'online',
    vault: 'fresh',
    outboxPending: 0,
    snapshotAvailable: true,
    servingReady: true,
    recoveryReady: false,
    degradedReason: null,
    degradedCapability: null,
  };
}

export async function startControlPlaneProbe(): Promise<ControlHealthSnapshot> {
  const store = getConfigStore();
  if (store instanceof HybridConfigStore) return store.startControlProbe();
  return getControlHealth();
}

export type ControlProbeLoopOptions = {
  intervalMs?: number;
  onFatalError?: (error: unknown) => void;
};

/** Starts one non-overlapping Hybrid control probe lifecycle after HTTP is live. */
export function startControlPlaneProbeLoop(
  options: ControlProbeLoopOptions = {}
): void {
  if (controlProbeLoopStarted) return;
  const store = getConfigStore();
  if (!(store instanceof HybridConfigStore)) return;

  controlProbeLoopStarted = true;
  const runProbe = (): void => {
    if (controlProbeLoopInFlight) return;
    const probe = store.startControlProbe();
    controlProbeLoopInFlight = probe;
    void probe
      .catch((error) => {
        haltControlPlaneProbeLoop();
        options.onFatalError?.(error);
      })
      .finally(() => {
        if (controlProbeLoopInFlight === probe) controlProbeLoopInFlight = null;
      });
  };

  runProbe();
  controlProbeTimer = setInterval(
    runProbe,
    options.intervalMs ?? CONTROL_PROBE_INTERVAL_MS
  );
  controlProbeTimer.unref?.();
}

function haltControlPlaneProbeLoop(): void {
  if (controlProbeTimer) clearInterval(controlProbeTimer);
  controlProbeTimer = null;
  controlProbeLoopStarted = false;
}

export async function stopControlPlaneProbeLoop(): Promise<void> {
  haltControlPlaneProbeLoop();
  const inFlight = controlProbeLoopInFlight;
  if (inFlight) await inFlight.catch(() => undefined);
}

export function getRateStore(): RateStore {
  return getStorage().rate;
}

export async function closeStorage(): Promise<void> {
  await stopControlPlaneProbeLoop();
  if (!bundle) return;
  await Promise.all([bundle.config.close(), bundle.rate.close()]);
  bundle = null;
}
