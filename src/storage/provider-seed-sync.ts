import type { CatalogEntry } from '../providers/types.js';
import { isPriorityProviderId } from '../providers/catalog/priority.js';

export function isUnset(value: string | null | undefined): boolean {
  return value == null || String(value).trim() === '';
}

export function sortedCapabilitiesKey(caps: string[]): string {
  return [...caps]
    .map((c) => c.trim())
    .filter(Boolean)
    .sort()
    .join('\0');
}

export function normalizeExtraHeadersKey(
  headers: Record<string, string> | null | undefined
): string {
  if (!headers) return '';
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return '';
  return JSON.stringify(Object.fromEntries(entries));
}

/** Snapshot of stored provider fields the seed sync may rewrite. */
export type SeedExistingSnapshot = {
  label: string;
  baseUrl: string | null;
  authStyle: string;
  protocol: string;
  source: string;
  extraHeaders: Record<string, string> | null;
  catalogReady: boolean;
  capabilities: string[];
  timeoutMs: number | null;
  defaultModel: string | null;
  benchmarkModel: string | null;
};

export type ProviderSeedPatch = {
  label?: string;
  baseUrl?: string | null;
  authStyle?: string;
  protocol?: string;
  source?: string;
  extraHeaders?: Record<string, string> | null;
  catalogReady?: boolean;
  capabilities?: string[];
  timeoutMs?: number | null;
  defaultModel?: string | null;
  benchmarkModel?: string | null;
};

export type BuildSeedPatchResult = {
  patch: ProviderSeedPatch;
  changedKeys: (keyof ProviderSeedPatch)[];
};

/**
 * Pure catalog→store drift patch. Returns null when nothing to write.
 * Does not touch apiKey, enabled, verify*, tier, allowedModes, pinnedModels.
 */
export function buildProviderSeedPatch(
  catalog: CatalogEntry,
  existing: SeedExistingSnapshot,
  opts: { forceCatalogOwned: boolean; providerId?: string }
): BuildSeedPatchResult | null {
  const id = opts.providerId ?? catalog.id;
  const patch: ProviderSeedPatch = {};
  const changedKeys: (keyof ProviderSeedPatch)[] = [];

  const take = <K extends keyof ProviderSeedPatch>(
    key: K,
    next: ProviderSeedPatch[K],
    same: boolean
  ) => {
    if (!same) {
      patch[key] = next;
      changedKeys.push(key);
    }
  };

  take('label', catalog.label, existing.label === catalog.label);
  take('authStyle', catalog.authStyle, existing.authStyle === catalog.authStyle);
  take('protocol', catalog.protocol, existing.protocol === catalog.protocol);
  take('source', catalog.source, existing.source === catalog.source);
  take('catalogReady', catalog.catalogReady, existing.catalogReady === catalog.catalogReady);

  const catTimeout = catalog.timeoutMs ?? null;
  take('timeoutMs', catTimeout, existing.timeoutMs === catTimeout);

  const catHeaders = catalog.extraHeaders ?? null;
  take(
    'extraHeaders',
    catHeaders,
    normalizeExtraHeadersKey(existing.extraHeaders) === normalizeExtraHeadersKey(catHeaders)
  );

  const catCaps = catalog.capabilities ?? [];
  take(
    'capabilities',
    catCaps,
    sortedCapabilitiesKey(existing.capabilities) === sortedCapabilitiesKey(catCaps)
  );

  if (id !== 'paid-upstream') {
    if (opts.forceCatalogOwned) {
      take('baseUrl', catalog.baseUrl, existing.baseUrl === catalog.baseUrl);
    } else if (isUnset(existing.baseUrl) && !isUnset(catalog.baseUrl)) {
      take('baseUrl', catalog.baseUrl, false);
    }
  }

  if (isUnset(existing.defaultModel) && !isUnset(catalog.defaultModel)) {
    take('defaultModel', catalog.defaultModel, false);
  }
  if (isUnset(existing.benchmarkModel) && !isUnset(catalog.defaultModel)) {
    take('benchmarkModel', catalog.defaultModel, false);
  }

  if (changedKeys.length === 0) return null;
  return { patch, changedKeys };
}

export function shouldForceCatalogOwned(providerId: string): boolean {
  return isPriorityProviderId(providerId);
}

/** Summarize a sync batch for logs — field names only, never values. */
export function formatSeedSyncSummary(
  updates: Array<{ id: string; changedKeys: string[] }>
): string {
  if (updates.length === 0) return 'provider seed sync: 0 updated';
  const parts = updates.map((u) => `${u.id} [${u.changedKeys.join(', ')}]`);
  return `provider seed sync: updated ${parts.join('; ')}`;
}
