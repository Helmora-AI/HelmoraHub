/**
 * Compatibility facade over the hybrid ConfigStore.
 * Prefer importing from ../storage/index.js in new code.
 */
import type { HubMode } from '../types.js';
import type { AgentConfig, ProviderToggle } from '../types.js';
import { getConfigStore, getRateStore, closeStorage } from '../storage/index.js';
import type { AgentPatch, ProviderPatch } from '../storage/types.js';

export { initStorage as initDb, closeStorage as closeDb } from '../storage/index.js';

export async function getSetting(key: string): Promise<string | null> {
  return getConfigStore().getSetting(key);
}

export async function setSetting(key: string, value: string): Promise<void> {
  return getConfigStore().setSetting(key, value);
}

export async function getActiveMode(): Promise<HubMode> {
  return getConfigStore().getActiveMode();
}

export async function setActiveMode(mode: HubMode): Promise<void> {
  return getConfigStore().setActiveMode(mode);
}

export async function getUnifiedApiKey(): Promise<string> {
  return getConfigStore().getUnifiedApiKey();
}

export async function listProviders(): Promise<ProviderToggle[]> {
  return getConfigStore().listProviders();
}

export async function getProvider(id: string): Promise<ProviderToggle | null> {
  return getConfigStore().getProvider(id);
}

export async function updateProvider(
  id: string,
  patch: ProviderPatch
): Promise<ProviderToggle | null> {
  return getConfigStore().updateProvider(id, patch);
}

export async function listAgents(): Promise<AgentConfig[]> {
  return getConfigStore().listAgents();
}

export async function getAgent(id: string): Promise<AgentConfig | null> {
  return getConfigStore().getAgent(id);
}

export async function updateAgent(
  id: string,
  patch: AgentPatch
): Promise<AgentConfig | null> {
  return getConfigStore().updateAgent(id, patch);
}

export function rates() {
  return getRateStore();
}
