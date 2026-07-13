import type Database from 'better-sqlite3';
import type { AgentConfig } from '../types.js';
import {
  CATALOG_MODELS_MIGRATION_KEY,
  HubModelMutationError,
  newModelCatalogId,
  type CreateHubModelInput,
  type HubModelBilling,
  type HubModelSource,
  type ImportHubModelsInput,
  type ImportHubModelsResult,
  type ListHubModelsOpts,
  type ListHubModelsResult,
  type StoredHubModel,
  type UpdateHubModelInput,
} from '../models/types.js';

type ModelRow = {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  source: string;
  notes: string | null;
  enabled: number;
  is_default: number;
  is_benchmark: number;
  billing: string | null;
  input_price_per_mtok: string | null;
  output_price_per_mtok: string | null;
  context_window: number | null;
  capabilities: string | null;
  created_at: number;
  updated_at: number;
};

function parseCaps(raw: string | null): string[] | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

export function mapModelRow(row: ModelRow): StoredHubModel {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    source: row.source as HubModelSource,
    notes: row.notes,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    isBenchmark: Boolean(row.is_benchmark),
    billing: (row.billing as HubModelBilling | null) ?? null,
    inputPricePerMTok: row.input_price_per_mtok,
    outputPricePerMTok: row.output_price_per_mtok,
    contextWindow: row.context_window,
    capabilities: parseCaps(row.capabilities),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureModelsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('manual','discovered','seed')),
      notes TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_benchmark INTEGER NOT NULL DEFAULT 0,
      billing TEXT,
      input_price_per_mtok TEXT,
      output_price_per_mtok TEXT,
      context_window INTEGER,
      capabilities TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider_id, model_id),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_models_provider_default
      ON models(provider_id) WHERE is_default = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_models_provider_benchmark
      ON models(provider_id) WHERE is_benchmark = 1;
  `);
}

function listAgentsSync(db: Database.Database): AgentConfig[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY id ASC').all() as Array<{
    id: string;
    nickname: string;
    enabled: number;
    model: string;
    mode: string;
    desk_id: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id as AgentConfig['id'],
    nickname: r.nickname,
    enabled: Boolean(r.enabled),
    model: r.model,
    mode: r.mode as AgentConfig['mode'],
    deskId: r.desk_id,
  }));
}

function getSettingSync(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setSettingSync(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function getModelByIdSync(db: Database.Database, id: string): StoredHubModel | null {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
  return row ? mapModelRow(row) : null;
}

export function getHubModelSync(db: Database.Database, id: string): StoredHubModel | null {
  return getModelByIdSync(db, id);
}

function getModelByProviderModelSync(
  db: Database.Database,
  providerId: string,
  modelId: string
): StoredHubModel | null {
  const row = db
    .prepare('SELECT * FROM models WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) as ModelRow | undefined;
  return row ? mapModelRow(row) : null;
}

function providerExists(db: Database.Database, providerId: string): boolean {
  const row = db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId) as
    | { id: string }
    | undefined;
  return Boolean(row);
}

function syncProviderPointers(
  db: Database.Database,
  providerId: string,
  defaultModelId: string | null | undefined,
  benchmarkModelId: string | null | undefined
): void {
  if (defaultModelId !== undefined) {
    db.prepare('UPDATE providers SET default_model = ? WHERE id = ?').run(
      defaultModelId,
      providerId
    );
  }
  if (benchmarkModelId !== undefined) {
    db.prepare('UPDATE providers SET benchmark_model = ? WHERE id = ?').run(
      benchmarkModelId,
      providerId
    );
  }
}

function clearDefaultFlag(db: Database.Database, providerId: string): void {
  db.prepare('UPDATE models SET is_default = 0, updated_at = ? WHERE provider_id = ? AND is_default = 1').run(
    Date.now(),
    providerId
  );
}

function clearBenchmarkFlag(db: Database.Database, providerId: string): void {
  db.prepare(
    'UPDATE models SET is_benchmark = 0, updated_at = ? WHERE provider_id = ? AND is_benchmark = 1'
  ).run(Date.now(), providerId);
}

function insertModelRow(
  db: Database.Database,
  model: StoredHubModel
): void {
  db.prepare(
    `INSERT INTO models (
      id, provider_id, model_id, display_name, source, notes, enabled,
      is_default, is_benchmark, billing, input_price_per_mtok, output_price_per_mtok,
      context_window, capabilities, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    model.id,
    model.providerId,
    model.modelId,
    model.displayName,
    model.source,
    model.notes,
    model.enabled ? 1 : 0,
    model.isDefault ? 1 : 0,
    model.isBenchmark ? 1 : 0,
    model.billing,
    model.inputPricePerMTok,
    model.outputPricePerMTok,
    model.contextWindow,
    model.capabilities ? JSON.stringify(model.capabilities) : null,
    model.createdAt,
    model.updatedAt
  );
}

function agentLockReasons(db: Database.Database, modelId: string): string[] {
  const agents = listAgentsSync(db);
  return agents.some((a) => a.model === modelId) ? ['agent_reference'] : [];
}

/** One-time seed from provider default/benchmark/pinnedModels. */
export function migrateCatalogModelsV1(db: Database.Database): void {
  if (getSettingSync(db, CATALOG_MODELS_MIGRATION_KEY) === 'done') return;

  const run = db.transaction(() => {
    const providers = db.prepare('SELECT * FROM providers').all() as Array<{
      id: string;
      default_model: string | null;
      benchmark_model: string | null;
      pinned_models: string | null;
    }>;

    for (const p of providers) {
      let pinned: string[] = [];
      try {
        const parsed = JSON.parse(p.pinned_models ?? '[]');
        pinned = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
      } catch {
        pinned = [];
      }

      const candidates = new Map<string, HubModelSource>();
      for (const id of pinned) candidates.set(id, 'manual');
      if (p.default_model) {
        candidates.set(p.default_model, candidates.has(p.default_model) ? candidates.get(p.default_model)! : 'seed');
      }
      if (p.benchmark_model) {
        const existing = candidates.get(p.benchmark_model);
        candidates.set(p.benchmark_model, existing ?? 'seed');
      }

      const now = Date.now();
      for (const [modelId, source] of candidates) {
        const existing = getModelByProviderModelSync(db, p.id, modelId);
        if (existing) continue;
        insertModelRow(db, {
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

      if (p.default_model) {
        clearDefaultFlag(db, p.id);
        db.prepare(
          'UPDATE models SET is_default = 1, updated_at = ? WHERE provider_id = ? AND model_id = ?'
        ).run(Date.now(), p.id, p.default_model);
      }
      if (p.benchmark_model) {
        clearBenchmarkFlag(db, p.id);
        db.prepare(
          'UPDATE models SET is_benchmark = 1, updated_at = ? WHERE provider_id = ? AND model_id = ?'
        ).run(Date.now(), p.id, p.benchmark_model);
      }
    }

    setSettingSync(db, CATALOG_MODELS_MIGRATION_KEY, 'done');
  });

  run();
}

export function listHubModelsSync(
  db: Database.Database,
  opts: ListHubModelsOpts = {}
): ListHubModelsResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.providerId) {
    clauses.push('provider_id = ?');
    params.push(opts.providerId);
  }
  if (opts.source) {
    clauses.push('source = ?');
    params.push(opts.source);
  }
  if (opts.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(opts.enabled ? 1 : 0);
  }
  if (opts.q) {
    const q = `%${opts.q.toLowerCase()}%`;
    clauses.push('(lower(model_id) LIKE ? OR lower(display_name) LIKE ? OR lower(ifnull(notes,\"\")) LIKE ?)');
    params.push(q, q, q);
  }
  if (opts.cursor) {
    clauses.push('id > ?');
    params.push(opts.cursor);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM models ${where} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit + 1) as ModelRow[];

  const page = rows.slice(0, limit).map(mapModelRow);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.id : null;
  return { models: page, nextCursor };
}

export function createHubModelSync(
  db: Database.Database,
  input: CreateHubModelInput
): StoredHubModel {
  const modelId = input.modelId.trim();
  if (!modelId) {
    throw new HubModelMutationError('validation_error', 'modelId is required');
  }
  if (!providerExists(db, input.providerId)) {
    throw new HubModelMutationError('provider_not_found', 'Provider not found');
  }
  if (getModelByProviderModelSync(db, input.providerId, modelId)) {
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

  const run = db.transaction(() => {
    insertModelRow(db, model);
    if (wantDefault) {
      clearDefaultFlag(db, model.providerId);
      db.prepare('UPDATE models SET is_default = 1, updated_at = ? WHERE id = ?').run(Date.now(), model.id);
      syncProviderPointers(db, model.providerId, model.modelId, undefined);
      model.isDefault = true;
    }
    if (wantBenchmark) {
      clearBenchmarkFlag(db, model.providerId);
      db.prepare('UPDATE models SET is_benchmark = 1, updated_at = ? WHERE id = ?').run(Date.now(), model.id);
      syncProviderPointers(db, model.providerId, undefined, model.modelId);
      model.isBenchmark = true;
    }
  });
  run();
  return getModelByIdSync(db, model.id)!;
}

export function updateHubModelSync(
  db: Database.Database,
  id: string,
  patch: UpdateHubModelInput
): StoredHubModel {
  const existing = getModelByIdSync(db, id);
  if (!existing) {
    throw new HubModelMutationError('not_found', 'Model not found');
  }

  const run = db.transaction(() => {
    let modelId = existing.modelId;
    let displayName = existing.displayName;
    let notes = existing.notes;
    let enabled = existing.enabled;
    let billing = existing.billing;
    let inputPricePerMTok = existing.inputPricePerMTok;
    let outputPricePerMTok = existing.outputPricePerMTok;
    let contextWindow = existing.contextWindow;
    let capabilities = existing.capabilities;
    let isDefault = existing.isDefault;
    let isBenchmark = existing.isBenchmark;

    if (patch.modelId !== undefined && patch.modelId.trim() !== existing.modelId) {
      const locks = [
        ...(existing.isDefault ? ['default_model'] : []),
        ...(existing.isBenchmark ? ['benchmark_model'] : []),
        ...agentLockReasons(db, existing.modelId),
      ];
      if (locks.length) {
        throw new HubModelMutationError(
          'rename_blocked',
          'Cannot rename modelId while default, benchmark, or referenced by an agent',
          locks
        );
      }
      const nextId = patch.modelId.trim();
      if (!nextId) {
        throw new HubModelMutationError('validation_error', 'modelId is required');
      }
      if (getModelByProviderModelSync(db, existing.providerId, nextId)) {
        throw new HubModelMutationError('duplicate_model', 'Model already exists for provider');
      }
      modelId = nextId;
    }

    if (patch.displayName !== undefined) displayName = patch.displayName.trim() || modelId;
    if (patch.notes !== undefined) notes = patch.notes;
    if (patch.billing !== undefined) billing = patch.billing;
    if (patch.inputPricePerMTok !== undefined) inputPricePerMTok = patch.inputPricePerMTok;
    if (patch.outputPricePerMTok !== undefined) outputPricePerMTok = patch.outputPricePerMTok;
    if (patch.contextWindow !== undefined) contextWindow = patch.contextWindow;
    if (patch.capabilities !== undefined) capabilities = patch.capabilities;

    if (patch.enabled !== undefined) {
      if (patch.enabled === false && (isDefault || isBenchmark)) {
        throw new HubModelMutationError(
          'model_role_in_use',
          'Disable blocked while model is default or benchmark — clear role first',
          [
            ...(isDefault ? ['default_model'] : []),
            ...(isBenchmark ? ['benchmark_model'] : []),
          ]
        );
      }
      enabled = patch.enabled;
    }

    if (patch.isDefault === true) {
      if (!enabled) {
        throw new HubModelMutationError(
          'disabled_role',
          'Cannot set default on a disabled model'
        );
      }
      clearDefaultFlag(db, existing.providerId);
      isDefault = true;
      syncProviderPointers(db, existing.providerId, modelId, undefined);
    } else if (patch.isDefault === false && existing.isDefault) {
      isDefault = false;
      syncProviderPointers(db, existing.providerId, null, undefined);
    }

    if (patch.isBenchmark === true) {
      if (!enabled) {
        throw new HubModelMutationError(
          'disabled_role',
          'Cannot set benchmark on a disabled model'
        );
      }
      clearBenchmarkFlag(db, existing.providerId);
      isBenchmark = true;
      syncProviderPointers(db, existing.providerId, undefined, modelId);
    } else if (patch.isBenchmark === false && existing.isBenchmark) {
      isBenchmark = false;
      syncProviderPointers(db, existing.providerId, undefined, null);
    }

    const now = Date.now();
    db.prepare(
      `UPDATE models SET
        model_id = ?, display_name = ?, notes = ?, enabled = ?,
        is_default = ?, is_benchmark = ?, billing = ?,
        input_price_per_mtok = ?, output_price_per_mtok = ?,
        context_window = ?, capabilities = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      modelId,
      displayName,
      notes,
      enabled ? 1 : 0,
      isDefault ? 1 : 0,
      isBenchmark ? 1 : 0,
      billing,
      inputPricePerMTok,
      outputPricePerMTok,
      contextWindow,
      capabilities ? JSON.stringify(capabilities) : null,
      now,
      id
    );
  });

  run();
  return getModelByIdSync(db, id)!;
}

export function deleteHubModelSync(db: Database.Database, id: string): boolean {
  const existing = getModelByIdSync(db, id);
  if (!existing) return false;

  const agentLocks = agentLockReasons(db, existing.modelId);
  if (agentLocks.length) {
    throw new HubModelMutationError(
      'delete_blocked',
      'Cannot delete model while an agent references this modelId (conservative guard)',
      agentLocks
    );
  }

  const run = db.transaction(() => {
    if (existing.isDefault) {
      syncProviderPointers(db, existing.providerId, null, undefined);
    }
    if (existing.isBenchmark) {
      syncProviderPointers(db, existing.providerId, undefined, null);
    }
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
  });
  run();
  return true;
}

export function setHubModelDefaultSync(db: Database.Database, catalogId: string): StoredHubModel {
  return updateHubModelSync(db, catalogId, { isDefault: true });
}

export function setHubModelBenchmarkSync(db: Database.Database, catalogId: string): StoredHubModel {
  return updateHubModelSync(db, catalogId, { isBenchmark: true });
}

export function importHubModelsSync(
  db: Database.Database,
  input: ImportHubModelsInput
): ImportHubModelsResult {
  if (!providerExists(db, input.providerId)) {
    throw new HubModelMutationError('provider_not_found', 'Provider not found');
  }

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: Array<{ modelId: string; reason: string }> = [];

  const run = db.transaction(() => {
    for (const item of input.models) {
      const modelId = item.modelId.trim();
      if (!modelId) {
        skipped.push({ modelId: item.modelId, reason: 'invalid_model_id' });
        continue;
      }
      const existing = getModelByProviderModelSync(db, input.providerId, modelId);
      if (existing) {
        skipped.push({ modelId, reason: 'already_exists' });
        continue;
      }
      const now = Date.now();
      const id = newModelCatalogId();
      insertModelRow(db, {
        id,
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
      });
      created.push(id);
    }

    if (input.defaultModelId) {
      const row = getModelByProviderModelSync(db, input.providerId, input.defaultModelId.trim());
      if (!row) {
        skipped.push({ modelId: input.defaultModelId, reason: 'default_not_found' });
      } else if (!row.enabled) {
        skipped.push({ modelId: input.defaultModelId, reason: 'default_disabled' });
      } else {
        clearDefaultFlag(db, input.providerId);
        db.prepare('UPDATE models SET is_default = 1, updated_at = ? WHERE id = ?').run(
          Date.now(),
          row.id
        );
        syncProviderPointers(db, input.providerId, row.modelId, undefined);
        if (!created.includes(row.id) && !updated.includes(row.id)) updated.push(row.id);
      }
    }

    if (input.benchmarkModelId) {
      const row = getModelByProviderModelSync(db, input.providerId, input.benchmarkModelId.trim());
      if (!row) {
        skipped.push({ modelId: input.benchmarkModelId, reason: 'benchmark_not_found' });
      } else if (!row.enabled) {
        skipped.push({ modelId: input.benchmarkModelId, reason: 'benchmark_disabled' });
      } else {
        clearBenchmarkFlag(db, input.providerId);
        db.prepare('UPDATE models SET is_benchmark = 1, updated_at = ? WHERE id = ?').run(
          Date.now(),
          row.id
        );
        syncProviderPointers(db, input.providerId, undefined, row.modelId);
        if (!created.includes(row.id) && !updated.includes(row.id)) updated.push(row.id);
      }
    }
  });

  run();
  return { ok: true, created, updated, skipped };
}
