import { getSetting, setSetting, listProviders } from '../db/index.js';
import { getConfigStore } from '../storage/index.js';
import { HUB_MODES, type HubMode, type ProviderToggle } from '../types.js';
import type { StoredHubModel } from '../models/types.js';
import { buildFallbackChain } from './mode-router.js';
import { MINI_ROLES, type MiniRole } from './mini-classifier.js';

export const MINI_ROUTE_SETTING = 'mini_route_v1';

export type MiniRoleAssignment = {
  primaryCatalogId: string | null;
  fallbackCatalogId: string | null;
};

export type MiniRoleConfig = {
  version: 2;
  enabled: boolean;
  roles: Record<MiniRole, MiniRoleAssignment>;
};

export type MiniMigrationWarning = {
  code: 'legacy_candidate_unmapped';
  candidateIndex: number;
  providerId: string;
  modelId: string | null;
  message: string;
};

export type MiniRoleConfigProjection = {
  config: MiniRoleConfig;
  migratedFromLegacy: boolean;
  warnings: MiniMigrationWarning[];
};

export type EffectiveMiniRoleSlot = {
  slot: 'primary' | 'fallback';
  catalogId: string;
  inheritedFromGeneral: boolean;
};

function emptyRoleAssignments(): Record<MiniRole, MiniRoleAssignment> {
  return {
    general: { primaryCatalogId: null, fallbackCatalogId: null },
    reasoning: { primaryCatalogId: null, fallbackCatalogId: null },
    coding: { primaryCatalogId: null, fallbackCatalogId: null },
    research: { primaryCatalogId: null, fallbackCatalogId: null },
    creative: { primaryCatalogId: null, fallbackCatalogId: null },
    review: { primaryCatalogId: null, fallbackCatalogId: null },
  };
}

export const DEFAULT_MINI_ROLE_CONFIG: MiniRoleConfig = {
  version: 2,
  enabled: true,
  roles: emptyRoleAssignments(),
};

function normalizeCatalogId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isMiniRoleConfigV2(raw: unknown): boolean {
  return Boolean(
    raw
      && typeof raw === 'object'
      && (raw as Record<string, unknown>).version === 2
      && (raw as Record<string, unknown>).roles
      && typeof (raw as Record<string, unknown>).roles === 'object'
  );
}

export function normalizeMiniRoleConfig(raw: unknown): MiniRoleConfig {
  const roles = emptyRoleAssignments();
  if (!raw || typeof raw !== 'object') {
    return { version: 2, enabled: DEFAULT_MINI_ROLE_CONFIG.enabled, roles };
  }

  const input = raw as Record<string, unknown>;
  const inputRoles = input.roles && typeof input.roles === 'object'
    ? input.roles as Record<string, unknown>
    : {};

  for (const role of MINI_ROLES) {
    const assignment = inputRoles[role];
    if (!assignment || typeof assignment !== 'object') continue;
    const fields = assignment as Record<string, unknown>;
    roles[role] = {
      primaryCatalogId: normalizeCatalogId(fields.primaryCatalogId),
      fallbackCatalogId: normalizeCatalogId(fields.fallbackCatalogId),
    };
  }

  return {
    version: 2,
    enabled: typeof input.enabled === 'boolean'
      ? input.enabled
      : DEFAULT_MINI_ROLE_CONFIG.enabled,
    roles,
  };
}

function findLegacyCatalogModel(
  candidate: MiniRouteCandidate,
  catalog: readonly StoredHubModel[]
): StoredHubModel | null {
  const providerModels = catalog.filter((model) => model.providerId === candidate.providerId);
  if (candidate.modelId) {
    return providerModels.find((model) => model.modelId === candidate.modelId) ?? null;
  }
  return providerModels.find((model) => model.isDefault) ?? null;
}

export function projectLegacyMiniRouteConfig(
  raw: unknown,
  catalog: readonly StoredHubModel[]
): MiniRoleConfigProjection {
  if (isMiniRoleConfigV2(raw)) {
    return {
      config: normalizeMiniRoleConfig(raw),
      migratedFromLegacy: false,
      warnings: [],
    };
  }

  const legacy = normalizeMiniRouteConfig(raw);
  const config = normalizeMiniRoleConfig({ enabled: legacy.enabled });
  const warnings: MiniMigrationWarning[] = [];
  const targetSlots: Array<keyof MiniRoleAssignment> = [
    'primaryCatalogId',
    'fallbackCatalogId',
  ];

  legacy.candidates.slice(0, 2).forEach((candidate, candidateIndex) => {
    const model = findLegacyCatalogModel(candidate, catalog);
    if (model) {
      config.roles.general[targetSlots[candidateIndex]] = model.id;
      return;
    }
    warnings.push({
      code: 'legacy_candidate_unmapped',
      candidateIndex,
      providerId: candidate.providerId,
      modelId: candidate.modelId ?? null,
      message: candidate.modelId
        ? `Legacy candidate ${candidate.providerId}/${candidate.modelId} is not in the model catalog.`
        : `Legacy candidate ${candidate.providerId} has no default model in the catalog.`,
    });
  });

  return { config, migratedFromLegacy: true, warnings };
}

export async function getMiniRoleConfigProjection(): Promise<MiniRoleConfigProjection> {
  const stored = await getSetting(MINI_ROUTE_SETTING);
  if (!stored) {
    return {
      config: normalizeMiniRoleConfig(DEFAULT_MINI_ROLE_CONFIG),
      migratedFromLegacy: false,
      warnings: [],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return {
      config: normalizeMiniRoleConfig(DEFAULT_MINI_ROLE_CONFIG),
      migratedFromLegacy: false,
      warnings: [],
    };
  }

  const catalog = await getConfigStore().listHubModels({ limit: 500 });
  return projectLegacyMiniRouteConfig(raw, catalog.models);
}

export async function setMiniRoleConfig(config: MiniRoleConfig): Promise<MiniRoleConfig> {
  const normalized = normalizeMiniRoleConfig(config);
  await setSetting(MINI_ROUTE_SETTING, JSON.stringify(normalized));
  return normalized;
}

export function resolveEffectiveMiniRoleSlots(
  config: MiniRoleConfig,
  role: MiniRole
): EffectiveMiniRoleSlot[] {
  const normalized = normalizeMiniRoleConfig(config);
  const selected = normalized.roles[role];
  const general = normalized.roles.general;
  const effective = [
    {
      slot: 'primary' as const,
      catalogId: selected.primaryCatalogId ?? general.primaryCatalogId,
      inheritedFromGeneral: role !== 'general' && selected.primaryCatalogId === null,
    },
    {
      slot: 'fallback' as const,
      catalogId: selected.fallbackCatalogId ?? general.fallbackCatalogId,
      inheritedFromGeneral: role !== 'general' && selected.fallbackCatalogId === null,
    },
  ];
  const seen = new Set<string>();

  return effective.filter((item): item is EffectiveMiniRoleSlot => {
    if (!item.catalogId || seen.has(item.catalogId)) return false;
    seen.add(item.catalogId);
    return true;
  });
}

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
