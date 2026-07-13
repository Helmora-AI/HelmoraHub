import { HUB_MODES, type HubMode, type ProviderToggle } from '../../types.js';
import type { CatalogEntry } from '../types.js';
import { FREELLMAPI_CATALOG } from './freellmapi.js';
import { NINE_ROUTER_CATALOG } from './nine-router.js';

export { FREELLMAPI_CATALOG } from './freellmapi.js';
export { NINE_ROUTER_CATALOG } from './nine-router.js';

const BUILTIN: CatalogEntry[] = [
  {
    id: 'subscription-demo',
    label: 'Subscription (demo)',
    tier: 1,
    protocol: 'custom',
    authStyle: 'none',
    baseUrl: null,
    defaultModel: 'demo/subscription',
    capabilities: ['tools', 'code', 'vision'],
    allowedModes: ['manual', 'smart', 'coding', 'premium', 'fusion'],
    source: 'builtin',
    catalogReady: true,
  },
  {
    id: 'paid-upstream',
    label: 'Paid / custom upstream',
    tier: 2,
    protocol: 'custom',
    authStyle: 'bearer',
    baseUrl: null,
    defaultModel: null,
    capabilities: ['tools', 'code', 'vision'],
    allowedModes: [...HUB_MODES],
    source: 'builtin',
    catalogReady: true,
  },
  {
    id: 'free-pool',
    label: 'Free pool (demo)',
    tier: 3,
    protocol: 'custom',
    authStyle: 'none',
    baseUrl: null,
    defaultModel: 'demo/free',
    capabilities: ['tools', 'vision'],
    allowedModes: ['manual', 'smart', 'coding', 'economy'],
    source: 'builtin',
    catalogReady: true,
  },
];

function allowedModesForTier(tier: 1 | 2 | 3): HubMode[] {
  if (tier === 1) return ['manual', 'smart', 'coding', 'premium', 'fusion'];
  if (tier === 3) return ['manual', 'smart', 'coding', 'economy'];
  return [...HUB_MODES];
}

/** Full catalog: builtin + FreeLLMAPI + unique 9Router entries. */
export const PROVIDER_CATALOG: CatalogEntry[] = (() => {
  const map = new Map<string, CatalogEntry>();
  for (const e of [...BUILTIN, ...FREELLMAPI_CATALOG, ...NINE_ROUTER_CATALOG]) {
    if (!map.has(e.id)) map.set(e.id, e);
  }
  return [...map.values()];
})();

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id);
}

export function resolveAllowedModes(entry: CatalogEntry): HubMode[] {
  return entry.allowedModes ?? allowedModesForTier(entry.tier);
}

/** Allowed modes for a runtime tier override (user picks T1/T2/T3 in UI). */
export function allowedModesForProviderTier(tier: 1 | 2 | 3): HubMode[] {
  return allowedModesForTier(tier);
}

/** Seed shape for DB insert (no secrets / verify yet). */
export function catalogToSeedProvider(entry: CatalogEntry): Omit<ProviderToggle, 'apiKey'> {
  return {
    id: entry.id,
    label: entry.label,
    enabled: entry.id === 'paid-upstream' || entry.id === 'free-pool',
    tier: entry.tier,
    baseUrl: entry.baseUrl,
    defaultModel: entry.defaultModel,
    allowedModes: resolveAllowedModes(entry),
    capabilities: entry.capabilities,
    protocol: entry.protocol,
    authStyle: entry.authStyle,
    benchmarkModel: entry.defaultModel,
    pinnedModels: [],
    verifyStatus:
      entry.id === 'paid-upstream' ||
      entry.id === 'free-pool' ||
      entry.id === 'subscription-demo'
        ? 'ok'
        : 'never',
    verifyError: null,
    verifiedAt: null,
    source: entry.source,
    catalogReady: entry.catalogReady,
    extraHeaders: entry.extraHeaders ?? null,
    timeoutMs: entry.timeoutMs ?? null,
    authMode: 'none',
    oauthState: 'none',
  };
}

export function isChatProtocolReady(protocol: string, catalogReady: boolean): boolean {
  if (!catalogReady) return false;
  return (
    protocol === 'openai' ||
    protocol === 'keyless' ||
    protocol === 'custom' ||
    protocol === 'anthropic' ||
    protocol === 'gemini' ||
    /** Phase 3.0: oauth-as-bearer token paste (e.g. kimchi). Stubs stay catalogReady:false. */
    protocol === 'oauth'
  );
}
