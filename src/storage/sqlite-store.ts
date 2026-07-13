import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Config } from '../lib/config.js';
import { randomId } from '../lib/auth.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
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
import { allowedModesForProviderTier, getCatalogEntry } from '../providers/catalog/index.js';
import {
  buildProviderSeedPatch,
  formatSeedSyncSummary,
  shouldForceCatalogOwned,
  type SeedExistingSnapshot,
} from './provider-seed-sync.js';
import { ensureControlVaultSchema, ControlVault } from './control-vault.js';
import {
  backfillAuthMode,
  ensureOAuthVaultSchema,
  OAuthVault,
} from '../oauth/vault.js';
import type { AgentPatch, ApiKeyPatch, ConfigStore, ProviderPatch } from './types.js';
import {
  createHubModelSync,
  deleteHubModelSync,
  ensureModelsTable,
  getHubModelSync,
  importHubModelsSync,
  listHubModelsSync,
  migrateCatalogModelsV1,
  setHubModelBenchmarkSync,
  setHubModelDefaultSync,
  updateHubModelSync,
} from './model-catalog-sqlite.js';
import type {
  CreateHubModelInput,
  ImportHubModelsInput,
  ImportHubModelsResult,
  ListHubModelsOpts,
  ListHubModelsResult,
  StoredHubModel,
  UpdateHubModelInput,
} from '../models/types.js';

type ApiKeyRow = {
  id: string;
  name: string;
  key_env: string;
  key_prefix: string;
  key_hash: string;
  key_hint: string;
  budget_usd: number | null;
  spent_usd: number;
  expires_at: number | null;
  enabled: number;
  created_at: number;
  last_used_at: number | null;
};

type UsageRow = {
  id: string;
  request_id: string;
  source: string;
  api_key_id: string | null;
  status: string;
  model: string;
  underlying_models: string;
  provider_id: string | null;
  cost_micros_usd: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated: number;
  created_at: number;
};

export class SqliteConfigStore implements ConfigStore {
  readonly backend = 'sqlite' as const;
  private db: Database.Database;
  private encryptionKey: string | null;

  constructor(config: Config) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.encryptionKey = config.encryptionKey;
    this.migrate();
    this.vault = new ControlVault(this.db);
    this.seed(config);
    this.loadPricingOverridesIntoRuntime();
  }

  private vault: ControlVault;

  getControlVault(): ControlVault {
    return this.vault;
  }

  /** OAuth credential vault bound to this store's DB + ENCRYPTION_KEY. */
  getOAuthVault(): OAuthVault {
    if (!this.encryptionKey) {
      throw new Error('ENCRYPTION_KEY is required for OAuth vault');
    }
    return new OAuthVault(this.db, this.encryptionKey);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        tier INTEGER NOT NULL CHECK(tier IN (1, 2, 3)),
        base_url TEXT,
        api_key TEXT,
        default_model TEXT,
        allowed_modes TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        model TEXT NOT NULL DEFAULT 'auto',
        mode TEXT NOT NULL DEFAULT 'smart',
        desk_id TEXT
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_env TEXT NOT NULL CHECK(key_env IN ('dev', 'pro')),
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_hint TEXT NOT NULL,
        budget_usd REAL,
        spent_usd REAL NOT NULL DEFAULT 0,
        expires_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'api',
        api_key_id TEXT,
        status TEXT NOT NULL DEFAULT 'complete',
        model TEXT NOT NULL,
        underlying_models TEXT NOT NULL DEFAULT '[]',
        provider_id TEXT,
        cost_micros_usd INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    this.ensureProviderColumns();
    this.ensureUsageEventsSchema();
    ensureModelsTable(this.db);
    ensureControlVaultSchema(this.db);
    ensureOAuthVaultSchema(this.db);
  }

  private ensureUsageEventsSchema(): void {
    const cols = (
      this.db.prepare(`PRAGMA table_info(usage_events)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const needsRebuild =
      !cols.includes('request_id') ||
      !cols.includes('source') ||
      !cols.includes('cost_micros_usd') ||
      !cols.includes('status');

    if (!needsRebuild) {
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS usage_events_source_request_id_uq
         ON usage_events (source, request_id)`
      );
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events_new (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'api',
        api_key_id TEXT,
        status TEXT NOT NULL DEFAULT 'complete',
        model TEXT NOT NULL,
        underlying_models TEXT NOT NULL DEFAULT '[]',
        provider_id TEXT,
        cost_micros_usd INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    const hasOld = cols.includes('api_key_id') && cols.includes('cost_usd');
    if (hasOld) {
      const rows = this.db.prepare(`SELECT * FROM usage_events`).all() as Array<
        Record<string, unknown>
      >;
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO usage_events_new
          (id, request_id, source, api_key_id, status, model, underlying_models,
           provider_id, cost_micros_usd, prompt_tokens, completion_tokens, estimated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const tx = this.db.transaction(() => {
        for (const row of rows) {
          const id = String(row.id);
          const requestId = row.request_id
            ? String(row.request_id)
            : `legacy_${id}`;
          const costMicros = row.cost_micros_usd != null
            ? Math.round(Number(row.cost_micros_usd) || 0)
            : usdToMicros(Number(row.cost_usd) || 0);
          insert.run(
            id,
            requestId,
            row.source ? String(row.source) : 'api',
            row.api_key_id != null ? String(row.api_key_id) : null,
            row.status ? String(row.status) : 'complete',
            String(row.model ?? 'unknown'),
            typeof row.underlying_models === 'string'
              ? row.underlying_models
              : '[]',
            row.provider_id != null ? String(row.provider_id) : null,
            costMicros,
            row.prompt_tokens != null ? Number(row.prompt_tokens) : null,
            row.completion_tokens != null ? Number(row.completion_tokens) : null,
            row.estimated ? 1 : 0,
            Number(row.created_at) || Date.now()
          );
        }
      });
      tx();
    }

    this.db.exec(`DROP TABLE IF EXISTS usage_events`);
    this.db.exec(`ALTER TABLE usage_events_new RENAME TO usage_events`);
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS usage_events_source_request_id_uq
       ON usage_events (source, request_id)`
    );
  }

  private ensureProviderColumns(): void {
    const cols = new Set(
      (
        this.db.prepare(`PRAGMA table_info(providers)`).all() as Array<{ name: string }>
      ).map((c) => c.name)
    );
    const add = (name: string, ddl: string) => {
      if (!cols.has(name)) {
        this.db.exec(`ALTER TABLE providers ADD COLUMN ${ddl}`);
        cols.add(name);
      }
    };
    add('protocol', `protocol TEXT NOT NULL DEFAULT 'openai'`);
    add('auth_style', `auth_style TEXT NOT NULL DEFAULT 'bearer'`);
    add('benchmark_model', `benchmark_model TEXT`);
    add('verify_status', `verify_status TEXT NOT NULL DEFAULT 'never'`);
    add('verify_error', `verify_error TEXT`);
    add('verified_at', `verified_at INTEGER`);
    add('source', `source TEXT NOT NULL DEFAULT 'builtin'`);
    add('catalog_ready', `catalog_ready INTEGER NOT NULL DEFAULT 1`);
    add('extra_headers', `extra_headers TEXT`);
    add('timeout_ms', `timeout_ms INTEGER`);
    add('pinned_models', `pinned_models TEXT NOT NULL DEFAULT '[]'`);
    add('auth_mode', `auth_mode TEXT NOT NULL DEFAULT 'none'`);
    add('oauth_state', `oauth_state TEXT NOT NULL DEFAULT 'none'`);
    backfillAuthMode(this.db);
  }

  private sealApiKey(plain: string | null): string | null {
    if (plain == null || plain === '') return null;
    if (!this.encryptionKey) return plain;
    return encryptSecret(plain, this.encryptionKey);
  }

  private openApiKey(stored: string | null): string | null {
    if (stored == null || stored === '') return null;
    if (!this.encryptionKey) return stored;
    return decryptSecret(stored, this.encryptionKey);
  }

  private getSettingSync(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setSettingSync(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  private mapApiKeyRow(row: ApiKeyRow): ApiKeyRecord {
    return {
      id: row.id,
      name: row.name,
      keyEnv: row.key_env as ApiKeyEnv,
      keyPrefix: row.key_prefix,
      keyHash: row.key_hash,
      keyHint: row.key_hint,
      budgetUsd: row.budget_usd,
      spentUsd: Number(row.spent_usd) || 0,
      expiresAt: row.expires_at,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  private insertApiKeyRow(input: {
    id: string;
    name: string;
    keyEnv: ApiKeyEnv;
    plaintext: string;
    budgetUsd?: number | null;
    expiresAt?: number | null;
    enabled?: boolean;
    createdAt?: number;
  }): ApiKeyRecord {
    const createdAt = input.createdAt ?? Date.now();
    const keyPrefix = keyPrefixForEnv(input.keyEnv);
    const keyHash = hashApiKey(input.plaintext);
    const keyHint = apiKeyHint(input.plaintext);

    this.db
      .prepare(
        `INSERT INTO api_keys
          (id, name, key_env, key_prefix, key_hash, key_hint, budget_usd, spent_usd, expires_at, enabled, created_at, last_used_at)
         VALUES
          (@id, @name, @keyEnv, @keyPrefix, @keyHash, @keyHint, @budgetUsd, 0, @expiresAt, @enabled, @createdAt, NULL)`
      )
      .run({
        id: input.id,
        name: input.name,
        keyEnv: input.keyEnv,
        keyPrefix,
        keyHash,
        keyHint,
        budgetUsd: input.budgetUsd ?? null,
        expiresAt: input.expiresAt ?? null,
        enabled: input.enabled === false ? 0 : 1,
        createdAt,
      });

    return this.mapApiKeyRow(
      this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(input.id) as ApiKeyRow
    );
  }

  private seedApiKeys(config: Config): void {
    const countRow = this.db.prepare('SELECT COUNT(*) AS c FROM api_keys').get() as { c: number };
    if (countRow.c > 0) return;

    const legacyPlain =
      (config.apiKeyEnv && config.apiKeyEnv.trim()) || this.getSettingSync('api_key')?.trim() || null;

    let plaintext: string;
    let keyEnv: ApiKeyEnv;
    let name: string;

    if (legacyPlain) {
      plaintext = legacyPlain;
      keyEnv = normalizeImportedKeyEnv(plaintext);
      name = 'Default';
    } else {
      keyEnv = process.env.NODE_ENV === 'production' ? 'pro' : 'dev';
      plaintext = generateClientApiKey(keyEnv);
      name = 'Default';
    }

    this.insertApiKeyRow({
      id: randomId('key'),
      name,
      keyEnv,
      plaintext,
    });

    // Store plaintext once so startup / UI can show the real key after first boot.
    this.setSettingSync('api_key_bootstrap', plaintext);
  }

  private loadPricingOverridesIntoRuntime(): void {
    const raw = this.getSettingSync('pricing_overrides');
    if (!raw) {
      applyPricingOverrides({});
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, ModelPricing>;
      applyPricingOverrides(parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      applyPricingOverrides({});
    }
  }

  private seed(config: Config): void {
    if (!this.getSettingSync('active_mode')) {
      this.setSettingSync('active_mode', 'smart');
    }

    this.seedApiKeys(config);

    const insertProvider = this.db.prepare(`
      INSERT OR IGNORE INTO providers
        (id, label, enabled, tier, base_url, api_key, default_model, allowed_modes, capabilities,
         protocol, auth_style, benchmark_model, verify_status, verify_error, verified_at,
         source, catalog_ready, extra_headers, timeout_ms)
      VALUES
        (@id, @label, @enabled, @tier, @baseUrl, @apiKey, @defaultModel, @allowedModes, @capabilities,
         @protocol, @authStyle, @benchmarkModel, @verifyStatus, @verifyError, @verifiedAt,
         @source, @catalogReady, @extraHeaders, @timeoutMs)
    `);

    const applySeedPatch = this.db.prepare(`
      UPDATE providers SET
        label = COALESCE(@label, label),
        protocol = COALESCE(@protocol, protocol),
        auth_style = COALESCE(@authStyle, auth_style),
        source = COALESCE(@source, source),
        catalog_ready = COALESCE(@catalogReady, catalog_ready),
        extra_headers = CASE WHEN @setExtraHeaders = 1 THEN @extraHeaders ELSE extra_headers END,
        timeout_ms = CASE WHEN @setTimeoutMs = 1 THEN @timeoutMs ELSE timeout_ms END,
        capabilities = COALESCE(@capabilities, capabilities),
        base_url = CASE WHEN @setBaseUrl = 1 THEN @baseUrl ELSE base_url END,
        default_model = CASE WHEN @setDefaultModel = 1 THEN @defaultModel ELSE default_model END,
        benchmark_model = CASE WHEN @setBenchmarkModel = 1 THEN @benchmarkModel ELSE benchmark_model END
      WHERE id = @id
    `);

    const paid = resolvePaidUpstreamSeed(config);
    const seedUpdates: Array<{ id: string; changedKeys: string[] }> = [];

    for (const p of DEFAULT_PROVIDERS) {
      const baseUrl = p.id === 'paid-upstream' ? paid.baseUrl ?? p.baseUrl : p.baseUrl;
      const apiKey = p.id === 'paid-upstream' ? paid.apiKey : null;
      const defaultModel =
        p.id === 'paid-upstream' ? paid.defaultModel ?? p.defaultModel : p.defaultModel;

      insertProvider.run({
        id: p.id,
        label: p.label,
        enabled: p.enabled ? 1 : 0,
        tier: p.tier,
        baseUrl,
        apiKey: this.sealApiKey(apiKey),
        defaultModel,
        allowedModes: JSON.stringify(p.allowedModes),
        capabilities: JSON.stringify(p.capabilities),
        protocol: p.protocol,
        authStyle: p.authStyle,
        benchmarkModel: p.benchmarkModel ?? defaultModel,
        verifyStatus: p.verifyStatus,
        verifyError: p.verifyError,
        verifiedAt: p.verifiedAt,
        source: p.source,
        catalogReady: p.catalogReady ? 1 : 0,
        extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
        timeoutMs: p.timeoutMs,
      });

      const catalog = getCatalogEntry(p.id);
      const existing = this.mapProvider(
        this.db.prepare('SELECT * FROM providers WHERE id = ?').get(p.id) as Record<
          string,
          unknown
        >
      );
      if (!catalog || !existing) continue;

      const existingSnap: SeedExistingSnapshot = {
        label: existing.label,
        baseUrl: existing.baseUrl,
        authStyle: existing.authStyle,
        protocol: existing.protocol,
        source: existing.source,
        extraHeaders: existing.extraHeaders,
        catalogReady: existing.catalogReady,
        capabilities: existing.capabilities,
        timeoutMs: existing.timeoutMs,
        defaultModel: existing.defaultModel,
        benchmarkModel: existing.benchmarkModel,
      };

      const result = buildProviderSeedPatch(catalog, existingSnap, {
        forceCatalogOwned: shouldForceCatalogOwned(p.id),
        providerId: p.id,
      });
      if (!result) continue;

      const { patch, changedKeys } = result;
      applySeedPatch.run({
        id: p.id,
        label: patch.label ?? null,
        protocol: patch.protocol ?? null,
        authStyle: patch.authStyle ?? null,
        source: patch.source ?? null,
        catalogReady:
          patch.catalogReady === undefined ? null : patch.catalogReady ? 1 : 0,
        setExtraHeaders: patch.extraHeaders !== undefined ? 1 : 0,
        extraHeaders:
          patch.extraHeaders === undefined
            ? null
            : patch.extraHeaders
              ? JSON.stringify(patch.extraHeaders)
              : null,
        setTimeoutMs: patch.timeoutMs !== undefined ? 1 : 0,
        timeoutMs: patch.timeoutMs ?? null,
        capabilities:
          patch.capabilities !== undefined ? JSON.stringify(patch.capabilities) : null,
        setBaseUrl: patch.baseUrl !== undefined ? 1 : 0,
        baseUrl: patch.baseUrl ?? null,
        setDefaultModel: patch.defaultModel !== undefined ? 1 : 0,
        defaultModel: patch.defaultModel ?? null,
        setBenchmarkModel: patch.benchmarkModel !== undefined ? 1 : 0,
        benchmarkModel: patch.benchmarkModel ?? null,
      });
      seedUpdates.push({ id: p.id, changedKeys: [...changedKeys] });
    }

    if (seedUpdates.length > 0) {
      console.log(`[storage] ${formatSeedSyncSummary(seedUpdates)}`);
    }

    if (config.upstreamBaseUrl) {
      this.db
        .prepare(
          `UPDATE providers SET base_url = ?, api_key = COALESCE(?, api_key),
           default_model = COALESCE(?, default_model), enabled = 1
           WHERE id = 'paid-upstream'`
        )
        .run(
          config.upstreamBaseUrl,
          this.sealApiKey(config.upstreamApiKey),
          config.upstreamModel
        );
    }

    const insertAgent = this.db.prepare(`
      INSERT OR IGNORE INTO agents (id, nickname, enabled, model, mode, desk_id)
      VALUES (@id, @nickname, @enabled, @model, @mode, @deskId)
    `);

    for (const agent of DEFAULT_AGENTS) {
      if (!DEFAULT_AGENT_ROLES.includes(agent.id)) continue;
      insertAgent.run({
        id: agent.id,
        nickname: agent.nickname,
        enabled: agent.enabled ? 1 : 0,
        model: agent.model,
        mode: agent.mode,
        deskId: agent.deskId,
      });
    }

    migrateCatalogModelsV1(this.db);
  }

  async getSetting(key: string): Promise<string | null> {
    return this.getSettingSync(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.setSettingSync(key, value);
  }

  async getActiveMode(): Promise<HubMode> {
    const mode = (await this.getSetting('active_mode')) ?? 'smart';
    return (HUB_MODES.includes(mode as HubMode) ? mode : 'smart') as HubMode;
  }

  async setActiveMode(mode: HubMode): Promise<void> {
    await this.setSetting('active_mode', mode);
  }

  async getUnifiedApiKey(): Promise<string> {
    const bootstrap = await this.getSetting('api_key_bootstrap');
    if (bootstrap) return bootstrap;

    const first = this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at ASC, id ASC LIMIT 1')
      .get() as ApiKeyRow | undefined;
    if (first) return toPublicKey(this.mapApiKeyRow(first)).keyPreview;

    throw new Error('API key missing from settings');
  }

  private mapProvider(row: Record<string, unknown>): ProviderToggle {
    let extraHeaders: Record<string, string> | null = null;
    if (row.extra_headers != null && String(row.extra_headers).trim()) {
      try {
        extraHeaders = JSON.parse(String(row.extra_headers)) as Record<string, string>;
      } catch {
        extraHeaders = null;
      }
    }
    return {
      id: String(row.id),
      label: String(row.label),
      enabled: Boolean(row.enabled),
      tier: Number(row.tier) as 1 | 2 | 3,
      baseUrl: row.base_url == null ? null : String(row.base_url),
      apiKey: this.openApiKey(row.api_key == null ? null : String(row.api_key)),
      defaultModel: row.default_model == null ? null : String(row.default_model),
      allowedModes: JSON.parse(String(row.allowed_modes)) as HubMode[],
      capabilities: JSON.parse(String(row.capabilities ?? '[]')) as string[],
      protocol: String(row.protocol ?? 'openai') as ProviderToggle['protocol'],
      authStyle: String(row.auth_style ?? 'bearer') as ProviderToggle['authStyle'],
      benchmarkModel:
        row.benchmark_model == null
          ? row.default_model == null
            ? null
            : String(row.default_model)
          : String(row.benchmark_model),
      pinnedModels: (() => {
        const raw = row.pinned_models;
        if (raw == null || raw === '') return [];
        try {
          const parsed = JSON.parse(String(raw));
          return Array.isArray(parsed)
            ? parsed.map((x) => String(x).trim()).filter(Boolean)
            : [];
        } catch {
          return [];
        }
      })(),
      verifyStatus: String(row.verify_status ?? 'never') as ProviderToggle['verifyStatus'],
      verifyError: row.verify_error == null ? null : String(row.verify_error),
      verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
      source: String(row.source ?? 'builtin'),
      catalogReady: row.catalog_ready == null ? true : Boolean(row.catalog_ready),
      extraHeaders,
      timeoutMs: row.timeout_ms == null ? null : Number(row.timeout_ms),
      authMode: String(row.auth_mode ?? 'none') as ProviderToggle['authMode'],
      oauthState: String(row.oauth_state ?? 'none') as ProviderToggle['oauthState'],
    };
  }

  async listProviders(): Promise<ProviderToggle[]> {
    const rows = this.db
      .prepare('SELECT * FROM providers ORDER BY tier ASC, id ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapProvider(r));
  }

  async getProvider(id: string): Promise<ProviderToggle | null> {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapProvider(row) : null;
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

    if (enabled && verifyStatus !== 'ok') {
      // Caller should gate; storage still allows explicit verifyStatus+enabled together.
      if (patch.enabled === true && patch.verifyStatus !== 'ok') {
        enabled = false;
      }
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
        patch.benchmarkModel === undefined
          ? existing.benchmarkModel
          : patch.benchmarkModel,
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
      authMode: patch.authMode ?? existing.authMode,
      oauthState: patch.oauthState ?? existing.oauthState,
    };

    this.db
      .prepare(
        `UPDATE providers SET
          enabled = ?, label = ?, tier = ?, base_url = ?, api_key = ?,
          default_model = ?, allowed_modes = ?, capabilities = ?,
          benchmark_model = ?, pinned_models = ?, verify_status = ?, verify_error = ?, verified_at = ?,
          auth_mode = ?, oauth_state = ?
         WHERE id = ?`
      )
      .run(
        next.enabled ? 1 : 0,
        next.label,
        next.tier,
        next.baseUrl,
        this.sealApiKey(next.apiKey),
        next.defaultModel,
        JSON.stringify(next.allowedModes),
        JSON.stringify(next.capabilities),
        next.benchmarkModel,
        JSON.stringify(next.pinnedModels),
        next.verifyStatus,
        next.verifyError,
        next.verifiedAt,
        next.authMode,
        next.oauthState,
        id
      );

    return this.getProvider(id);
  }

  private mapAgent(row: Record<string, unknown>): AgentConfig {
    return {
      id: String(row.id) as AgentRole,
      nickname: String(row.nickname),
      enabled: Boolean(row.enabled),
      model: String(row.model),
      mode: String(row.mode) as HubMode,
      deskId: row.desk_id == null ? null : String(row.desk_id),
    };
  }

  async listAgents(): Promise<AgentConfig[]> {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY id ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapAgent(r));
  }

  async getAgent(id: string): Promise<AgentConfig | null> {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapAgent(row) : null;
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

    this.db
      .prepare(
        `UPDATE agents SET nickname = ?, enabled = ?, model = ?, mode = ?, desk_id = ?
         WHERE id = ?`
      )
      .run(
        next.nickname,
        next.enabled ? 1 : 0,
        next.model,
        next.mode,
        next.deskId,
        id
      );

    return this.getAgent(id);
  }

  async listApiKeys(): Promise<ApiKeyPublic[]> {
    const rows = this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at ASC, id ASC')
      .all() as ApiKeyRow[];
    return rows.map((r) => toPublicKey(this.mapApiKeyRow(r)));
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as
      | ApiKeyRow
      | undefined;
    return row ? this.mapApiKeyRow(row) : null;
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash) as
      | ApiKeyRow
      | undefined;
    return row ? this.mapApiKeyRow(row) : null;
  }

  async createApiKey(
    input: CreateApiKeyInput
  ): Promise<{ record: ApiKeyPublic; plaintext: string }> {
    const plaintext = input.plaintext?.trim() || generateClientApiKey(input.keyEnv);
    const record = this.insertApiKeyRow({
      id: input.id?.trim() || randomId('key'),
      name: input.name,
      keyEnv: input.keyEnv,
      plaintext,
      budgetUsd: input.budgetUsd,
      expiresAt: input.expiresAt,
    });
    return { record: toPublicKey(record), plaintext };
  }

  async updateApiKey(id: string, patch: ApiKeyPatch): Promise<ApiKeyPublic | null> {
    const existing = await this.getApiKeyById(id);
    if (!existing) return null;

    const next = {
      name: patch.name ?? existing.name,
      budgetUsd: patch.budgetUsd === undefined ? existing.budgetUsd : patch.budgetUsd,
      expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
      enabled: patch.enabled ?? existing.enabled,
    };

    this.db
      .prepare(
        `UPDATE api_keys SET name = ?, budget_usd = ?, expires_at = ?, enabled = ?
         WHERE id = ?`
      )
      .run(next.name, next.budgetUsd, next.expiresAt, next.enabled ? 1 : 0, id);

    const updated = await this.getApiKeyById(id);
    return updated ? toPublicKey(updated) : null;
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async addApiKeySpend(id: string, costUsd: number): Promise<ApiKeyRecord | null> {
    const existing = await this.getApiKeyById(id);
    if (!existing) return null;

    const add = Number(costUsd) || 0;
    this.db
      .prepare('UPDATE api_keys SET spent_usd = spent_usd + ? WHERE id = ?')
      .run(add, id);

    return this.getApiKeyById(id);
  }

  async touchApiKey(id: string): Promise<void> {
    this.db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  async recordUsage(
    event: Omit<UsageEvent, 'id' | 'createdAt'> & { id?: string }
  ): Promise<UsageEvent> {
    const id = event.id ?? randomId('usage');
    const createdAt = Date.now();
    const underlyingModels = Array.isArray(event.underlyingModels) ? event.underlyingModels : [];
    const source = (event.source ?? 'api') as UsageEventSource;
    const status = (event.status ?? 'complete') as UsageEventStatus;
    const requestId = event.requestId || `legacy_${id}`;
    const costMicrosUsd = Math.round(Number(event.costMicrosUsd) || 0);
    const row: UsageEvent = {
      id,
      requestId,
      source,
      apiKeyId: event.apiKeyId ?? null,
      status,
      model: event.model,
      underlyingModels,
      providerId: event.providerId ?? null,
      costMicrosUsd,
      promptTokens: event.promptTokens ?? null,
      completionTokens: event.completionTokens ?? null,
      estimated: Boolean(event.estimated),
      createdAt,
    };

    try {
      this.db
        .prepare(
          `INSERT INTO usage_events
            (id, request_id, source, api_key_id, status, model, underlying_models,
             provider_id, cost_micros_usd, prompt_tokens, completion_tokens, estimated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.id,
          row.requestId,
          row.source,
          row.apiKeyId,
          row.status,
          row.model,
          JSON.stringify(underlyingModels),
          row.providerId,
          row.costMicrosUsd,
          row.promptTokens,
          row.completionTokens,
          row.estimated ? 1 : 0,
          createdAt
        );
    } catch (err) {
      // Unique (source, request_id) — idempotent on retry
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) {
        const existing = this.db
          .prepare(
            `SELECT * FROM usage_events WHERE source = ? AND request_id = ? LIMIT 1`
          )
          .get(source, requestId) as UsageRow | undefined;
        if (existing) return this.mapUsageRow(existing);
      }
      throw err;
    }

    return row;
  }

  private mapUsageRow(row: UsageRow): UsageEvent {
    let underlyingModels: string[] = [];
    try {
      const parsed = JSON.parse(row.underlying_models);
      underlyingModels = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      underlyingModels = [];
    }
    return {
      id: row.id,
      requestId: row.request_id,
      source: (row.source === 'admin_chat' ? 'admin_chat' : 'api') as UsageEventSource,
      apiKeyId: row.api_key_id,
      status: (['complete', 'stopped', 'error'].includes(row.status)
        ? row.status
        : 'complete') as UsageEventStatus,
      model: row.model,
      underlyingModels,
      providerId: row.provider_id,
      costMicrosUsd: Number(row.cost_micros_usd) || 0,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      estimated: Boolean(row.estimated),
      createdAt: row.created_at,
    };
  }

  async listUsage(opts?: { apiKeyId?: string; limit?: number }): Promise<UsageEvent[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    const rows = (
      opts?.apiKeyId
        ? this.db
            .prepare(
              `SELECT * FROM usage_events WHERE api_key_id = ?
               ORDER BY created_at DESC LIMIT ?`
            )
            .all(opts.apiKeyId, limit)
        : this.db
            .prepare(`SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?`)
            .all(limit)
    ) as UsageRow[];

    return rows.map((row) => this.mapUsageRow(row));
  }

  async getPricingOverrides(): Promise<Record<string, ModelPricing>> {
    const raw = await this.getSetting('pricing_overrides');
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
    await this.setSetting('pricing_overrides', JSON.stringify(next));
    applyPricingOverrides(next);
  }

  async listHubModels(opts?: ListHubModelsOpts): Promise<ListHubModelsResult> {
    return listHubModelsSync(this.db, opts);
  }

  async getHubModel(id: string): Promise<StoredHubModel | null> {
    return getHubModelSync(this.db, id);
  }

  async createHubModel(input: CreateHubModelInput): Promise<StoredHubModel> {
    return createHubModelSync(this.db, input);
  }

  async updateHubModel(id: string, patch: UpdateHubModelInput): Promise<StoredHubModel> {
    return updateHubModelSync(this.db, id, patch);
  }

  async deleteHubModel(id: string): Promise<boolean> {
    return deleteHubModelSync(this.db, id);
  }

  async setHubModelDefault(catalogId: string): Promise<StoredHubModel> {
    return setHubModelDefaultSync(this.db, catalogId);
  }

  async setHubModelBenchmark(catalogId: string): Promise<StoredHubModel> {
    return setHubModelBenchmarkSync(this.db, catalogId);
  }

  async importHubModels(input: ImportHubModelsInput): Promise<ImportHubModelsResult> {
    return importHubModelsSync(this.db, input);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
