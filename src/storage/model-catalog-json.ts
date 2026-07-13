/**
 * In-process catalog ops over a mutable array (Supabase settings JSON fallback).
 * Same guards/invariants as SQLite; caller persists the array after each mutating op.
 */
import type { AgentConfig, ProviderToggle } from '../types.js';
import {
  HubModelMutationError,
  newModelCatalogId,
  type CreateHubModelInput,
  type ImportHubModelsInput,
  type ImportHubModelsResult,
  type ListHubModelsOpts,
  type ListHubModelsResult,
  type StoredHubModel,
  type UpdateHubModelInput,
} from '../models/types.js';

export type JsonCatalogCtx = {
  models: StoredHubModel[];
  providers: ProviderToggle[];
  agents: AgentConfig[];
  /** Mutate provider pointers in memory; caller persists. */
  patchProvider: (
    providerId: string,
    patch: { defaultModel?: string | null; benchmarkModel?: string | null }
  ) => void;
};

function byProviderModel(
  models: StoredHubModel[],
  providerId: string,
  modelId: string
): StoredHubModel | undefined {
  return models.find((m) => m.providerId === providerId && m.modelId === modelId);
}

function agentLocks(agents: AgentConfig[], modelId: string): string[] {
  return agents.some((a) => a.model === modelId) ? ['agent_reference'] : [];
}

export function listHubModelsJson(
  models: StoredHubModel[],
  opts: ListHubModelsOpts = {}
): ListHubModelsResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  let rows = [...models].sort((a, b) => a.id.localeCompare(b.id));
  if (opts.providerId) rows = rows.filter((m) => m.providerId === opts.providerId);
  if (opts.source) rows = rows.filter((m) => m.source === opts.source);
  if (opts.enabled !== undefined) rows = rows.filter((m) => m.enabled === opts.enabled);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        (m.notes ?? '').toLowerCase().includes(q)
    );
  }
  if (opts.cursor) rows = rows.filter((m) => m.id > opts.cursor!);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.id : null;
  return { models: page, nextCursor };
}

export function createHubModelJson(ctx: JsonCatalogCtx, input: CreateHubModelInput): StoredHubModel {
  const modelId = input.modelId.trim();
  if (!modelId) throw new HubModelMutationError('validation_error', 'modelId is required');
  if (!ctx.providers.some((p) => p.id === input.providerId)) {
    throw new HubModelMutationError('provider_not_found', 'Provider not found');
  }
  if (byProviderModel(ctx.models, input.providerId, modelId)) {
    throw new HubModelMutationError('duplicate_model', 'Model already exists for provider');
  }
  const wantDefault = Boolean(input.isDefault);
  const wantBenchmark = Boolean(input.isBenchmark);
  const enabled = input.enabled !== false;
  if ((wantDefault || wantBenchmark) && !enabled) {
    throw new HubModelMutationError(
      'disabled_role',
      'Cannot set default/benchmark on a disabled model'
    );
  }
  const now = Date.now();
  const model: StoredHubModel = {
    id: newModelCatalogId(),
    providerId: input.providerId,
    modelId,
    displayName: (input.displayName ?? modelId).trim() || modelId,
    source: input.source ?? 'manual',
    notes: input.notes ?? null,
    enabled,
    isDefault: false,
    isBenchmark: false,
    billing: input.billing ?? null,
    inputPricePerMTok: input.inputPricePerMTok ?? null,
    outputPricePerMTok: input.outputPricePerMTok ?? null,
    contextWindow: input.contextWindow ?? null,
    capabilities: input.capabilities ?? null,
    createdAt: now,
    updatedAt: now,
  };
  ctx.models.push(model);
  if (wantDefault) {
    for (const m of ctx.models) {
      if (m.providerId === model.providerId) m.isDefault = false;
    }
    model.isDefault = true;
    ctx.patchProvider(model.providerId, { defaultModel: model.modelId });
  }
  if (wantBenchmark) {
    for (const m of ctx.models) {
      if (m.providerId === model.providerId) m.isBenchmark = false;
    }
    model.isBenchmark = true;
    ctx.patchProvider(model.providerId, { benchmarkModel: model.modelId });
  }
  return { ...model };
}

export function updateHubModelJson(
  ctx: JsonCatalogCtx,
  id: string,
  patch: UpdateHubModelInput
): StoredHubModel {
  const existing = ctx.models.find((m) => m.id === id);
  if (!existing) throw new HubModelMutationError('not_found', 'Model not found');

  if (patch.modelId !== undefined && patch.modelId.trim() !== existing.modelId) {
    const locks = [
      ...(existing.isDefault ? ['default_model'] : []),
      ...(existing.isBenchmark ? ['benchmark_model'] : []),
      ...agentLocks(ctx.agents, existing.modelId),
    ];
    if (locks.length) {
      throw new HubModelMutationError(
        'rename_blocked',
        'Cannot rename modelId while default, benchmark, or referenced by an agent',
        locks
      );
    }
    const nextId = patch.modelId.trim();
    if (!nextId) throw new HubModelMutationError('validation_error', 'modelId is required');
    if (byProviderModel(ctx.models, existing.providerId, nextId)) {
      throw new HubModelMutationError('duplicate_model', 'Model already exists for provider');
    }
    existing.modelId = nextId;
  }

  if (patch.displayName !== undefined) {
    existing.displayName = patch.displayName.trim() || existing.modelId;
  }
  if (patch.notes !== undefined) existing.notes = patch.notes;
  if (patch.billing !== undefined) existing.billing = patch.billing;
  if (patch.inputPricePerMTok !== undefined) existing.inputPricePerMTok = patch.inputPricePerMTok;
  if (patch.outputPricePerMTok !== undefined) existing.outputPricePerMTok = patch.outputPricePerMTok;
  if (patch.contextWindow !== undefined) existing.contextWindow = patch.contextWindow;
  if (patch.capabilities !== undefined) existing.capabilities = patch.capabilities;

  if (patch.enabled !== undefined) {
    if (patch.enabled === false && (existing.isDefault || existing.isBenchmark)) {
      throw new HubModelMutationError(
        'model_role_in_use',
        'Disable blocked while model is default or benchmark — clear role first',
        [
          ...(existing.isDefault ? ['default_model'] : []),
          ...(existing.isBenchmark ? ['benchmark_model'] : []),
        ]
      );
    }
    existing.enabled = patch.enabled;
  }

  if (patch.isDefault === true) {
    if (!existing.enabled) {
      throw new HubModelMutationError('disabled_role', 'Cannot set default on a disabled model');
    }
    for (const m of ctx.models) {
      if (m.providerId === existing.providerId) m.isDefault = false;
    }
    existing.isDefault = true;
    ctx.patchProvider(existing.providerId, { defaultModel: existing.modelId });
  } else if (patch.isDefault === false && existing.isDefault) {
    existing.isDefault = false;
    ctx.patchProvider(existing.providerId, { defaultModel: null });
  }

  if (patch.isBenchmark === true) {
    if (!existing.enabled) {
      throw new HubModelMutationError('disabled_role', 'Cannot set benchmark on a disabled model');
    }
    for (const m of ctx.models) {
      if (m.providerId === existing.providerId) m.isBenchmark = false;
    }
    existing.isBenchmark = true;
    ctx.patchProvider(existing.providerId, { benchmarkModel: existing.modelId });
  } else if (patch.isBenchmark === false && existing.isBenchmark) {
    existing.isBenchmark = false;
    ctx.patchProvider(existing.providerId, { benchmarkModel: null });
  }

  existing.updatedAt = Date.now();
  return { ...existing };
}

export function deleteHubModelJson(ctx: JsonCatalogCtx, id: string): boolean {
  const idx = ctx.models.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  const existing = ctx.models[idx]!;
  const locks = agentLocks(ctx.agents, existing.modelId);
  if (locks.length) {
    throw new HubModelMutationError(
      'delete_blocked',
      'Cannot delete model while an agent references this modelId (conservative guard)',
      locks
    );
  }
  if (existing.isDefault) ctx.patchProvider(existing.providerId, { defaultModel: null });
  if (existing.isBenchmark) ctx.patchProvider(existing.providerId, { benchmarkModel: null });
  ctx.models.splice(idx, 1);
  return true;
}

export function importHubModelsJson(
  ctx: JsonCatalogCtx,
  input: ImportHubModelsInput
): ImportHubModelsResult {
  if (!ctx.providers.some((p) => p.id === input.providerId)) {
    throw new HubModelMutationError('provider_not_found', 'Provider not found');
  }
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: Array<{ modelId: string; reason: string }> = [];

  for (const item of input.models) {
    const modelId = item.modelId.trim();
    if (!modelId) {
      skipped.push({ modelId: item.modelId, reason: 'invalid_model_id' });
      continue;
    }
    if (byProviderModel(ctx.models, input.providerId, modelId)) {
      skipped.push({ modelId, reason: 'already_exists' });
      continue;
    }
    const now = Date.now();
    const row: StoredHubModel = {
      id: newModelCatalogId(),
      providerId: input.providerId,
      modelId,
      displayName: (item.displayName ?? modelId).trim() || modelId,
      source: 'discovered',
      notes: null,
      enabled: true,
      isDefault: false,
      isBenchmark: false,
      billing: null,
      inputPricePerMTok: null,
      outputPricePerMTok: null,
      contextWindow: null,
      capabilities: null,
      createdAt: now,
      updatedAt: now,
    };
    ctx.models.push(row);
    created.push(row.id);
  }

  if (input.defaultModelId) {
    const row = byProviderModel(ctx.models, input.providerId, input.defaultModelId.trim());
    if (!row) skipped.push({ modelId: input.defaultModelId, reason: 'default_not_found' });
    else if (!row.enabled) skipped.push({ modelId: input.defaultModelId, reason: 'default_disabled' });
    else {
      for (const m of ctx.models) {
        if (m.providerId === input.providerId) m.isDefault = false;
      }
      row.isDefault = true;
      row.updatedAt = Date.now();
      ctx.patchProvider(input.providerId, { defaultModel: row.modelId });
      if (!created.includes(row.id) && !updated.includes(row.id)) updated.push(row.id);
    }
  }

  if (input.benchmarkModelId) {
    const row = byProviderModel(ctx.models, input.providerId, input.benchmarkModelId.trim());
    if (!row) skipped.push({ modelId: input.benchmarkModelId, reason: 'benchmark_not_found' });
    else if (!row.enabled)
      skipped.push({ modelId: input.benchmarkModelId, reason: 'benchmark_disabled' });
    else {
      for (const m of ctx.models) {
        if (m.providerId === input.providerId) m.isBenchmark = false;
      }
      row.isBenchmark = true;
      row.updatedAt = Date.now();
      ctx.patchProvider(input.providerId, { benchmarkModel: row.modelId });
      if (!created.includes(row.id) && !updated.includes(row.id)) updated.push(row.id);
    }
  }

  return { ok: true, created, updated, skipped };
}

export function migrateCatalogModelsV1Json(
  providers: ProviderToggle[],
  existing: StoredHubModel[]
): StoredHubModel[] {
  const models = [...existing];
  for (const p of providers) {
    const candidates = new Map<string, StoredHubModel['source']>();
    for (const id of p.pinnedModels ?? []) candidates.set(id, 'manual');
    if (p.defaultModel) candidates.set(p.defaultModel, candidates.get(p.defaultModel) ?? 'seed');
    if (p.benchmarkModel)
      candidates.set(p.benchmarkModel, candidates.get(p.benchmarkModel) ?? 'seed');
    const now = Date.now();
    for (const [modelId, source] of candidates) {
      if (byProviderModel(models, p.id, modelId)) continue;
      models.push({
        id: newModelCatalogId(),
        providerId: p.id,
        modelId,
        displayName: modelId,
        source,
        notes: null,
        enabled: true,
        isDefault: false,
        isBenchmark: false,
        billing: null,
        inputPricePerMTok: null,
        outputPricePerMTok: null,
        contextWindow: null,
        capabilities: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const m of models) {
      if (m.providerId !== p.id) continue;
      m.isDefault = p.defaultModel != null && m.modelId === p.defaultModel;
      m.isBenchmark = p.benchmarkModel != null && m.modelId === p.benchmarkModel;
    }
  }
  return models;
}
