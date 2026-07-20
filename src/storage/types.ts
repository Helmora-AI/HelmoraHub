import type { AgentConfig, HubMode, ProviderToggle } from '../types.js';
import type {
  ApiKeyPublic,
  ApiKeyRecord,
  CreateApiKeyInput,
  UsageEvent,
  UsageEventCreate,
} from '../keys/types.js';
import type { ModelPricing } from '../keys/types.js';
import type {
  CreateHubModelInput,
  ImportHubModelsInput,
  ImportHubModelsResult,
  ListHubModelsOpts,
  ListHubModelsResult,
  StoredHubModel,
  UpdateHubModelInput,
} from '../models/types.js';
import type { ChatStoreMethods } from './chat-types.js';
import type {
  RegisteredConnectorId,
  RegisteredToolId,
  ToolRisk,
  ToolSurface,
} from '../tools/types.js';

export type ToolRunSource = 'runtime' | 'admin_connector_test';
export type ToolRunStatus = 'running' | 'completed' | 'failed' | 'rejected';

export type ToolRunRecord = {
  id: string;
  requestId: string;
  toolId: RegisteredToolId;
  connector: RegisteredConnectorId;
  surface: ToolSurface;
  source: ToolRunSource;
  answerCatalogId: string | null;
  plannerCatalogId: string | null;
  risk: ToolRisk;
  status: ToolRunStatus;
  durationMs: number | null;
  sourceCount: number | null;
  errorCode: string | null;
  createdAt: number;
};

export type ToolRunCreate = Omit<ToolRunRecord, 'id' | 'createdAt'> & { id?: string };
export type ToolRunPatch = Pick<
  ToolRunRecord,
  'status' | 'durationMs' | 'sourceCount' | 'errorCode'
>;
export type ToolRunListOptions = {
  limit?: number;
  before?: { createdAt: number; id: string };
};

export type ConnectorCredentialRecord = {
  connectorId: RegisteredConnectorId;
  encryptedSecret: string;
  encryptionVersion: 1;
  configuredAt: number;
  updatedAt: number;
};

export type ConnectorCredentialState = {
  connectorId: RegisteredConnectorId;
  credentialConfigured: boolean;
  credentialHint: string | null;
  configuredAt: number | null;
  updatedAt: number | null;
};

export type ConnectorCredentialUpdate = {
  /** undefined retains the current credential; null explicitly clears it. */
  secret?: string | null;
};

export type ProviderPatch = Partial<{
  enabled: boolean;
  label: string;
  tier: 1 | 2 | 3;
  baseUrl: string | null;
  apiKey: string | null;
  defaultModel: string | null;
  benchmarkModel: string | null;
  pinnedModels: string[];
  allowedModes: HubMode[];
  capabilities: string[];
  verifyStatus: import('../types.js').ProviderVerifyStatus;
  verifyError: string | null;
  verifiedAt: number | null;
  authMode: import('../types.js').ProviderAuthMode;
  oauthState: import('../types.js').ProviderOAuthState;
}>;

export type AgentPatch = Partial<{
  nickname: string;
  enabled: boolean;
  model: string;
  mode: HubMode;
  deskId: string | null;
}>;

export type ApiKeyPatch = Partial<{
  name: string;
  budgetUsd: number | null;
  expiresAt: number | null;
  enabled: boolean;
}>;

/** Persistent config / credentials store (SQLite local or Supabase cloud). */
export interface ConfigStore extends ChatStoreMethods {
  readonly backend: 'sqlite' | 'supabase';
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  getActiveMode(): Promise<HubMode>;
  setActiveMode(mode: HubMode): Promise<void>;
  /** @deprecated Prefer listApiKeys — returns first enabled key preview helper */
  getUnifiedApiKey(): Promise<string>;
  listProviders(): Promise<ProviderToggle[]>;
  getProvider(id: string): Promise<ProviderToggle | null>;
  updateProvider(id: string, patch: ProviderPatch): Promise<ProviderToggle | null>;
  listAgents(): Promise<AgentConfig[]>;
  getAgent(id: string): Promise<AgentConfig | null>;
  updateAgent(id: string, patch: AgentPatch): Promise<AgentConfig | null>;

  getConnectorCredentialRecord(
    connectorId: RegisteredConnectorId
  ): Promise<ConnectorCredentialRecord | null>;
  putConnectorCredentialRecord(record: ConnectorCredentialRecord): Promise<void>;
  getConnectorCredentialSecret(connectorId: RegisteredConnectorId): Promise<string | null>;
  getConnectorCredentialState(
    connectorId: RegisteredConnectorId
  ): Promise<ConnectorCredentialState>;
  updateConnectorCredential(
    connectorId: RegisteredConnectorId,
    update: ConnectorCredentialUpdate
  ): Promise<ConnectorCredentialState>;

  listApiKeys(): Promise<ApiKeyPublic[]>;
  getApiKeyById(id: string): Promise<ApiKeyRecord | null>;
  findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  createApiKey(input: CreateApiKeyInput): Promise<{ record: ApiKeyPublic; plaintext: string }>;
  updateApiKey(id: string, patch: ApiKeyPatch): Promise<ApiKeyPublic | null>;
  deleteApiKey(id: string): Promise<boolean>;
  addApiKeySpend(id: string, costUsd: number): Promise<ApiKeyRecord | null>;
  touchApiKey(id: string): Promise<void>;

  recordUsage(event: UsageEventCreate): Promise<UsageEvent>;
  listUsage(opts?: { apiKeyId?: string; limit?: number }): Promise<UsageEvent[]>;
  recordToolRun(input: ToolRunCreate): Promise<ToolRunRecord>;
  updateToolRun(id: string, patch: ToolRunPatch): Promise<ToolRunRecord | null>;
  listToolRuns(opts?: ToolRunListOptions): Promise<ToolRunRecord[]>;

  getPricingOverrides(): Promise<Record<string, ModelPricing>>;
  setPricingOverrides(map: Record<string, ModelPricing>): Promise<void>;

  listHubModels(opts?: ListHubModelsOpts): Promise<ListHubModelsResult>;
  getHubModel(id: string): Promise<StoredHubModel | null>;
  createHubModel(input: CreateHubModelInput): Promise<StoredHubModel>;
  updateHubModel(id: string, patch: UpdateHubModelInput): Promise<StoredHubModel>;
  deleteHubModel(id: string): Promise<boolean>;
  setHubModelDefault(catalogId: string): Promise<StoredHubModel>;
  setHubModelBenchmark(catalogId: string): Promise<StoredHubModel>;
  importHubModels(input: ImportHubModelsInput): Promise<ImportHubModelsResult>;

  close(): Promise<void>;
}

/** Ephemeral rate / cooldown / sticky session store (memory or Redis). */
export interface RateStore {
  readonly backend: 'memory' | 'redis';
  isCoolingDown(providerId: string): Promise<boolean>;
  setCooldown(providerId: string, ttlSeconds: number): Promise<void>;
  incrRpm(providerId: string, windowSeconds?: number): Promise<number>;
  getSticky(sessionKey: string): Promise<string | null>;
  setSticky(sessionKey: string, providerId: string, ttlSeconds?: number): Promise<void>;
  close(): Promise<void>;
}

export interface StorageBundle {
  config: ConfigStore;
  rate: RateStore;
}
