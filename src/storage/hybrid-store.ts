import { randomUUID } from 'node:crypto';
import type { AgentConfig, HubMode, ProviderToggle } from '../types.js';
import type {
  ApiKeyPublic,
  ApiKeyRecord,
  CreateApiKeyInput,
  ModelPricing,
  UsageEvent,
} from '../keys/types.js';
import {
  apiKeyHint,
  generateClientApiKey,
  hashApiKey,
  keyPrefixForEnv,
  toPublicKey,
} from '../keys/generate.js';
import type {
  CreateHubModelInput,
  ImportHubModelsInput,
  ImportHubModelsResult,
  ListHubModelsOpts,
  ListHubModelsResult,
  StoredHubModel,
  UpdateHubModelInput,
} from '../models/types.js';
import {
  createControlPlane,
  finishReconcile,
  recordRemoteFailure,
  recordRemoteSuccess,
  toControlHealth,
  type ControlHealthSnapshot,
  type ControlOutboxAction,
  type ControlOutboxEntity,
  type ControlOutboxOp,
  type ControlPlaneSnapshot,
} from './control-plane.js';
import type { ControlVault } from './control-vault.js';
import type { SqliteConfigStore } from './sqlite-store.js';
import type {
  AgentPatch,
  ApiKeyPatch,
  ConfigStore,
  ConnectorCredentialRecord,
  ConnectorCredentialState,
  ConnectorCredentialUpdate,
  ProviderPatch,
  ToolRunCreate,
  ToolRunListOptions,
  ToolRunRecord,
} from './types.js';
import type { RegisteredConnectorId } from '../tools/types.js';
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

export type HybridConfigStoreOptions = {
  control: ConfigStore;
  workspace: SqliteConfigStore;
  vault: ControlVault;
  hybrid: boolean;
};

function applyProviderPatch(existing: ProviderToggle, patch: ProviderPatch): ProviderToggle {
  return {
    ...existing,
    enabled: patch.enabled ?? existing.enabled,
    label: patch.label ?? existing.label,
    tier: patch.tier ?? existing.tier,
    baseUrl: patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl,
    apiKey: patch.apiKey === undefined ? existing.apiKey : patch.apiKey,
    defaultModel:
      patch.defaultModel === undefined ? existing.defaultModel : patch.defaultModel,
    benchmarkModel:
      patch.benchmarkModel === undefined ? existing.benchmarkModel : patch.benchmarkModel,
    pinnedModels: patch.pinnedModels ?? existing.pinnedModels,
    allowedModes: patch.allowedModes ?? existing.allowedModes,
    capabilities: patch.capabilities ?? existing.capabilities,
    verifyStatus: patch.verifyStatus ?? existing.verifyStatus,
    verifyError: patch.verifyError === undefined ? existing.verifyError : patch.verifyError,
    verifiedAt: patch.verifiedAt === undefined ? existing.verifiedAt : patch.verifiedAt,
    authMode: patch.authMode ?? existing.authMode,
    oauthState: patch.oauthState ?? existing.oauthState,
  };
}

export class HybridConfigStore implements ConfigStore {
  readonly backend: 'sqlite' | 'supabase';
  private control: ConfigStore;
  private readonly workspace: SqliteConfigStore;
  private readonly vault: ControlVault;
  private readonly hybrid: boolean;
  private plane: ControlPlaneSnapshot;
  /** Ensures outbox replay order when several ops share the same wall-clock ms. */
  private lastOutboxCreatedAt = 0;

  constructor(opts: HybridConfigStoreOptions) {
    this.control = opts.control;
    this.workspace = opts.workspace;
    this.vault = opts.vault;
    this.hybrid = opts.hybrid;
    this.backend = opts.hybrid ? opts.control.backend : 'sqlite';
    this.plane = createControlPlane();
  }

  setControlForTests(control: ConfigStore): void {
    this.control = control;
  }

  getControlHealth(): ControlHealthSnapshot {
    return toControlHealth(this.plane, this.vault.pendingOutboxCount());
  }

  getPlane(): ControlPlaneSnapshot {
    return this.plane;
  }

  setPlaneForTests(plane: ControlPlaneSnapshot): void {
    this.plane = plane;
  }

  private controlStore(): ConfigStore {
    return this.hybrid ? this.control : this.workspace;
  }

  private isDegraded(): boolean {
    return this.hybrid && this.plane.state === 'degraded';
  }

  /** Prefer vault for reads while degraded or reconciling (/v1 stays available). */
  private useVaultReads(): boolean {
    return (
      this.hybrid &&
      (this.plane.state === 'degraded' || this.plane.state === 'reconciling')
    );
  }

  private assertNotReconciling(): void {
    if (this.hybrid && this.plane.state === 'reconciling') {
      throw new Error('Control plane is reconciling; control mutations temporarily locked');
    }
  }

  private enqueue(
    entity: ControlOutboxEntity,
    action: ControlOutboxAction,
    entityId: string,
    payload: Record<string, unknown>
  ): void {
    const createdAt = Math.max(Date.now(), this.lastOutboxCreatedAt + 1);
    this.lastOutboxCreatedAt = createdAt;
    const op: ControlOutboxOp = {
      opId: randomUUID(),
      entity,
      action,
      entityId,
      payload,
      createdAt,
      appliedAt: null,
    };
    this.vault.enqueueOutbox(op);
  }

  private async mirrorProvider(id: string): Promise<void> {
    const row = await this.controlStore().getProvider(id);
    if (row) this.vault.upsertProvider(row);
    else this.vault.deleteProvider(id);
  }

  private async mirrorApiKey(id: string): Promise<void> {
    const row = await this.controlStore().getApiKeyById(id);
    if (row) this.vault.upsertApiKey(row);
    else this.vault.deleteApiKey(id);
  }

  private async mirrorAgent(id: string): Promise<void> {
    const row = await this.controlStore().getAgent(id);
    if (row) this.vault.upsertAgent(row);
  }

  private async pullControlIntoVault(): Promise<void> {
    const store = this.controlStore();
    const remoteProviders = await store.listProviders();
    const remoteProviderIds = new Set(remoteProviders.map((p) => p.id));
    for (const p of remoteProviders) this.vault.upsertProvider(p);
    for (const p of this.vault.listProviders()) {
      if (!remoteProviderIds.has(p.id)) this.vault.deleteProvider(p.id);
    }

    const remoteKeys = await store.listApiKeys();
    const remoteKeyIds = new Set(remoteKeys.map((k) => k.id));
    for (const k of remoteKeys) {
      const full = await store.getApiKeyById(k.id);
      if (full) this.vault.upsertApiKey(full);
    }
    for (const k of this.vault.listApiKeys()) {
      if (!remoteKeyIds.has(k.id)) this.vault.deleteApiKey(k.id);
    }

    for (const a of await store.listAgents()) this.vault.upsertAgent(a);
    const connectorCredential = await store.getConnectorCredentialRecord('tinyfish');
    if (connectorCredential) this.vault.upsertConnectorCredential(connectorCredential);
    else this.vault.deleteConnectorCredential('tinyfish');
    const mode = await store.getActiveMode();
    this.vault.setSetting('active_mode', mode);
    this.vault.setMeta({ lastSyncAt: Date.now(), generation: this.vault.getMeta().generation + 1 });
  }

  async refreshVaultFromControl(): Promise<void> {
    await this.pullControlIntoVault();
    this.plane = recordRemoteSuccess(this.plane, Date.now());
    if (this.plane.state === 'reconciling') {
      this.plane = finishReconcile(this.plane, Date.now());
    }
  }

  private async applyOutboxOp(op: ControlOutboxOp): Promise<void> {
    const { entity, action, entityId, payload } = op;

    if (entity === 'api_key' && action === 'add') {
      const existing = await this.control.getApiKeyById(entityId);
      if (existing) return;
      const plaintext = typeof payload.plaintext === 'string' ? payload.plaintext.trim() : '';
      if (!plaintext) {
        throw new Error(`Outbox api_key add ${entityId}: plaintext missing from payload`);
      }
      const record = payload.record as ApiKeyRecord | undefined;
      if (!record || typeof record !== 'object') {
        throw new Error(`Outbox api_key add ${entityId}: record missing from payload`);
      }
      await this.control.createApiKey({
        id: record.id || entityId,
        name: record.name,
        keyEnv: record.keyEnv,
        budgetUsd: record.budgetUsd,
        expiresAt: record.expiresAt,
        plaintext,
      });
      return;
    }

    if (entity === 'api_key' && action === 'modify') {
      const record = payload.record as ApiKeyRecord | undefined;
      if (!record || typeof record !== 'object') {
        throw new Error(`Outbox api_key modify ${entityId}: record missing from payload`);
      }
      await this.control.updateApiKey(entityId, {
        name: record.name,
        budgetUsd: record.budgetUsd,
        expiresAt: record.expiresAt,
        enabled: record.enabled,
      });
      return;
    }

    if (entity === 'api_key' && action === 'delete') {
      await this.control.deleteApiKey(entityId);
      return;
    }

    if (entity === 'provider' && action === 'modify') {
      const provider = payload.provider as ProviderToggle | undefined;
      if (!provider || typeof provider !== 'object') {
        throw new Error(`Outbox provider modify ${entityId}: provider missing from payload`);
      }
      const patch: ProviderPatch = {
        enabled: provider.enabled,
        label: provider.label,
        tier: provider.tier,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        defaultModel: provider.defaultModel,
        benchmarkModel: provider.benchmarkModel,
        pinnedModels: provider.pinnedModels,
        allowedModes: provider.allowedModes,
        capabilities: provider.capabilities,
        verifyStatus: provider.verifyStatus,
        verifyError: provider.verifyError,
        verifiedAt: provider.verifiedAt,
      };
      await this.control.updateProvider(entityId, patch);
      return;
    }

    if (entity === 'agent' && action === 'modify') {
      const agent = payload.agent as AgentConfig | undefined;
      if (!agent || typeof agent !== 'object') {
        throw new Error(`Outbox agent modify ${entityId}: agent missing from payload`);
      }
      const patch: AgentPatch = {
        nickname: agent.nickname,
        enabled: agent.enabled,
        model: agent.model,
        mode: agent.mode,
        deskId: agent.deskId,
      };
      await this.control.updateAgent(entityId, patch);
      return;
    }

    if (entity === 'setting' && action === 'modify') {
      const key = typeof payload.key === 'string' ? payload.key : entityId;
      const value = payload.value;
      if (typeof value !== 'string') {
        throw new Error(`Outbox setting modify ${entityId}: value must be a string`);
      }
      await this.control.setSetting(key, value);
      return;
    }

    if (entity === 'connector_credential' && action === 'modify') {
      const record = payload.record as ConnectorCredentialRecord | undefined;
      if (!record || typeof record !== 'object' || record.connectorId !== entityId) {
        throw new Error(`Outbox connector credential ${entityId}: encrypted record missing`);
      }
      await this.control.putConnectorCredentialRecord(record);
      return;
    }

    if (entity === 'connector_credential' && action === 'delete') {
      await this.control.updateConnectorCredential(entityId as RegisteredConnectorId, {
        secret: null,
      });
      return;
    }

    // Unknown entity/action combo — ignore safely
  }

  async reconcile(): Promise<ControlHealthSnapshot> {
    if (!this.hybrid) return this.getControlHealth();

    const pending = this.vault.pendingOutboxCount();
    if (
      this.plane.state !== 'degraded' &&
      this.plane.state !== 'reconciling' &&
      pending === 0
    ) {
      return this.getControlHealth();
    }

    if (this.plane.state === 'degraded') {
      this.plane = recordRemoteSuccess(this.plane, Date.now());
    } else if (this.plane.state === 'online' && pending > 0) {
      this.plane = { ...this.plane, state: 'reconciling', vault: 'replaying' };
    }

    for (const op of this.vault.listPendingOutbox()) {
      await this.applyOutboxOp(op);
      this.vault.markOutboxApplied(op.opId, Date.now());
    }

    await this.pullControlIntoVault();
    this.plane = finishReconcile(this.plane, Date.now());
    return this.getControlHealth();
  }

  private noteRemoteOk(): void {
    if (!this.hybrid) return;
    this.plane = recordRemoteSuccess(this.plane, Date.now());
  }

  private noteRemoteFail(): void {
    if (!this.hybrid) return;
    this.plane = recordRemoteFailure(this.plane, Date.now());
  }

  private async withRemoteControl<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.hybrid) return fn();
    try {
      const result = await fn();
      this.noteRemoteOk();
      return result;
    } catch (err) {
      this.noteRemoteFail();
      throw err;
    }
  }

  async getSetting(key: string): Promise<string | null> {
    if (this.useVaultReads()) return this.vault.getSetting(key);
    return this.withRemoteControl(() => this.controlStore().getSetting(key));
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      this.vault.setSetting(key, value);
      this.enqueue('setting', 'modify', key, { key, value });
      return;
    }
    await this.withRemoteControl(async () => {
      await this.controlStore().setSetting(key, value);
      if (this.hybrid) this.vault.setSetting(key, value);
    });
  }

  async getConnectorCredentialRecord(
    connectorId: RegisteredConnectorId,
  ): Promise<ConnectorCredentialRecord | null> {
    if (this.useVaultReads()) return this.vault.getConnectorCredential(connectorId);
    return this.withRemoteControl(() =>
      this.controlStore().getConnectorCredentialRecord(connectorId)
    );
  }

  async putConnectorCredentialRecord(record: ConnectorCredentialRecord): Promise<void> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      await this.workspace.putConnectorCredentialRecord(record);
      this.enqueue('connector_credential', 'modify', record.connectorId, {
        record: record as unknown as Record<string, unknown>,
      });
      return;
    }
    await this.withRemoteControl(async () => {
      await this.controlStore().putConnectorCredentialRecord(record);
      if (this.hybrid) this.vault.upsertConnectorCredential(record);
    });
  }

  async getConnectorCredentialSecret(
    connectorId: RegisteredConnectorId,
  ): Promise<string | null> {
    if (this.useVaultReads()) {
      return this.workspace.getConnectorCredentialSecret(connectorId);
    }
    return this.withRemoteControl(() =>
      this.controlStore().getConnectorCredentialSecret(connectorId)
    );
  }

  async getConnectorCredentialState(
    connectorId: RegisteredConnectorId,
  ): Promise<ConnectorCredentialState> {
    if (this.useVaultReads()) {
      return this.workspace.getConnectorCredentialState(connectorId);
    }
    return this.withRemoteControl(() =>
      this.controlStore().getConnectorCredentialState(connectorId)
    );
  }

  async updateConnectorCredential(
    connectorId: RegisteredConnectorId,
    update: ConnectorCredentialUpdate,
  ): Promise<ConnectorCredentialState> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      const state = await this.workspace.updateConnectorCredential(connectorId, update);
      if (update.secret === undefined) return state;
      const record = await this.workspace.getConnectorCredentialRecord(connectorId);
      if (record) {
        this.enqueue('connector_credential', 'modify', connectorId, {
          record: record as unknown as Record<string, unknown>,
        });
      } else {
        this.enqueue('connector_credential', 'delete', connectorId, {});
      }
      return state;
    }
    return this.withRemoteControl(async () => {
      const state = await this.controlStore().updateConnectorCredential(connectorId, update);
      if (this.hybrid) {
        const record = await this.controlStore().getConnectorCredentialRecord(connectorId);
        if (record) this.vault.upsertConnectorCredential(record);
        else this.vault.deleteConnectorCredential(connectorId);
      }
      return state;
    });
  }

  async getActiveMode(): Promise<HubMode> {
    if (this.useVaultReads()) {
      const v = this.vault.getSetting('active_mode');
      return (v as HubMode) || 'smart';
    }
    return this.withRemoteControl(() => this.controlStore().getActiveMode());
  }

  async setActiveMode(mode: HubMode): Promise<void> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      this.vault.setSetting('active_mode', mode);
      this.enqueue('setting', 'modify', 'active_mode', { key: 'active_mode', value: mode });
      return;
    }
    await this.withRemoteControl(async () => {
      await this.controlStore().setActiveMode(mode);
      if (this.hybrid) this.vault.setSetting('active_mode', mode);
    });
  }

  async getUnifiedApiKey(): Promise<string> {
    if (this.useVaultReads()) {
      const bootstrap = this.vault.getSetting('api_key_bootstrap');
      if (bootstrap) return bootstrap;
      const first = this.vault.listApiKeys()[0];
      if (first) return toPublicKey(first).keyPreview;
      throw new Error('API key missing from settings');
    }
    return this.withRemoteControl(() => this.controlStore().getUnifiedApiKey());
  }

  async listProviders(): Promise<ProviderToggle[]> {
    if (this.useVaultReads()) return this.vault.listProviders();
    return this.withRemoteControl(() => this.controlStore().listProviders());
  }

  async getProvider(id: string): Promise<ProviderToggle | null> {
    if (this.useVaultReads()) return this.vault.getProvider(id);
    return this.withRemoteControl(() => this.controlStore().getProvider(id));
  }

  async updateProvider(id: string, patch: ProviderPatch): Promise<ProviderToggle | null> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      const existing = this.vault.getProvider(id);
      if (!existing) return null;
      const updated = applyProviderPatch(existing, patch);
      this.vault.upsertProvider(updated);
      this.enqueue('provider', 'modify', id, { provider: updated as unknown as Record<string, unknown> });
      return updated;
    }
    return this.withRemoteControl(async () => {
      const updated = await this.controlStore().updateProvider(id, patch);
      if (this.hybrid && updated) await this.mirrorProvider(id);
      return updated;
    });
  }

  async listAgents(): Promise<AgentConfig[]> {
    if (this.useVaultReads()) return this.vault.listAgents();
    return this.withRemoteControl(() => this.controlStore().listAgents());
  }

  async getAgent(id: string): Promise<AgentConfig | null> {
    if (this.useVaultReads()) {
      return this.vault.listAgents().find((a) => a.id === id) ?? null;
    }
    return this.withRemoteControl(() => this.controlStore().getAgent(id));
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<AgentConfig | null> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      const existing = this.vault.listAgents().find((a) => a.id === id) ?? null;
      if (!existing) return null;
      const updated: AgentConfig = {
        ...existing,
        nickname: patch.nickname ?? existing.nickname,
        enabled: patch.enabled ?? existing.enabled,
        model: patch.model ?? existing.model,
        mode: patch.mode ?? existing.mode,
        deskId: patch.deskId === undefined ? existing.deskId : patch.deskId,
      };
      this.vault.upsertAgent(updated);
      this.enqueue('agent', 'modify', id, { agent: updated as unknown as Record<string, unknown> });
      return updated;
    }
    return this.withRemoteControl(async () => {
      const updated = await this.controlStore().updateAgent(id, patch);
      if (this.hybrid && updated) await this.mirrorAgent(id);
      return updated;
    });
  }

  async listApiKeys(): Promise<ApiKeyPublic[]> {
    if (this.useVaultReads()) return this.vault.listApiKeys().map(toPublicKey);
    return this.withRemoteControl(() => this.controlStore().listApiKeys());
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    if (this.useVaultReads()) return this.vault.getApiKey(id);
    return this.withRemoteControl(() => this.controlStore().getApiKeyById(id));
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    if (this.useVaultReads()) return this.vault.findApiKeyByHash(keyHash);
    return this.withRemoteControl(() => this.controlStore().findApiKeyByHash(keyHash));
  }

  async createApiKey(
    input: CreateApiKeyInput
  ): Promise<{ record: ApiKeyPublic; plaintext: string }> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      const plaintext = input.plaintext?.trim() || generateClientApiKey(input.keyEnv);
      const now = Date.now();
      const record: ApiKeyRecord = {
        id: randomUUID(),
        name: input.name.trim() || 'API key',
        keyEnv: input.keyEnv,
        keyPrefix: keyPrefixForEnv(input.keyEnv),
        keyHash: hashApiKey(plaintext),
        keyHint: apiKeyHint(plaintext),
        budgetUsd: input.budgetUsd ?? null,
        spentUsd: 0,
        expiresAt: input.expiresAt ?? null,
        enabled: true,
        createdAt: now,
        lastUsedAt: null,
      };
      this.vault.upsertApiKey(record);
      this.enqueue('api_key', 'add', record.id, {
        record: JSON.parse(JSON.stringify(record)),
        plaintext,
      });
      return { record: toPublicKey(record), plaintext };
    }
    return this.withRemoteControl(async () => {
      const created = await this.controlStore().createApiKey(input);
      if (this.hybrid) await this.mirrorApiKey(created.record.id);
      return created;
    });
  }

  async updateApiKey(id: string, patch: ApiKeyPatch): Promise<ApiKeyPublic | null> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      const existing = this.vault.getApiKey(id);
      if (!existing) return null;
      const updated: ApiKeyRecord = {
        ...existing,
        name: patch.name ?? existing.name,
        budgetUsd: patch.budgetUsd === undefined ? existing.budgetUsd : patch.budgetUsd,
        expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
        enabled: patch.enabled ?? existing.enabled,
      };
      this.vault.upsertApiKey(updated);
      this.enqueue('api_key', 'modify', id, { record: updated as unknown as Record<string, unknown> });
      return toPublicKey(updated);
    }
    return this.withRemoteControl(async () => {
      const updated = await this.controlStore().updateApiKey(id, patch);
      if (this.hybrid) await this.mirrorApiKey(id);
      return updated;
    });
  }

  async deleteApiKey(id: string): Promise<boolean> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      const ok = this.vault.deleteApiKey(id);
      if (ok) this.enqueue('api_key', 'delete', id, { id });
      return ok;
    }
    return this.withRemoteControl(async () => {
      const ok = await this.controlStore().deleteApiKey(id);
      if (this.hybrid && ok) this.vault.deleteApiKey(id);
      return ok;
    });
  }

  async addApiKeySpend(id: string, costUsd: number): Promise<ApiKeyRecord | null> {
    if (this.isDegraded()) {
      const existing = this.vault.getApiKey(id);
      if (!existing) return null;
      const updated = { ...existing, spentUsd: existing.spentUsd + costUsd };
      this.vault.upsertApiKey(updated);
      this.enqueue('api_key', 'modify', id, { record: updated as unknown as Record<string, unknown> });
      return updated;
    }
    return this.withRemoteControl(async () => {
      const row = await this.controlStore().addApiKeySpend(id, costUsd);
      if (this.hybrid && row) this.vault.upsertApiKey(row);
      return row;
    });
  }

  async touchApiKey(id: string): Promise<void> {
    if (this.isDegraded()) {
      const existing = this.vault.getApiKey(id);
      if (!existing) return;
      const updated = { ...existing, lastUsedAt: Date.now() };
      this.vault.upsertApiKey(updated);
      return;
    }
    await this.withRemoteControl(async () => {
      await this.controlStore().touchApiKey(id);
      if (this.hybrid) await this.mirrorApiKey(id);
    });
  }

  async recordUsage(
    event: Omit<UsageEvent, 'id' | 'createdAt'> & { id?: string }
  ): Promise<UsageEvent> {
    return this.workspace.recordUsage(event);
  }

  async listUsage(opts?: { apiKeyId?: string; limit?: number }): Promise<UsageEvent[]> {
    return this.workspace.listUsage(opts);
  }

  async recordToolRun(input: ToolRunCreate): Promise<ToolRunRecord> {
    return this.workspace.recordToolRun(input);
  }

  async listToolRuns(opts?: ToolRunListOptions): Promise<ToolRunRecord[]> {
    return this.workspace.listToolRuns(opts);
  }

  async getPricingOverrides(): Promise<Record<string, ModelPricing>> {
    if (this.useVaultReads()) {
      const raw = this.vault.getSetting('pricing_overrides');
      if (!raw) return {};
      try {
        return JSON.parse(raw) as Record<string, ModelPricing>;
      } catch {
        return {};
      }
    }
    return this.withRemoteControl(() => this.controlStore().getPricingOverrides());
  }

  async setPricingOverrides(map: Record<string, ModelPricing>): Promise<void> {
    this.assertNotReconciling();
    if (this.isDegraded()) {
      this.vault.setSetting('pricing_overrides', JSON.stringify(map));
      this.enqueue('setting', 'modify', 'pricing_overrides', {
        key: 'pricing_overrides',
        value: JSON.stringify(map),
      });
      return;
    }
    await this.withRemoteControl(async () => {
      await this.controlStore().setPricingOverrides(map);
      if (this.hybrid) {
        this.vault.setSetting('pricing_overrides', JSON.stringify(map));
      }
    });
  }

  async listHubModels(opts?: ListHubModelsOpts): Promise<ListHubModelsResult> {
    return this.workspace.listHubModels(opts);
  }

  async getHubModel(id: string): Promise<StoredHubModel | null> {
    return this.workspace.getHubModel(id);
  }

  async createHubModel(input: CreateHubModelInput): Promise<StoredHubModel> {
    return this.workspace.createHubModel(input);
  }

  async updateHubModel(id: string, patch: UpdateHubModelInput): Promise<StoredHubModel> {
    return this.workspace.updateHubModel(id, patch);
  }

  async deleteHubModel(id: string): Promise<boolean> {
    return this.workspace.deleteHubModel(id);
  }

  async setHubModelDefault(catalogId: string): Promise<StoredHubModel> {
    return this.workspace.setHubModelDefault(catalogId);
  }

  async setHubModelBenchmark(catalogId: string): Promise<StoredHubModel> {
    return this.workspace.setHubModelBenchmark(catalogId);
  }

  async importHubModels(input: ImportHubModelsInput): Promise<ImportHubModelsResult> {
    return this.workspace.importHubModels(input);
  }

  // Playground chat is workspace-local (like usage / model catalog) — keeps large
  // history off the browser and off the Supabase control plane.
  async listChatSessions(): Promise<StoredChatSession[]> {
    return this.workspace.listChatSessions();
  }

  async getChatSession(id: string): Promise<StoredChatSessionDetail | null> {
    return this.workspace.getChatSession(id);
  }

  async createChatSession(
    input?: CreateChatSessionInput
  ): Promise<StoredChatSessionDetail> {
    return this.workspace.createChatSession(input);
  }

  async updateChatSession(
    id: string,
    patch: UpdateChatSessionInput
  ): Promise<StoredChatSession | null> {
    return this.workspace.updateChatSession(id, patch);
  }

  async deleteChatSession(id: string): Promise<boolean> {
    return this.workspace.deleteChatSession(id);
  }

  async listChatMessages(
    sessionId: string,
    opts?: ListChatMessagesOpts
  ): Promise<ListChatMessagesResult> {
    return this.workspace.listChatMessages(sessionId, opts);
  }

  async appendChatMessages(
    sessionId: string,
    messages: AppendChatMessageInput[]
  ): Promise<StoredChatMessage[]> {
    return this.workspace.appendChatMessages(sessionId, messages);
  }

  async replaceChatMessages(
    sessionId: string,
    messages: AppendChatMessageInput[]
  ): Promise<StoredChatMessage[]> {
    return this.workspace.replaceChatMessages(sessionId, messages);
  }

  async getActiveChatSessionId(): Promise<string | null> {
    return this.workspace.getActiveChatSessionId();
  }

  async setActiveChatSessionId(id: string | null): Promise<void> {
    return this.workspace.setActiveChatSessionId(id);
  }

  async importChatStore(input: ImportChatStoreInput): Promise<ImportChatStoreResult> {
    return this.workspace.importChatStore(input);
  }

  async close(): Promise<void> {
    if (this.hybrid && this.control !== this.workspace) {
      await this.control.close();
    }
    await this.workspace.close();
  }
}
