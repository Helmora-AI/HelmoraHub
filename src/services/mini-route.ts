import { getSetting, setSetting, listProviders } from '../db/index.js';
import { HUB_MODES, type HubMode, type ProviderToggle } from '../types.js';
import { buildFallbackChain } from './mode-router.js';

export const MINI_ROUTE_SETTING = 'mini_route_v1';

export type MiniRouteCandidate = {
  /** Provider id from Hub registry */
  providerId: string;
  /** Optional upstream model pin; null/omit = provider defaultModel */
  modelId?: string | null;
};

export type MiniRouteConfig = {
  /** When true, helmora-mini / auto use this multi-model profile */
  enabled: boolean;
  /** Hub mode for tier fallback when candidates empty or fallback enabled */
  mode: HubMode;
  /** Ordered preferred upstreams (tried first) */
  candidates: MiniRouteCandidate[];
  /** After candidates, continue with mode tier chain */
  fallbackToModeChain: boolean;
};

export const DEFAULT_MINI_ROUTE: MiniRouteConfig = {
  enabled: true,
  mode: 'smart',
  candidates: [],
  fallbackToModeChain: true,
};

export type MiniRouteResolved = {
  config: MiniRouteConfig;
  mode: HubMode;
  /** Ordered providers for tier-router preferredChain */
  chain: ProviderToggle[];
  /** Per-provider upstream model override (when candidate pins a model) */
  modelByProvider: Record<string, string>;
};

function isHubMode(v: unknown): v is HubMode {
  return typeof v === 'string' && (HUB_MODES as string[]).includes(v);
}

export function normalizeMiniRouteConfig(raw: unknown): MiniRouteConfig {
  const base = { ...DEFAULT_MINI_ROUTE };
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;

  if (typeof o.enabled === 'boolean') base.enabled = o.enabled;
  if (isHubMode(o.mode)) base.mode = o.mode;
  if (typeof o.fallbackToModeChain === 'boolean') {
    base.fallbackToModeChain = o.fallbackToModeChain;
  }

  if (Array.isArray(o.candidates)) {
    const seen = new Set<string>();
    const candidates: MiniRouteCandidate[] = [];
    for (const item of o.candidates) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const providerId = typeof c.providerId === 'string' ? c.providerId.trim() : '';
      if (!providerId || seen.has(providerId)) continue;
      seen.add(providerId);
      const modelId =
        typeof c.modelId === 'string' && c.modelId.trim()
          ? c.modelId.trim()
          : null;
      candidates.push({ providerId, modelId });
    }
    base.candidates = candidates;
  }

  return base;
}

export async function getMiniRouteConfig(): Promise<MiniRouteConfig> {
  const raw = await getSetting(MINI_ROUTE_SETTING);
  if (!raw) return { ...DEFAULT_MINI_ROUTE };
  try {
    return normalizeMiniRouteConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MINI_ROUTE };
  }
}

export async function setMiniRouteConfig(
  patch: Partial<MiniRouteConfig> & { candidates?: MiniRouteCandidate[] }
): Promise<MiniRouteConfig> {
  const current = await getMiniRouteConfig();
  const next = normalizeMiniRouteConfig({ ...current, ...patch });
  await setSetting(MINI_ROUTE_SETTING, JSON.stringify(next));
  return next;
}

/**
 * Build the multi-model chain for Helmora Mini 1.0.
 * Candidates first (enabled providers only), then optional mode tier fallback.
 */
export async function resolveMiniRouteChain(
  config?: MiniRouteConfig
): Promise<MiniRouteResolved> {
  const cfg = config ?? (await getMiniRouteConfig());
  const mode = cfg.enabled ? cfg.mode : 'smart';
  const all = await listProviders();
  const byId = new Map(all.map((p) => [p.id, p]));
  const modelByProvider: Record<string, string> = {};
  const preferred: ProviderToggle[] = [];
  const seen = new Set<string>();

  if (cfg.enabled) {
    for (const c of cfg.candidates) {
      const p = byId.get(c.providerId);
      if (!p?.enabled) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      preferred.push(p);
      if (c.modelId) modelByProvider[p.id] = c.modelId;
    }
  }

  let chain = preferred;
  if (!cfg.enabled || preferred.length === 0 || cfg.fallbackToModeChain) {
    const modeChain = await buildFallbackChain(mode);
    if (preferred.length === 0) {
      chain = modeChain;
    } else {
      chain = [
        ...preferred,
        ...modeChain.filter((p) => !seen.has(p.id)),
      ];
    }
  }

  return { config: cfg, mode, chain, modelByProvider };
}
