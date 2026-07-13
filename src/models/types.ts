import { randomId } from '../lib/auth.js';

export type HubModelSource = 'manual' | 'discovered' | 'seed';

export type HubModelBilling =
  | 'free'
  | 'paid'
  | 'conditional_free'
  | 'temporarily_free'
  | 'unknown';

export type StoredHubModel = {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  source: HubModelSource;
  notes: string | null;
  enabled: boolean;
  isDefault: boolean;
  isBenchmark: boolean;
  billing: HubModelBilling | null;
  inputPricePerMTok: string | null;
  outputPricePerMTok: string | null;
  contextWindow: number | null;
  capabilities: string[] | null;
  createdAt: number;
  updatedAt: number;
};

export type CreateHubModelInput = {
  providerId: string;
  modelId: string;
  displayName?: string;
  notes?: string | null;
  source?: HubModelSource;
  enabled?: boolean;
  isDefault?: boolean;
  isBenchmark?: boolean;
  billing?: HubModelBilling | null;
  inputPricePerMTok?: string | null;
  outputPricePerMTok?: string | null;
  contextWindow?: number | null;
  capabilities?: string[] | null;
};

export type UpdateHubModelInput = Partial<{
  modelId: string;
  displayName: string;
  notes: string | null;
  enabled: boolean;
  isDefault: boolean;
  isBenchmark: boolean;
  billing: HubModelBilling | null;
  inputPricePerMTok: string | null;
  outputPricePerMTok: string | null;
  contextWindow: number | null;
  capabilities: string[] | null;
}>;

export type ImportHubModelItem = {
  modelId: string;
  displayName?: string;
};

export type ImportHubModelsInput = {
  providerId: string;
  models: ImportHubModelItem[];
  defaultModelId?: string;
  benchmarkModelId?: string;
};

export type ImportHubModelsResult = {
  ok: true;
  created: string[];
  updated: string[];
  skipped: Array<{ modelId: string; reason: string }>;
};

export type ListHubModelsOpts = {
  providerId?: string;
  source?: HubModelSource;
  enabled?: boolean;
  q?: string;
  limit?: number;
  cursor?: string | null;
};

export type ListHubModelsResult = {
  models: StoredHubModel[];
  nextCursor: string | null;
};

export type HubModelMutationErrorCode =
  | 'not_found'
  | 'provider_not_found'
  | 'duplicate_model'
  | 'rename_blocked'
  | 'delete_blocked'
  | 'model_role_in_use'
  | 'disabled_role'
  | 'validation_error';

export class HubModelMutationError extends Error {
  code: HubModelMutationErrorCode;
  lockReasons: string[];

  constructor(code: HubModelMutationErrorCode, message: string, lockReasons: string[] = []) {
    super(message);
    this.code = code;
    this.lockReasons = lockReasons;
  }
}

export function newModelCatalogId(): string {
  return randomId('mdl');
}

export const CATALOG_MODELS_MIGRATION_KEY = 'migration:catalog_models_v1';
