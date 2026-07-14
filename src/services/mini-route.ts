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

export type MiniConfigFieldIssue = {
  path: string;
  code:
    | 'duplicate_role_model'
    | 'catalog_model_not_found'
    | 'provider_not_found'
    | 'unsupported_protocol';
  message: string;
};

export type MiniRouteWarning = {
  path: string;
  code:
    | 'catalog_model_missing'
    | 'provider_missing'
    | 'model_disabled'
    | 'provider_disabled'
    | 'provider_degraded'
    | 'protocol_not_ready';
  message: string;
};

export type MiniResolvedCatalogModel = {
  catalogId: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  routable: boolean;
  status: 'ready' | 'degraded' | 'disabled' | 'credentials_required';
  protocol: string;
};

export type MiniResolvedRoleSlot = {
  catalogId: string;
  inheritedFromGeneral: boolean;
  model: MiniResolvedCatalogModel | null;
};

export type MiniResolvedRoleState = {
  primary: MiniResolvedRoleSlot | null;
  fallback: MiniResolvedRoleSlot | null;
  warnings: MiniRouteWarning[];
};

export type MiniResolvedRoles = Record<MiniRole, MiniResolvedRoleState>;

export type MiniCatalogReference = {
  kind: 'helmora_mini_role';
  role: MiniRole;
  slot: 'primary' | 'fallback';
};

export type MiniCatalogAttempt = {
  role: MiniRole;
  slot: 'primary' | 'fallback';
  catalogId: string;
  provider: ProviderToggle;
  modelId: string;
  inheritedFromGeneral: boolean;
};

export type MiniSkippedCatalogAttempt = {
  slot: 'primary' | 'fallback';
  catalogId: string;
  reason:
    | 'catalog_missing'
    | 'provider_missing'
    | 'model_disabled'
    | 'provider_disabled'
    | 'provider_degraded'
    | 'credentials_required'
    | 'protocol_not_ready';
};

export type MiniCatalogAttemptResolution = {
  role: MiniRole;
  configured: boolean;
  attempts: MiniCatalogAttempt[];
  skipped: MiniSkippedCatalogAttempt[];
};

export type MiniRuntimeResolution = MiniCatalogAttemptResolution & {
  enabled: boolean;
};

export const MINI_ROLE_METADATA: ReadonlyArray<{
  id: MiniRole;
  description: string;
}> = [
  { id: 'general', description: 'General conversation and uncategorized requests.' },
  { id: 'reasoning', description: 'Deep analysis, mathematics, and multi-step reasoning.' },
  { id: 'coding', description: 'Code generation, debugging, and technical implementation.' },
  { id: 'research', description: 'Source-oriented research and evidence synthesis.' },
  { id: 'creative', description: 'Brainstorming, naming, and creative writing.' },
  { id: 'review', description: 'Critique, audit, correctness, and security review.' },
];

const SUPPORTED_MINI_PROTOCOLS = new Set([
  'openai',
  'keyless',
  'custom',
  'anthropic',
  'gemini',
  'oauth',
]);

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

export async function getMiniCatalogReferences(
  catalogId: string
): Promise<MiniCatalogReference[]> {
  const projection = await getMiniRoleConfigProjection();
  const references: MiniCatalogReference[] = [];

  for (const role of MINI_ROLES) {
    const assignment = projection.config.roles[role];
    if (assignment.primaryCatalogId === catalogId) {
      references.push({ kind: 'helmora_mini_role', role, slot: 'primary' });
    }
    if (assignment.fallbackCatalogId === catalogId) {
      references.push({ kind: 'helmora_mini_role', role, slot: 'fallback' });
    }
  }

  return references;
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

export function resolveMiniCatalogAttempts(
  config: MiniRoleConfig,
  role: MiniRole,
  catalog: readonly StoredHubModel[],
  providers: readonly ProviderToggle[]
): MiniCatalogAttemptResolution {
  const effectiveSlots = resolveEffectiveMiniRoleSlots(config, role);
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const attempts: MiniCatalogAttempt[] = [];
  const skipped: MiniSkippedCatalogAttempt[] = [];

  for (const effective of effectiveSlots) {
    const model = catalogById.get(effective.catalogId);
    if (!model) {
      skipped.push({ ...effective, reason: 'catalog_missing' });
      continue;
    }
    const provider = providersById.get(model.providerId);
    if (!provider) {
      skipped.push({ ...effective, reason: 'provider_missing' });
      continue;
    }
    if (!model.enabled) {
      skipped.push({ ...effective, reason: 'model_disabled' });
      continue;
    }
    if (!provider.enabled) {
      skipped.push({ ...effective, reason: 'provider_disabled' });
      continue;
    }
    if (!SUPPORTED_MINI_PROTOCOLS.has(provider.protocol) || !provider.catalogReady) {
      skipped.push({ ...effective, reason: 'protocol_not_ready' });
      continue;
    }
    if (providerNeedsCredentials(provider)) {
      skipped.push({ ...effective, reason: 'credentials_required' });
      continue;
    }
    if (provider.verifyStatus !== 'ok') {
      skipped.push({ ...effective, reason: 'provider_degraded' });
      continue;
    }

    attempts.push({
      role,
      slot: effective.slot,
      catalogId: effective.catalogId,
      provider,
      modelId: model.modelId,
      inheritedFromGeneral: effective.inheritedFromGeneral,
    });
  }

  return {
    role,
    configured: effectiveSlots.length > 0,
    attempts,
    skipped,
  };
}

export async function resolveMiniRuntimeAttempts(
  role: MiniRole
): Promise<MiniRuntimeResolution> {
  const [projection, providers, catalog] = await Promise.all([
    getMiniRoleConfigProjection(),
    listProviders(),
    getConfigStore().listHubModels({ limit: 500 }),
  ]);
  return {
    enabled: projection.config.enabled,
    ...resolveMiniCatalogAttempts(projection.config, role, catalog.models, providers),
  };
}

export function validateMiniRoleConfigReferences(
  config: MiniRoleConfig,
  catalog: readonly StoredHubModel[],
  providers: readonly ProviderToggle[]
): MiniConfigFieldIssue[] {
  const issues: MiniConfigFieldIssue[] = [];
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));

  for (const role of MINI_ROLES) {
    const assignment = config.roles[role];
    if (
      assignment.primaryCatalogId
      && assignment.primaryCatalogId === assignment.fallbackCatalogId
    ) {
      issues.push({
        path: `roles.${role}.fallbackCatalogId`,
        code: 'duplicate_role_model',
        message: 'Primary and fallback must use different catalog models.',
      });
    }

    for (const slot of ['primaryCatalogId', 'fallbackCatalogId'] as const) {
      const catalogId = assignment[slot];
      if (!catalogId) continue;
      const path = `roles.${role}.${slot}`;
      const model = catalogById.get(catalogId);
      if (!model) {
        issues.push({
          path,
          code: 'catalog_model_not_found',
          message: `Catalog model ${catalogId} does not exist.`,
        });
        continue;
      }
      const provider = providersById.get(model.providerId);
      if (!provider) {
        issues.push({
          path,
          code: 'provider_not_found',
          message: `Provider ${model.providerId} for ${catalogId} does not exist.`,
        });
        continue;
      }
      if (!SUPPORTED_MINI_PROTOCOLS.has(provider.protocol)) {
        issues.push({
          path,
          code: 'unsupported_protocol',
          message: `Provider protocol ${provider.protocol} cannot serve chat requests.`,
        });
      }
    }
  }

  return issues;
}

function providerNeedsCredentials(provider: ProviderToggle): boolean {
  if (!provider.baseUrl) return false;
  if (provider.authStyle === 'none' || provider.protocol === 'keyless') return false;
  if (provider.authMode === 'oauth') return provider.oauthState !== 'connected';
  return !provider.apiKey;
}

export function resolveMiniRoleAdminState(
  config: MiniRoleConfig,
  catalog: readonly StoredHubModel[],
  providers: readonly ProviderToggle[]
): MiniResolvedRoles {
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const result = {} as MiniResolvedRoles;

  for (const role of MINI_ROLES) {
    const state: MiniResolvedRoleState = { primary: null, fallback: null, warnings: [] };
    for (const effective of resolveEffectiveMiniRoleSlots(config, role)) {
      const path = `roles.${role}.${effective.slot}CatalogId`;
      const model = catalogById.get(effective.catalogId);
      if (!model) {
        state[effective.slot] = {
          catalogId: effective.catalogId,
          inheritedFromGeneral: effective.inheritedFromGeneral,
          model: null,
        };
        state.warnings.push({
          path,
          code: 'catalog_model_missing',
          message: `Catalog model ${effective.catalogId} no longer exists.`,
        });
        continue;
      }

      const provider = providersById.get(model.providerId);
      if (!provider) {
        state[effective.slot] = {
          catalogId: effective.catalogId,
          inheritedFromGeneral: effective.inheritedFromGeneral,
          model: null,
        };
        state.warnings.push({
          path,
          code: 'provider_missing',
          message: `Provider ${model.providerId} no longer exists.`,
        });
        continue;
      }

      const needsCredentials = providerNeedsCredentials(provider);
      const protocolReady = SUPPORTED_MINI_PROTOCOLS.has(provider.protocol)
        && provider.catalogReady;
      const routable = Boolean(
        model.enabled
        && provider.enabled
        && provider.verifyStatus === 'ok'
        && protocolReady
        && !needsCredentials
      );
      let status: MiniResolvedCatalogModel['status'] = 'ready';
      if (!model.enabled || !provider.enabled) status = 'disabled';
      else if (needsCredentials) status = 'credentials_required';
      else if (!routable) status = 'degraded';

      state[effective.slot] = {
        catalogId: effective.catalogId,
        inheritedFromGeneral: effective.inheritedFromGeneral,
        model: {
          catalogId: model.id,
          providerId: model.providerId,
          providerLabel: provider.label,
          modelId: model.modelId,
          displayName: model.displayName,
          enabled: model.enabled,
          routable,
          status,
          protocol: provider.protocol,
        },
      };

      if (!model.enabled) {
        state.warnings.push({ path, code: 'model_disabled', message: `${model.displayName} is disabled.` });
      }
      if (!provider.enabled) {
        state.warnings.push({ path, code: 'provider_disabled', message: `${provider.label} is disabled.` });
      }
      if (!protocolReady) {
        state.warnings.push({
          path,
          code: 'protocol_not_ready',
          message: `${provider.label} does not currently have a ready chat adapter.`,
        });
      } else if (provider.verifyStatus !== 'ok' || needsCredentials) {
        state.warnings.push({
          path,
          code: 'provider_degraded',
          message: needsCredentials
            ? `${provider.label} requires credentials.`
            : `${provider.label} is not currently verified as healthy.`,
        });
      }
    }
    result[role] = state;
  }

  return result;
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
