import { Router } from 'express';
import { z } from 'zod';
import {
  getActiveMode,
  getUnifiedApiKey,
  listAgents,
  listProviders,
  getProvider,
  setActiveMode,
  updateAgent,
  updateProvider,
} from '../db/index.js';
import { getControlHealth, getStorage } from '../storage/index.js';
import { getActiveConfig } from '../lib/config.js';
import { HUB_VERSION } from '../lib/version.js';
import { HUB_MODES, MODE_PROFILES } from '../types.js';
import type { HubMode } from '../types.js';
import { buildFallbackChain } from '../services/mode-router.js';
import {
  getMiniRoleConfigProjection,
  getMiniCatalogReferences,
  MINI_ROLE_METADATA,
  normalizeMiniRoleConfig,
  resolveMiniRoleAdminState,
  setMiniRoleConfig,
  validateMiniRoleConfigReferences,
  type MiniMigrationWarning,
  type MiniRoleConfig,
} from '../services/mini-route.js';
import { maskSecret } from '../lib/crypto.js';
import {
  classifyVerifyError,
  toPublicProvider,
} from '../providers/public-shape.js';
import { allowedModesForProviderTier } from '../providers/catalog/index.js';
import { buildStatusAggregates } from '../lib/aggregates.js';
import { discoverProviderModels } from '../providers/discover-models.js';
import {
  agentCatalogRow,
  metaCatalogRow,
  toCatalogModelResponse,
} from '../models/public.js';
import { HubModelMutationError } from '../models/types.js';

export const adminRouter = Router();

const miniRoleAssignmentSchema = z.object({
  primaryCatalogId: z.string().trim().min(1).nullable(),
  fallbackCatalogId: z.string().trim().min(1).nullable(),
}).strict();

const miniRoleConfigSchema = z.object({
  version: z.literal(2),
  enabled: z.boolean(),
  roles: z.object({
    general: miniRoleAssignmentSchema,
    reasoning: miniRoleAssignmentSchema,
    coding: miniRoleAssignmentSchema,
    research: miniRoleAssignmentSchema,
    creative: miniRoleAssignmentSchema,
    review: miniRoleAssignmentSchema,
  }).strict(),
}).strict();

async function miniRouteAdminResponse(
  config: MiniRoleConfig,
  migrationWarnings: MiniMigrationWarning[] = []
) {
  const [providers, catalog] = await Promise.all([
    listProviders(),
    getStorage().config.listHubModels({ limit: 500 }),
  ]);
  return {
    modelId: 'helmora-mini-1.0',
    displayName: 'Helmora Mini 1.0',
    config,
    resolved: {
      roles: resolveMiniRoleAdminState(config, catalog.models, providers),
    },
    classifier: {
      roles: MINI_ROLE_METADATA,
    },
    migrationWarnings,
  };
}

function mutationStatus(err: HubModelMutationError): number {
  switch (err.code) {
    case 'not_found':
    case 'provider_not_found':
      return 404;
    case 'duplicate_model':
    case 'rename_blocked':
    case 'delete_blocked':
    case 'model_role_in_use':
    case 'disabled_role':
      return 409;
    default:
      return 400;
  }
}

function sendMutationError(
  res: import('express').Response,
  err: unknown,
  next: import('express').NextFunction
) {
  if (err instanceof HubModelMutationError) {
    res.status(mutationStatus(err)).json({
      error: {
        message: err.message,
        type: err.code,
        code: err.code,
        lockReasons: err.lockReasons,
      },
    });
    return;
  }
  next(err);
}

adminRouter.get('/status', async (_req, res, next) => {
  try {
    const mode = await getActiveMode();
    const storage = getStorage();
    const config = getActiveConfig();
    const providers = await listProviders();
    const publicProviders = providers.map(toPublicProvider);
    const enabled = publicProviders.filter((p) => p.enabled);
    const healthy = publicProviders.filter((p) => p.health === 'healthy');
    const withVerify = publicProviders
      .filter((p) => p.verifiedAt)
      .sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)));
    const last = withVerify[0];
    const warnings = publicProviders
      .filter((p) => p.verifyStatus === 'fail' || p.health === 'unavailable')
      .slice(0, 8)
      .map((p) => ({
        code: p.verifyCode ?? 'upstream_error',
        message: p.verifyError ?? `${p.id} unhealthy`,
        at: p.verifiedAt,
      }));
    const agents = await listAgents();

    // Lightweight model rows for aggregates
    const store = getStorage().config;
    const catalog = await store.listHubModels({ limit: 500 });
    const modelAggRows: Array<{ billing: string; routable: boolean }> = [
      { billing: 'unknown', routable: true }, // helmora-mini meta
      { billing: 'unknown', routable: true }, // auto
      ...HUB_MODES.map(() => ({ billing: 'unknown', routable: true })),
      ...catalog.models.map((m) => {
        const p = providers.find((x) => x.id === m.providerId);
        return {
          billing: m.billing ?? 'unknown',
          routable: Boolean(m.enabled && p?.enabled && p.verifyStatus === 'ok'),
        };
      }),
    ];
    for (const a of agents) {
      if (!a.enabled || !a.model || a.model === 'auto') continue;
      if (catalog.models.some((m) => m.modelId === a.model)) continue;
      modelAggRows.push({ billing: 'unknown', routable: true });
    }

    const aggregates = buildStatusAggregates(publicProviders, modelAggRows);

    res.json({
      ok: true,
      service: 'Helmora AI',
      version: HUB_VERSION,
      settingsUrl: '/settings',
      providersUrl: '/providers',
      modelsUrl: '/models',
      storage: {
        choice: config.storageChoice,
        backend: storage.config.backend,
        label:
          config.storageChoice === 'sql'
            ? 'Hybrid (Supabase control + local vault)'
            : 'Local',
        rate: storage.rate.backend,
      },
      control: getControlHealth(),
      mode,
      modeProfile: MODE_PROFILES[mode],
      providers: {
        total: providers.length,
        enabled: enabled.length,
        healthy: healthy.length,
        lastVerifiedAt: last?.verifiedAt ?? null,
        lastVerifiedId: last?.id ?? null,
      },
      models: {
        total: catalog.models.length + 2 + HUB_MODES.length,
      },
      aggregates,
      warnings,
      agents,
      fallbackChain: (await buildFallbackChain(mode)).map((p) => p.id),
      apiKeys: await storage.config.listApiKeys(),
      apiKeyPreview: maskSecret(await getUnifiedApiKey().catch(() => null)),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/modes', async (_req, res, next) => {
  try {
    res.json({
      active: await getActiveMode(),
      modes: HUB_MODES.map((id) => MODE_PROFILES[id]),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/modes/active', async (req, res, next) => {
  try {
    const schema = z.object({ mode: z.enum(HUB_MODES as [HubMode, ...HubMode[]]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    await setActiveMode(parsed.data.mode);
    res.json({ active: parsed.data.mode, profile: MODE_PROFILES[parsed.data.mode] });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/toggles', async (_req, res, next) => {
  try {
    res.json({
      providers: (await listProviders()).map(toPublicProvider),
    });
  } catch (err) {
    next(err);
  }
});

/** Spec contract alias for SPA */
adminRouter.get('/providers', async (_req, res, next) => {
  try {
    res.json({
      providers: (await listProviders()).map(toPublicProvider),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/providers/catalog', async (_req, res, next) => {
  try {
    const { PROVIDER_CATALOG } = await import('../providers/catalog/index.js');
    res.json({
      count: PROVIDER_CATALOG.length,
      catalog: PROVIDER_CATALOG.map((e) => ({
        id: e.id,
        label: e.label,
        tier: e.tier,
        protocol: e.protocol,
        catalogReady: e.catalogReady,
        source: e.source,
        defaultModel: e.defaultModel,
        baseUrl: e.baseUrl,
      })),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/models', async (req, res, next) => {
  try {
    const store = getStorage().config;
    const providers = await listProviders();
    const agents = await listAgents();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const providerFilter =
      typeof req.query.provider === 'string' ? req.query.provider.trim() : '';
    const sourceFilter =
      typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const kindFilter =
      typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
    const enabledRaw = typeof req.query.enabled === 'string' ? req.query.enabled : '';
    const enabledFilter =
      enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limit = Math.max(
      1,
      Math.min(Number(req.query.limit) || 200, 500)
    );

    const catalog = await store.listHubModels({
      providerId: providerFilter || undefined,
      source:
        sourceFilter === 'manual' ||
        sourceFilter === 'discovered' ||
        sourceFilter === 'seed'
          ? sourceFilter
          : undefined,
      enabled: enabledFilter,
      q: q || undefined,
      cursor,
      limit,
    });

    const providerById = new Map(providers.map((p) => [p.id, p]));
    let models = catalog.models.map((m) =>
      toCatalogModelResponse(m, providerById.get(m.providerId), agents)
    );

    const includeMeta = !kindFilter || kindFilter === 'meta';
    const includeAgent = !kindFilter || kindFilter === 'agent';
    const includeProvider = !kindFilter || kindFilter === 'provider';

    if (!includeProvider) models = [];

    if (includeMeta && !cursor) {
      const meta = [
        metaCatalogRow({
          modelId: 'helmora-mini-1.0',
          displayName: 'Helmora Mini 1.0',
        }),
        metaCatalogRow({ modelId: 'auto' }),
        ...HUB_MODES.map((mode) => metaCatalogRow({ modelId: `mode/${mode}` })),
      ];
      models = [...meta, ...models];
    }

    if (includeAgent && !cursor) {
      const catalogModelIds = new Set(
        (await store.listHubModels({ limit: 500 })).models.map((m) => m.modelId)
      );
      for (const a of agents) {
        if (!a.enabled || !a.model || a.model === 'auto') continue;
        if (catalogModelIds.has(a.model)) continue;
        models.push(
          agentCatalogRow({
            agentId: a.id,
            nickname: a.nickname,
            modelId: a.model,
            mode: a.mode,
          })
        );
      }
    }

    if (kindFilter === 'provider') {
      models = models.filter((m) => m.kind === 'provider');
    } else if (kindFilter === 'meta') {
      models = models.filter((m) => m.kind === 'meta');
    } else if (kindFilter === 'agent') {
      models = models.filter((m) => m.kind === 'agent');
    }

    if (sourceFilter === 'builtin' || sourceFilter === 'agent_reference') {
      models = models.filter((m) => m.source === sourceFilter);
    }

    if (q) {
      const needle = q.toLowerCase();
      models = models.filter(
        (m) =>
          m.modelId.toLowerCase().includes(needle) ||
          m.displayName.toLowerCase().includes(needle) ||
          (m.providerLabel ?? '').toLowerCase().includes(needle) ||
          m.key.toLowerCase().includes(needle)
      );
    }

    models.sort((a, b) => {
      if (a.routable !== b.routable) return a.routable ? -1 : 1;
      return a.modelId.localeCompare(b.modelId);
    });

    res.json({
      count: models.length,
      refreshedAt: new Date().toISOString(),
      nextRefreshAt: null,
      nextCursor: catalog.nextCursor,
      models,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/models', async (req, res, next) => {
  try {
    const schema = z.object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      displayName: z.string().optional(),
      notes: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      isBenchmark: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }
    const store = getStorage().config;
    const created = await store.createHubModel({
      ...parsed.data,
      source: 'manual',
    });
    const providers = await listProviders();
    const agents = await listAgents();
    res.status(201).json({
      model: toCatalogModelResponse(
        created,
        providers.find((p) => p.id === created.providerId),
        agents
      ),
    });
  } catch (err) {
    sendMutationError(res, err, next);
  }
});

adminRouter.patch('/models/:catalogId', async (req, res, next) => {
  try {
    const schema = z.object({
      modelId: z.string().min(1).optional(),
      displayName: z.string().optional(),
      notes: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      isBenchmark: z.boolean().optional(),
      billing: z
        .enum(['free', 'paid', 'conditional_free', 'temporarily_free', 'unknown'])
        .nullable()
        .optional(),
      inputPricePerMTok: z.string().nullable().optional(),
      outputPricePerMTok: z.string().nullable().optional(),
      contextWindow: z.number().int().positive().nullable().optional(),
      capabilities: z.array(z.string()).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }
    const store = getStorage().config;
    const updated = await store.updateHubModel(String(req.params.catalogId), parsed.data);
    const providers = await listProviders();
    const agents = await listAgents();
    res.json({
      model: toCatalogModelResponse(
        updated,
        providers.find((p) => p.id === updated.providerId),
        agents
      ),
    });
  } catch (err) {
    sendMutationError(res, err, next);
  }
});

adminRouter.delete('/models/:catalogId', async (req, res, next) => {
  try {
    const store = getStorage().config;
    const catalogId = String(req.params.catalogId);
    const references = await getMiniCatalogReferences(catalogId);
    if (references.length > 0) {
      res.status(409).json({
        error: {
          message: 'Model is assigned to Helmora Mini and cannot be deleted.',
          type: 'model_in_use',
          references,
        },
      });
      return;
    }
    const ok = await store.deleteHubModel(catalogId);
    if (!ok) {
      res.status(404).json({ error: { message: 'Model not found', type: 'not_found' } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    sendMutationError(res, err, next);
  }
});

adminRouter.post('/models/import', async (req, res, next) => {
  try {
    const schema = z.object({
      providerId: z.string().min(1),
      models: z
        .array(
          z.object({
            modelId: z.string().min(1),
            displayName: z.string().optional(),
          })
        )
        .min(1),
      defaultModelId: z.string().optional(),
      benchmarkModelId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }
    const result = await getStorage().config.importHubModels(parsed.data);
    res.json(result);
  } catch (err) {
    sendMutationError(res, err, next);
  }
});

adminRouter.patch('/toggles/:id', patchProviderHandler);
adminRouter.patch('/providers/:id', patchProviderHandler);

adminRouter.post('/providers/:id/discover-models', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const existing = await getProvider(id);
    if (!existing) {
      res.status(404).json({ error: { message: 'Provider not found', type: 'not_found' } });
      return;
    }
    const result = await discoverProviderModels(existing);
    const catalog = await getStorage().config.listHubModels({
      providerId: id,
      limit: 500,
    });
    res.json({
      providerId: id,
      ...result,
      pinnedModels: existing.pinnedModels ?? [],
      catalogModelIds: catalog.models.map((m) => m.modelId),
      defaultModel: existing.defaultModel,
      benchmarkModel: existing.benchmarkModel,
    });
  } catch (err) {
    next(err);
  }
});

/** Compat: pin → create/upsert catalog row */
adminRouter.post('/providers/:id/pin-model', async (req, res, next) => {
  try {
    const schema = z.object({
      modelId: z.string().min(1),
      asDefault: z.boolean().optional(),
      asBenchmark: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }
    const providerId = String(req.params.id);
    const store = getStorage().config;
    const modelId = parsed.data.modelId.trim();
    const listed = await store.listHubModels({ providerId, limit: 500 });
    const existing = listed.models.find((m) => m.modelId === modelId);
    if (existing) {
      await store.updateHubModel(existing.id, {
        ...(parsed.data.asDefault ? { isDefault: true } : {}),
        ...(parsed.data.asBenchmark ? { isBenchmark: true } : {}),
      });
    } else {
      await store.createHubModel({
        providerId,
        modelId,
        source: 'manual',
        isDefault: parsed.data.asDefault,
        isBenchmark: parsed.data.asBenchmark,
      });
    }
    const provider = await getProvider(providerId);
    res.json({ provider: toPublicProvider(provider!) });
  } catch (err) {
    sendMutationError(res, err, next);
  }
});

adminRouter.post('/providers/:id/unpin-model', async (req, res, next) => {
  try {
    const schema = z.object({ modelId: z.string().min(1) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }
    const providerId = String(req.params.id);
    const store = getStorage().config;
    const modelId = parsed.data.modelId.trim();
    const listed = await store.listHubModels({ providerId, limit: 500 });
    const existing = listed.models.find((m) => m.modelId === modelId);
    if (existing) {
      await store.deleteHubModel(existing.id);
    }
    const provider = await getProvider(providerId);
    res.json({ provider: toPublicProvider(provider!) });
  } catch (err) {
    sendMutationError(res, err, next);
  }
});

async function patchProviderHandler(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
) {
  try {
    const schema = z.object({
      enabled: z.boolean().optional(),
      label: z.string().min(1).optional(),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      baseUrl: z.string().nullable().optional(),
      apiKey: z.string().nullable().optional(),
      credential: z.string().nullable().optional(),
      clearCredential: z.boolean().optional(),
      defaultModel: z.string().nullable().optional(),
      benchmarkModel: z.string().nullable().optional(),
      pinnedModels: z.array(z.string().min(1)).optional(),
      allowedModes: z.array(z.enum(HUB_MODES as [HubMode, ...HubMode[]])).optional(),
      capabilities: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }
    const id = String(req.params.id);
    const existing = await getProvider(id);
    if (!existing) {
      res.status(404).json({ error: { message: 'Provider not found', type: 'not_found' } });
      return;
    }

    if (parsed.data.enabled === true && existing.verifyStatus !== 'ok') {
      res.status(400).json({
        error: {
          message: 'Provider must pass Verify before enabling (verifyStatus must be ok).',
          type: 'verify_required',
          code: 'verify_required',
        },
        verifyStatus: existing.verifyStatus,
        verifyError: existing.verifyError,
      });
      return;
    }

    const patch: Parameters<typeof updateProvider>[1] = { ...parsed.data };
    if (parsed.data.credential !== undefined) {
      patch.apiKey = parsed.data.credential;
    }
    if (parsed.data.clearCredential) {
      patch.apiKey = null;
    }
    delete (patch as { credential?: unknown }).credential;
    delete (patch as { clearCredential?: unknown }).clearCredential;

    // Paste / clear API key updates authMode (never silently keep oauth when clearing key).
    if (patch.apiKey != null && String(patch.apiKey).trim() !== '') {
      patch.authMode = 'api_key';
    } else if (patch.apiKey === null && existing.authMode === 'api_key') {
      patch.authMode = 'none';
    }

    if (parsed.data.tier !== undefined && parsed.data.allowedModes === undefined) {
      patch.allowedModes = allowedModesForProviderTier(parsed.data.tier);
    }

    const updated = await updateProvider(id, patch);
    if (!updated) {
      res.status(404).json({ error: { message: 'Provider not found', type: 'not_found' } });
      return;
    }
    res.json({ provider: toPublicProvider(updated) });
  } catch (err) {
    next(err);
  }
}

adminRouter.post(['/toggles/:id/verify', '/providers/:id/verify'], async (req, res, next) => {
  try {
    const schema = z.object({
      apiKey: z.string().nullable().optional(),
      credential: z.string().nullable().optional(),
      baseUrl: z.string().nullable().optional(),
      benchmarkModel: z.string().nullable().optional(),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      persistOnSuccess: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }

    const id = String(req.params.id);
    const existing = await getProvider(id);
    if (!existing) {
      res.status(404).json({ error: { message: 'Provider not found', type: 'not_found' } });
      return;
    }

    const ephemeralKey =
      parsed.data.credential !== undefined
        ? parsed.data.credential
        : parsed.data.apiKey !== undefined
          ? parsed.data.apiKey
          : undefined;

    const { verifyProvider: runVerify } = await import('../providers/verify.js');
    const result = await runVerify(existing, {
      apiKey: ephemeralKey,
      baseUrl: parsed.data.baseUrl,
      benchmarkModel: parsed.data.benchmarkModel,
    });

    const verifyCode = result.ok ? null : classifyVerifyError(result.verifyError);
    const shouldPersist =
      result.ok &&
      parsed.data.persistOnSuccess === true &&
      ephemeralKey !== undefined;

    const updated = await updateProvider(id, {
      apiKey: shouldPersist ? ephemeralKey : undefined,
      authMode: shouldPersist ? 'api_key' : undefined,
      baseUrl: parsed.data.baseUrl === undefined ? undefined : parsed.data.baseUrl,
      tier: parsed.data.tier,
      benchmarkModel:
        parsed.data.benchmarkModel === undefined
          ? result.model ?? undefined
          : parsed.data.benchmarkModel,
      defaultModel:
        parsed.data.benchmarkModel === undefined ? undefined : parsed.data.benchmarkModel,
      verifyStatus: result.verifyStatus,
      verifyError: result.verifyError,
      verifiedAt: result.verifiedAt,
      enabled:
        result.ok && (shouldPersist || ephemeralKey === undefined)
          ? result.enabled
          : existing.enabled,
    });

    const provider = updated ? toPublicProvider(updated) : toPublicProvider(existing);
    res.status(200).json({
      ok: result.ok,
      verifyCode,
      message: result.ok ? 'Verification succeeded' : result.verifyError,
      verifyStatus: result.verifyStatus,
      verifyError: result.verifyError,
      verifiedAt: result.verifiedAt,
      latencyMs: result.latencyMs,
      model: result.model,
      provider,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/toggles/:id/disable', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const updated = await updateProvider(id, { enabled: false });
    if (!updated) {
      res.status(404).json({ error: { message: 'Provider not found', type: 'not_found' } });
      return;
    }
    res.json({ provider: toPublicProvider(updated) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/providers/:id/disable', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const updated = await updateProvider(id, { enabled: false });
    if (!updated) {
      res.status(404).json({ error: { message: 'Provider not found', type: 'not_found' } });
      return;
    }
    res.json({ provider: toPublicProvider(updated) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/agents', async (_req, res, next) => {
  try {
    res.json({ agents: await listAgents() });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/mini-route', async (_req, res, next) => {
  try {
    const projection = await getMiniRoleConfigProjection();
    res.json(await miniRouteAdminResponse(projection.config, projection.warnings));
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/mini-route', async (req, res, next) => {
  try {
    const parsed = miniRoleConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          message: 'Mini role configuration is invalid.',
          type: 'validation_error',
          fields: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: 'invalid_value',
            message: issue.message,
          })),
        },
      });
      return;
    }

    const config = normalizeMiniRoleConfig(parsed.data);
    const [providers, catalog] = await Promise.all([
      listProviders(),
      getStorage().config.listHubModels({ limit: 500 }),
    ]);
    const fields = validateMiniRoleConfigReferences(config, catalog.models, providers);
    if (fields.length > 0) {
      res.status(400).json({
        error: {
          message: 'Mini role configuration contains invalid catalog references.',
          type: 'validation_error',
          fields,
        },
      });
      return;
    }

    await setMiniRoleConfig(config);
    res.json(await miniRouteAdminResponse(config));
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/agents/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      nickname: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      model: z.string().min(1).optional(),
      mode: z.enum(HUB_MODES as [HubMode, ...HubMode[]]).optional(),
      deskId: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const updated = await updateAgent(String(req.params.id), parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ agent: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.use((_req, res) => {
  res.status(404).json({
    error: {
      message: `No admin API route for ${_req.method} ${_req.path}`,
      type: 'not_found',
    },
  });
});
