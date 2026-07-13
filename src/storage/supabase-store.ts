import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../lib/config.js';
import { HEL_TABLE } from '../lib/hel-env.js';
import { generateApiKey, randomId } from '../lib/auth.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { formatSupabaseControlError } from '../lib/supabase-schema.js';
import {
  apiKeyHint,
  generateClientApiKey,
  hashApiKey,
  keyPrefixForEnv,
  normalizeImportedKeyEnv,
  toPublicKey,
} from '../keys/generate.js';
import type {
  ApiKeyEnv,
  ApiKeyPublic,
  ApiKeyRecord,
  CreateApiKeyInput,
  ModelPricing,
  UsageEvent,
  UsageEventSource,
  UsageEventStatus,
} from '../keys/types.js';
import { usdToMicros } from '../keys/types.js';
import { setPricingOverrides as applyPricingOverrides } from '../pricing/cost.js';
import type { AgentConfig, AgentRole, HubMode, ProviderToggle, ProviderTier } from '../types.js';
import { DEFAULT_AGENT_ROLES, HUB_MODES } from '../types.js';
import { DEFAULT_AGENTS, DEFAULT_PROVIDERS, resolvePaidUpstreamSeed } from './defaults.js';
import { getCatalogEntry, allowedModesForProviderTier } from '../providers/catalog/index.js';
import {
  buildProviderSeedPatch,
  formatSeedSyncSummary,
  shouldForceCatalogOwned,
  type SeedExistingSnapshot,
} from './provider-seed-sync.js';
import type { AgentPatch, ApiKeyPatch, ConfigStore, ProviderPatch } from './types.js';
import {
  CHAT_ACTIVE_SETTING_KEY,
  supabaseAppendChatMessages,
  supabaseCreateChatSession,
  supabaseDeleteChatSession,
  supabaseGetChatSession,
  supabaseImportChatStore,
  supabaseListChatMessages,
  supabaseListChatSessions,
  supabaseReplaceChatMessages,
  supabaseUpdateChatSession,
} from './chat-supabase.js';
import type {
  AppendChatMessageInput,
  CreateChatSessionInput,
  ImportChatStoreInput,
  ImportChatStoreResult,
  ListChatMessagesOpts,
  ListChatMessagesResult,
  StoredChatMessage,
  StoredChatSession,
  StoredChatSessionDetail,
  UpdateChatSessionInput,
} from './chat-types.js';
import {
  createHubModelJson,
  deleteHubModelJson,
  importHubModelsJson,
  listHubModelsJson,
  migrateCatalogModelsV1Json,
  updateHubModelJson,
  type JsonCatalogCtx,
} from './model-catalog-json.js';
import {
  CATALOG_MODELS_MIGRATION_KEY,
  type CreateHubModelInput,
  type ImportHubModelsInput,
  type ImportHubModelsResult,
  type ListHubModelsOpts,
  type ListHubModelsResult,
  type StoredHubModel,
  type UpdateHubModelInput,
} from '../models/types.js';

const API_KEYS_SETTING = 'api_keys_v1';
const USAGE_EVENTS_SETTING = 'usage_events_v1';
const PRICING_OVERRIDES_SETTING = 'pricing_overrides';
const API_KEY_BOOTSTRAP_SETTING = 'api_key_bootstrap';
const HUB_MODELS_SETTING = 'hub_models_v1';
const MAX_USAGE_EVENTS = 500;

type SettingsRow = { key: string; value: string };
type ProviderRow = {
  id: string;
  label: string;
  enabled: boolean;
  tier: number;
  base_url: string | null;
  api_key_encrypted: string | null;
  default_model: string | null;
  allowed_modes: HubMode[] | string;
  capabilities: string[] | string;
  protocol?: string;
  auth_style?: string;
  benchmark_model?: string | null;
  verify_status?: string;
  verify_error?: string | null;
  verified_at?: number | null;
  source?: string;
  catalog_ready?: boolean;
  extra_headers?: string | Record<string, string> | null;
  timeout_ms?: number | null;
  pinned_models?: string[] | string | null;
};
type AgentRow = {
  id: string;
  nickname: string;
  enabled: boolean;
  model: string;
  mode: string;
  desk_id: string | null;
};

function parseJsonArray<T>(value: T[] | string | null | undefined, fallback: T[]): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export class SupabaseConfigStore implements ConfigStore {
  readonly backend = 'supabase' as const;
  private client: SupabaseClient;
  private encryptionKey: string;

  constructor(config: Config) {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error('Supabase URL and service role key are required');
    }
    if (!config.encryptionKey) {
      throw new Error('ENCRYPTION_KEY is required for Supabase storage');
    }
    this.encryptionKey = config.encryptionKey;
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async bootstrap(config: Config): Promise<void> {
    const mode = await this.getSetting('active_mode');
    if (!mode) await this.setSetting('active_mode', 'smart');

    const apiKey = await this.getSetting('api_key');
    if (config.apiKeyEnv) {
      await this.setSetting('api_key', config.apiKeyEnv);
    } else if (!apiKey) {
      await this.setSetting('api_key', generateApiKey());
    }

    const { data: existingProviders, error: listErr } = await this.client
      .from(HEL_TABLE.providers)
      .select('*');
    if (listErr) throw formatSupabaseControlError('bootstrap (providers)', listErr.message);

    const existingById = new Map(
      (existingProviders ?? []).map((r) => [r.id as string, r as Record<string, unknown>])
    );
    const paid = resolvePaidUpstreamSeed(config);
    const seedUpdates: Array<{ id: string; changedKeys: string[] }> = [];

    for (const p of DEFAULT_PROVIDERS) {
      if (!existingById.has(p.id)) {
        const baseUrl = p.id === 'paid-upstream' ? paid.baseUrl : p.baseUrl;
        const apiKeyPlain = p.id === 'paid-upstream' ? paid.apiKey : null;
        const defaultModel =
          p.id === 'paid-upstream' ? paid.defaultModel ?? p.defaultModel : p.defaultModel;

        const { error } = await this.client.from(HEL_TABLE.providers).insert({
          id: p.id,
          label: p.label,
          enabled: p.enabled,
          tier: p.tier,
          base_url: baseUrl,
          api_key_encrypted: apiKeyPlain ? encryptSecret(apiKeyPlain, this.encryptionKey) : null,
          default_model: defaultModel,
          allowed_modes: p.allowedModes,
          capabilities: p.capabilities,
          protocol: p.protocol,
          auth_style: p.authStyle,
          benchmark_model: p.benchmarkModel,
          verify_status: p.verifyStatus,
          verify_error: p.verifyError,
          verified_at: p.verifiedAt,
          source: p.source,
          catalog_ready: p.catalogReady,
          extra_headers: p.extraHeaders,
          timeout_ms: p.timeoutMs,
        });
        if (error) throw new Error(`Supabase seed provider ${p.id}: ${error.message}`);
        continue;
      }

      const catalog = getCatalogEntry(p.id);
      if (!catalog) continue;

      const row = existingById.get(p.id)!;
      const mapped = this.mapProvider(row as ProviderRow);
      const existingSnap: SeedExistingSnapshot = {
        label: mapped.label,
        baseUrl: mapped.baseUrl,
        authStyle: mapped.authStyle,
        protocol: mapped.protocol,
        source: mapped.source,
        extraHeaders: mapped.extraHeaders,
        catalogReady: mapped.catalogReady,
        capabilities: mapped.capabilities,
        timeoutMs: mapped.timeoutMs,
        defaultModel: mapped.defaultModel,
        benchmarkModel: mapped.benchmarkModel,
      };

      const result = buildProviderSeedPatch(catalog, existingSnap, {
        forceCatalogOwned: shouldForceCatalogOwned(p.id),
        providerId: p.id,
      });
      if (!result) continue;

      const { patch, changedKeys } = result;
      const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (patch.label !== undefined) update.label = patch.label;
      if (patch.protocol !== undefined) update.protocol = patch.protocol;
      if (patch.authStyle !== undefined) update.auth_style = patch.authStyle;
      if (patch.source !== undefined) update.source = patch.source;
      if (patch.catalogReady !== undefined) update.catalog_ready = patch.catalogReady;
      if (patch.extraHeaders !== undefined) update.extra_headers = patch.extraHeaders;
      if (patch.timeoutMs !== undefined) update.timeout_ms = patch.timeoutMs;
      if (patch.capabilities !== undefined) update.capabilities = patch.capabilities;
      if (patch.baseUrl !== undefined) update.base_url = patch.baseUrl;
      if (patch.defaultModel !== undefined) update.default_model = patch.defaultModel;
      if (patch.benchmarkModel !== undefined) update.benchmark_model = patch.benchmarkModel;

      const { error } = await this.client
        .from(HEL_TABLE.providers)
        .update(update)
        .eq('id', p.id);
      if (error) throw new Error(`Supabase sync provider ${p.id}: ${error.message}`);
      seedUpdates.push({ id: p.id, changedKeys: [...changedKeys] });
    }

    if (seedUpdates.length > 0) {
      console.log(`[storage] ${formatSeedSyncSummary(seedUpdates)}`);
    }

    if (config.upstreamBaseUrl) {
      const patch: Record<string, unknown> = {
        base_url: config.upstreamBaseUrl,
        enabled: true,
        updated_at: new Date().toISOString(),
      };
      if (config.upstreamApiKey) {
        patch.api_key_encrypted = encryptSecret(config.upstreamApiKey, this.encryptionKey);
      }
      if (config.upstreamModel) patch.default_model = config.upstreamModel;
      await this.client.from(HEL_TABLE.providers).update(patch).eq('id', 'paid-upstream');
    }

    const { data: existingAgents, error: agentsErr } = await this.client
      .from(HEL_TABLE.agents)
      .select('id');
    if (agentsErr) throw formatSupabaseControlError('bootstrap (agents)', agentsErr.message);
    const agentIds = new Set((existingAgents ?? []).map((r) => r.id as string));

    for (const agent of DEFAULT_AGENTS) {
      if (!DEFAULT_AGENT_ROLES.includes(agent.id) || agentIds.has(agent.id)) continue;
      const { error } = await this.client.from(HEL_TABLE.agents).insert({
        id: agent.id,
        nickname: agent.nickname,
        enabled: agent.enabled,
        model: agent.model,
        mode: agent.mode,
        desk_id: agent.deskId,
      });
      if (error) throw new Error(`Supabase seed agent ${agent.id}: ${error.message}`);
    }

    await this.migrateLegacyApiKey(config);
    await this.loadPricingOverridesIntoRuntime();
    await this.migrateCatalogModelsV1();
  }

  private async loadHubModels(): Promise<StoredHubModel[]> {
    const raw = await this.getSetting(HUB_MODELS_SETTING);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredHubModel[]) : [];
    } catch {
      return [];
    }
  }

  private async saveHubModels(models: StoredHubModel[]): Promise<void> {
    await this.setSetting(HUB_MODELS_SETTING, JSON.stringify(models));
  }

  private async migrateCatalogModelsV1(): Promise<void> {
    const marker = await this.getSetting(CATALOG_MODELS_MIGRATION_KEY);
    if (marker === 'done') return;
    const providers = await this.listProviders();
    const existing = await this.loadHubModels();
    const next = migrateCatalogModelsV1Json(providers, existing);
    await this.saveHubModels(next);
    await this.setSetting(CATALOG_MODELS_MIGRATION_KEY, 'done');
  }

  private async withHubModelsCtx<T>(
    fn: (ctx: JsonCatalogCtx) => T | Promise<T>
  ): Promise<T> {
    const models = await this.loadHubModels();
    const providers = await this.listProviders();
    const agents = await this.listAgents();
    const providerPatches: Array<{
      id: string;
      defaultModel?: string | null;
      benchmarkModel?: string | null;
    }> = [];
    const ctx: JsonCatalogCtx = {
      models,
      providers,
      agents,
      patchProvider: (providerId, patch) => {
        providerPatches.push({ id: providerId, ...patch });
      },
    };
    const result = await fn(ctx);
    await this.saveHubModels(models);
    for (const p of providerPatches) {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (p.defaultModel !== undefined) patch.default_model = p.defaultModel;
      if (p.benchmarkModel !== undefined) patch.benchmark_model = p.benchmarkModel;
      const { error } = await this.client
        .from(HEL_TABLE.providers)
        .update(patch)
        .eq('id', p.id);
      if (error) throw new Error(`Supabase provider pointer sync failed: ${error.message}`);
    }
    return result;
  }

  private async loadApiKeys(): Promise<ApiKeyRecord[]> {
    const raw = await this.getSetting(API_KEYS_SETTING);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ApiKeyRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async saveApiKeys(keys: ApiKeyRecord[]): Promise<void> {
    await this.setSetting(API_KEYS_SETTING, JSON.stringify(keys));
  }

  private async loadUsageEvents(): Promise<UsageEvent[]> {
    const raw = await this.getSetting(USAGE_EVENTS_SETTING);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((e) => normalizeUsageEvent(e));
    } catch {
      return [];
    }
  }

  private async saveUsageEvents(events: UsageEvent[]): Promise<void> {
    await this.setSetting(USAGE_EVENTS_SETTING, JSON.stringify(events));
  }

  private buildApiKeyRecord(input: {
    id: string;
    name: string;
    keyEnv: ApiKeyEnv;
    plaintext: string;
    budgetUsd?: number | null;
    expiresAt?: number | null;
    enabled?: boolean;
    createdAt?: number;
  }): ApiKeyRecord {
    return {
      id: input.id,
      name: input.name,
      keyEnv: input.keyEnv,
      keyPrefix: keyPrefixForEnv(input.keyEnv),
      keyHash: hashApiKey(input.plaintext),
      keyHint: apiKeyHint(input.plaintext),
      budgetUsd: input.budgetUsd ?? null,
      spentUsd: 0,
      expiresAt: input.expiresAt ?? null,
      enabled: input.enabled !== false,
      createdAt: input.createdAt ?? Date.now(),
      lastUsedAt: null,
    };
  }

  /** Same logic as sqlite seedApiKeys — migrate legacy api_key / config.apiKeyEnv into api_keys_v1. */
  private async migrateLegacyApiKey(config: Config): Promise<void> {
    const existing = await this.loadApiKeys();
    if (existing.length > 0) return;

    const legacyPlain =
      (config.apiKeyEnv && config.apiKeyEnv.trim()) ||
      (await this.getSetting('api_key'))?.trim() ||
      null;

    let plaintext: string;
    let keyEnv: ApiKeyEnv;
    const name = 'Default';

    if (legacyPlain) {
      plaintext = legacyPlain;
      keyEnv = normalizeImportedKeyEnv(plaintext);
    } else {
      keyEnv = process.env.NODE_ENV === 'production' ? 'pro' : 'dev';
      plaintext = generateClientApiKey(keyEnv);
    }

    const record = this.buildApiKeyRecord({
      id: randomId('key'),
      name,
      keyEnv,
      plaintext,
    });
    await this.saveApiKeys([record]);
    await this.setSetting(API_KEY_BOOTSTRAP_SETTING, plaintext);
  }

  private async loadPricingOverridesIntoRuntime(): Promise<void> {
    const map = await this.getPricingOverrides();
    applyPricingOverrides(map);
  }

  async getSetting(key: string): Promise<string | null> {
    const { data, error } = await this.client
      .from(HEL_TABLE.settings)
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw formatSupabaseControlError('getSetting', error.message);
    return (data as SettingsRow | null)?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const { error } = await this.client.from(HEL_TABLE.settings).upsert({
      key,
      value,
      updated_at: new Date().toISOString(),
    });
    if (error) throw formatSupabaseControlError('setSetting', error.message);
  }

  async getActiveMode(): Promise<HubMode> {
    const mode = (await this.getSetting('active_mode')) ?? 'smart';
    return (HUB_MODES.includes(mode as HubMode) ? mode : 'smart') as HubMode;
  }

  async setActiveMode(mode: HubMode): Promise<void> {
    await this.setSetting('active_mode', mode);
  }

  async getUnifiedApiKey(): Promise<string> {
    const bootstrap = await this.getSetting(API_KEY_BOOTSTRAP_SETTING);
    if (bootstrap) return bootstrap;

    const keys = await this.loadApiKeys();
    const first = [...keys].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    })[0];
    if (first) return toPublicKey(first).keyPreview;

    throw new Error('API key missing from settings');
  }

  private mapProvider(row: ProviderRow): ProviderToggle {
    const encrypted = row.api_key_encrypted;
    const catalog = getCatalogEntry(row.id);
    let extraHeaders: Record<string, string> | null = null;
    if (row.extra_headers) {
      try {
        extraHeaders =
          typeof row.extra_headers === 'string'
            ? (JSON.parse(row.extra_headers) as Record<string, string>)
            : (row.extra_headers as Record<string, string>);
      } catch {
        extraHeaders = catalog?.extraHeaders ?? null;
      }
    } else {
      extraHeaders = catalog?.extraHeaders ?? null;
    }
    return {
      id: row.id,
      label: row.label,
      enabled: Boolean(row.enabled),
      tier: Number(row.tier) as 1 | 2 | 3,
      baseUrl: row.base_url,
      apiKey: encrypted ? decryptSecret(encrypted, this.encryptionKey) : null,
      defaultModel: row.default_model,
      allowedModes: parseJsonArray(row.allowed_modes, [] as HubMode[]),
      capabilities: parseJsonArray(row.capabilities, [] as string[]),
      protocol: (row.protocol as ProviderToggle['protocol']) ?? catalog?.protocol ?? 'openai',
      authStyle: (row.auth_style as ProviderToggle['authStyle']) ?? catalog?.authStyle ?? 'bearer',
      benchmarkModel: row.benchmark_model ?? row.default_model ?? catalog?.defaultModel ?? null,
      pinnedModels: parseJsonArray(row.pinned_models, [] as string[])
        .map((m) => String(m).trim())
        .filter(Boolean),
      verifyStatus: (row.verify_status as ProviderToggle['verifyStatus']) ?? 'never',
      verifyError: row.verify_error ?? null,
      verifiedAt: row.verified_at ?? null,
      source: row.source ?? catalog?.source ?? 'builtin',
      catalogReady: row.catalog_ready ?? catalog?.catalogReady ?? true,
      extraHeaders,
      timeoutMs: row.timeout_ms ?? catalog?.timeoutMs ?? null,
      authMode: 'none',
      oauthState: 'none',
    };
  }

  async listProviders(): Promise<ProviderToggle[]> {
    const { data, error } = await this.client
      .from(HEL_TABLE.providers)
      .select('*')
      .order('tier', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw new Error(`Supabase listProviders: ${error.message}`);
    return ((data ?? []) as ProviderRow[]).map((r) => this.mapProvider(r));
  }

  async getProvider(id: string): Promise<ProviderToggle | null> {
    const { data, error } = await this.client
      .from(HEL_TABLE.providers)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Supabase getProvider: ${error.message}`);
    return data ? this.mapProvider(data as ProviderRow) : null;
  }

  async updateProvider(id: string, patch: ProviderPatch): Promise<ProviderToggle | null> {
    const existing = await this.getProvider(id);
    if (!existing) return null;

    const credChanged =
      (patch.apiKey !== undefined && patch.apiKey !== existing.apiKey) ||
      (patch.baseUrl !== undefined && patch.baseUrl !== existing.baseUrl) ||
      (patch.benchmarkModel !== undefined &&
        patch.benchmarkModel !== existing.benchmarkModel) ||
      (patch.defaultModel !== undefined && patch.defaultModel !== existing.defaultModel);

    let verifyStatus = patch.verifyStatus ?? existing.verifyStatus;
    let verifyError = patch.verifyError === undefined ? existing.verifyError : patch.verifyError;
    let verifiedAt = patch.verifiedAt === undefined ? existing.verifiedAt : patch.verifiedAt;
    let enabled = patch.enabled ?? existing.enabled;

    if (credChanged && patch.verifyStatus === undefined) {
      verifyStatus = 'never';
      verifyError = null;
      verifiedAt = null;
      if (patch.enabled === undefined) enabled = false;
    }

    if (enabled && verifyStatus !== 'ok' && patch.enabled === true && patch.verifyStatus !== 'ok') {
      enabled = false;
    }

    const nextTier: ProviderTier =
      patch.tier !== undefined ? patch.tier : existing.tier;
    const next = {
      enabled,
      label: patch.label ?? existing.label,
      tier: nextTier,
      baseUrl: patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl,
      apiKey: patch.apiKey === undefined ? existing.apiKey : patch.apiKey,
      defaultModel:
        patch.defaultModel === undefined ? existing.defaultModel : patch.defaultModel,
      benchmarkModel:
        patch.benchmarkModel === undefined ? existing.benchmarkModel : patch.benchmarkModel,
      pinnedModels:
        patch.pinnedModels === undefined
          ? existing.pinnedModels
          : [...new Set(patch.pinnedModels.map((m) => m.trim()).filter(Boolean))],
      allowedModes:
        patch.allowedModes ??
        (patch.tier !== undefined
          ? allowedModesForProviderTier(patch.tier)
          : existing.allowedModes),
      capabilities: patch.capabilities ?? existing.capabilities,
      verifyStatus,
      verifyError,
      verifiedAt,
    };

    const { error } = await this.client
      .from(HEL_TABLE.providers)
      .update({
        enabled: next.enabled,
        label: next.label,
        tier: next.tier,
        base_url: next.baseUrl,
        api_key_encrypted: next.apiKey
          ? encryptSecret(next.apiKey, this.encryptionKey)
          : null,
        default_model: next.defaultModel,
        allowed_modes: next.allowedModes,
        capabilities: next.capabilities,
        benchmark_model: next.benchmarkModel,
        pinned_models: next.pinnedModels,
        verify_status: next.verifyStatus,
        verify_error: next.verifyError,
        verified_at: next.verifiedAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`Supabase updateProvider: ${error.message}`);
    return this.getProvider(id);
  }

  private mapAgent(row: AgentRow): AgentConfig {
    return {
      id: row.id as AgentRole,
      nickname: row.nickname,
      enabled: Boolean(row.enabled),
      model: row.model,
      mode: row.mode as HubMode,
      deskId: row.desk_id,
    };
  }

  async listAgents(): Promise<AgentConfig[]> {
    const { data, error } = await this.client
      .from(HEL_TABLE.agents)
      .select('*')
      .order('id', { ascending: true });
    if (error) throw new Error(`Supabase listAgents: ${error.message}`);
    return ((data ?? []) as AgentRow[]).map((r) => this.mapAgent(r));
  }

  async getAgent(id: string): Promise<AgentConfig | null> {
    const { data, error } = await this.client
      .from(HEL_TABLE.agents)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Supabase getAgent: ${error.message}`);
    return data ? this.mapAgent(data as AgentRow) : null;
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<AgentConfig | null> {
    const existing = await this.getAgent(id);
    if (!existing) return null;

    const next = {
      nickname: patch.nickname ?? existing.nickname,
      enabled: patch.enabled ?? existing.enabled,
      model: patch.model ?? existing.model,
      mode: patch.mode ?? existing.mode,
      deskId: patch.deskId === undefined ? existing.deskId : patch.deskId,
    };

    const { error } = await this.client
      .from(HEL_TABLE.agents)
      .update({
        nickname: next.nickname,
        enabled: next.enabled,
        model: next.model,
        mode: next.mode,
        desk_id: next.deskId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`Supabase updateAgent: ${error.message}`);
    return this.getAgent(id);
  }

  async listApiKeys(): Promise<ApiKeyPublic[]> {
    const keys = await this.loadApiKeys();
    return [...keys]
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
      })
      .map((k) => toPublicKey(k));
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const keys = await this.loadApiKeys();
    return keys.find((k) => k.id === id) ?? null;
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const keys = await this.loadApiKeys();
    return keys.find((k) => k.keyHash === keyHash) ?? null;
  }

  async createApiKey(
    input: CreateApiKeyInput
  ): Promise<{ record: ApiKeyPublic; plaintext: string }> {
    const plaintext = input.plaintext?.trim() || generateClientApiKey(input.keyEnv);
    const record = this.buildApiKeyRecord({
      id: input.id?.trim() || randomId('key'),
      name: input.name,
      keyEnv: input.keyEnv,
      plaintext,
      budgetUsd: input.budgetUsd,
      expiresAt: input.expiresAt,
    });
    const keys = await this.loadApiKeys();
    keys.push(record);
    await this.saveApiKeys(keys);
    return { record: toPublicKey(record), plaintext };
  }

  async updateApiKey(id: string, patch: ApiKeyPatch): Promise<ApiKeyPublic | null> {
    const keys = await this.loadApiKeys();
    const idx = keys.findIndex((k) => k.id === id);
    if (idx < 0) return null;

    const existing = keys[idx]!;
    const next: ApiKeyRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      budgetUsd: patch.budgetUsd === undefined ? existing.budgetUsd : patch.budgetUsd,
      expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
      enabled: patch.enabled ?? existing.enabled,
    };
    keys[idx] = next;
    await this.saveApiKeys(keys);
    return toPublicKey(next);
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const keys = await this.loadApiKeys();
    const next = keys.filter((k) => k.id !== id);
    if (next.length === keys.length) return false;
    await this.saveApiKeys(next);

    const events = await this.loadUsageEvents();
    const filtered = events.filter((e) => e.apiKeyId !== id);
    if (filtered.length !== events.length) {
      await this.saveUsageEvents(filtered);
    }
    return true;
  }

  async addApiKeySpend(id: string, costUsd: number): Promise<ApiKeyRecord | null> {
    const keys = await this.loadApiKeys();
    const idx = keys.findIndex((k) => k.id === id);
    if (idx < 0) return null;

    const existing = keys[idx]!;
    const add = Number(costUsd) || 0;
    const next: ApiKeyRecord = {
      ...existing,
      spentUsd: (Number(existing.spentUsd) || 0) + add,
    };
    keys[idx] = next;
    await this.saveApiKeys(keys);
    return next;
  }

  async touchApiKey(id: string): Promise<void> {
    const keys = await this.loadApiKeys();
    const idx = keys.findIndex((k) => k.id === id);
    if (idx < 0) return;
    keys[idx] = { ...keys[idx]!, lastUsedAt: Date.now() };
    await this.saveApiKeys(keys);
  }

  async recordUsage(
    event: Omit<UsageEvent, 'id' | 'createdAt'> & { id?: string }
  ): Promise<UsageEvent> {
    const id = event.id ?? randomId('usage');
    const createdAt = Date.now();
    const underlyingModels = Array.isArray(event.underlyingModels) ? event.underlyingModels : [];
    const source = (event.source ?? 'api') as UsageEventSource;
    const requestId = event.requestId || `legacy_${id}`;
    const row: UsageEvent = {
      id,
      requestId,
      source,
      apiKeyId: event.apiKeyId ?? null,
      status: (event.status ?? 'complete') as UsageEventStatus,
      model: event.model,
      underlyingModels,
      providerId: event.providerId ?? null,
      costMicrosUsd: Math.round(Number(event.costMicrosUsd) || 0),
      promptTokens: event.promptTokens ?? null,
      completionTokens: event.completionTokens ?? null,
      estimated: Boolean(event.estimated),
      createdAt,
    };

    const events = await this.loadUsageEvents();
    const existingIdx = events.findIndex(
      (e) => e.source === row.source && e.requestId === row.requestId
    );
    if (existingIdx >= 0) {
      return events[existingIdx]!;
    }
    events.push(row);
    const trimmed =
      events.length > MAX_USAGE_EVENTS ? events.slice(events.length - MAX_USAGE_EVENTS) : events;
    await this.saveUsageEvents(trimmed);
    return row;
  }

  async listUsage(opts?: { apiKeyId?: string; limit?: number }): Promise<UsageEvent[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    let events = await this.loadUsageEvents();
    if (opts?.apiKeyId) {
      events = events.filter((e) => e.apiKeyId === opts.apiKeyId);
    }
    return [...events].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async getPricingOverrides(): Promise<Record<string, ModelPricing>> {
    const raw = await this.getSetting(PRICING_OVERRIDES_SETTING);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, ModelPricing>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async setPricingOverrides(map: Record<string, ModelPricing>): Promise<void> {
    const next = map && typeof map === 'object' ? map : {};
    await this.setSetting(PRICING_OVERRIDES_SETTING, JSON.stringify(next));
    applyPricingOverrides(next);
  }

  async listHubModels(opts?: ListHubModelsOpts): Promise<ListHubModelsResult> {
    const models = await this.loadHubModels();
    return listHubModelsJson(models, opts);
  }

  async getHubModel(id: string): Promise<StoredHubModel | null> {
    const models = await this.loadHubModels();
    return models.find((m) => m.id === id) ?? null;
  }

  async createHubModel(input: CreateHubModelInput): Promise<StoredHubModel> {
    return this.withHubModelsCtx((ctx) => createHubModelJson(ctx, input));
  }

  async updateHubModel(id: string, patch: UpdateHubModelInput): Promise<StoredHubModel> {
    return this.withHubModelsCtx((ctx) => updateHubModelJson(ctx, id, patch));
  }

  async deleteHubModel(id: string): Promise<boolean> {
    return this.withHubModelsCtx((ctx) => deleteHubModelJson(ctx, id));
  }

  async setHubModelDefault(catalogId: string): Promise<StoredHubModel> {
    return this.updateHubModel(catalogId, { isDefault: true });
  }

  async setHubModelBenchmark(catalogId: string): Promise<StoredHubModel> {
    return this.updateHubModel(catalogId, { isBenchmark: true });
  }

  async importHubModels(input: ImportHubModelsInput): Promise<ImportHubModelsResult> {
    return this.withHubModelsCtx((ctx) => importHubModelsJson(ctx, input));
  }

  async listChatSessions(): Promise<StoredChatSession[]> {
    return supabaseListChatSessions(this.client);
  }

  async getChatSession(id: string): Promise<StoredChatSessionDetail | null> {
    return supabaseGetChatSession(this.client, id);
  }

  async createChatSession(
    input?: CreateChatSessionInput
  ): Promise<StoredChatSessionDetail> {
    return supabaseCreateChatSession(this.client, input, () =>
      this.getActiveChatSessionId()
    );
  }

  async updateChatSession(
    id: string,
    patch: UpdateChatSessionInput
  ): Promise<StoredChatSession | null> {
    return supabaseUpdateChatSession(this.client, id, patch);
  }

  async deleteChatSession(id: string): Promise<boolean> {
    return supabaseDeleteChatSession(this.client, id, async (deletedId) => {
      const active = await this.getActiveChatSessionId();
      if (active === deletedId) await this.setActiveChatSessionId(null);
    });
  }

  async listChatMessages(
    sessionId: string,
    opts?: ListChatMessagesOpts
  ): Promise<ListChatMessagesResult> {
    return supabaseListChatMessages(this.client, sessionId, opts);
  }

  async appendChatMessages(
    sessionId: string,
    messages: AppendChatMessageInput[]
  ): Promise<StoredChatMessage[]> {
    return supabaseAppendChatMessages(this.client, sessionId, messages);
  }

  async replaceChatMessages(
    sessionId: string,
    messages: AppendChatMessageInput[]
  ): Promise<StoredChatMessage[]> {
    return supabaseReplaceChatMessages(this.client, sessionId, messages);
  }

  async getActiveChatSessionId(): Promise<string | null> {
    const raw = await this.getSetting(CHAT_ACTIVE_SETTING_KEY);
    const id = raw?.trim();
    if (!id) return null;
    const session = await this.getChatSession(id);
    return session ? id : null;
  }

  async setActiveChatSessionId(id: string | null): Promise<void> {
    if (!id) {
      await this.setSetting(CHAT_ACTIVE_SETTING_KEY, '');
      return;
    }
    const session = await this.getChatSession(id);
    if (!session) throw new Error(`Chat session not found: ${id}`);
    await this.setSetting(CHAT_ACTIVE_SETTING_KEY, id);
  }

  async importChatStore(input: ImportChatStoreInput): Promise<ImportChatStoreResult> {
    return supabaseImportChatStore(
      this.client,
      input,
      (activeId) => this.setActiveChatSessionId(activeId),
      () => this.getActiveChatSessionId()
    );
  }

  async close(): Promise<void> {
    // HTTP client — nothing to close
  }
}

function normalizeUsageEvent(raw: unknown): UsageEvent {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof e.id === 'string' ? e.id : randomId('usage');
  const costMicros =
    e.costMicrosUsd != null
      ? Math.round(Number(e.costMicrosUsd) || 0)
      : usdToMicros(Number(e.costUsd) || 0);
  return {
    id,
    requestId: typeof e.requestId === 'string' ? e.requestId : `legacy_${id}`,
    source: e.source === 'admin_chat' ? 'admin_chat' : 'api',
    apiKeyId: e.apiKeyId == null ? null : String(e.apiKeyId),
    status:
      e.status === 'stopped' || e.status === 'error' || e.status === 'complete'
        ? (e.status as UsageEventStatus)
        : 'complete',
    model: typeof e.model === 'string' ? e.model : 'unknown',
    underlyingModels: Array.isArray(e.underlyingModels)
      ? e.underlyingModels.map(String)
      : [],
    providerId: e.providerId == null ? null : String(e.providerId),
    costMicrosUsd: costMicros,
    promptTokens: e.promptTokens == null ? null : Number(e.promptTokens),
    completionTokens: e.completionTokens == null ? null : Number(e.completionTokens),
    estimated: Boolean(e.estimated),
    createdAt: Number(e.createdAt) || Date.now(),
  };
}
