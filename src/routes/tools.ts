import { Router } from 'express';
import { randomId } from '../lib/auth.js';
import { getConfigStore, getControlHealth } from '../storage/index.js';
import { REGISTERED_CONNECTORS, REGISTERED_TOOLS } from '../tools/registry.js';
import type { ToolConfigValidationError, ToolRuntimeConfig } from '../tools/types.js';
import type { ProviderToggle } from '../types.js';
import type { StoredHubModel } from '../models/types.js';
import {
  getToolRuntimeConfig,
  normalizeToolRuntimeConfig,
  setToolRuntimeConfig,
  validateToolOrchestratorReferences,
  validateToolRuntimeConfigDraft,
} from '../services/tool-config.js';
import { getTinyFishToolExecutor } from '../services/tool-executor-manager.js';
import { TinyFishConnectorError } from '../tools/connectors/tinyfish-client.js';

export const toolsRouter = Router();

function providerNeedsCredentials(provider: ProviderToggle): boolean {
  if (!provider.baseUrl) return false;
  if (provider.authStyle === 'none' || provider.protocol === 'keyless') return false;
  if (provider.authMode === 'oauth') return provider.oauthState !== 'connected';
  return !provider.apiKey;
}

function orchestratorSummary(
  catalogId: string | null,
  catalogById: Map<string, StoredHubModel>,
  providersById: Map<string, ProviderToggle>,
) {
  if (!catalogId) return null;
  const model = catalogById.get(catalogId);
  if (!model) return { catalogId, model: null, status: 'missing' as const };
  const provider = providersById.get(model.providerId);
  if (!provider) return { catalogId, model: null, status: 'provider_missing' as const };
  const needsCredentials = providerNeedsCredentials(provider);
  const routable = Boolean(
    model.enabled
    && provider.enabled
    && provider.verifyStatus === 'ok'
    && provider.catalogReady
    && !needsCredentials
  );
  const status = !model.enabled || !provider.enabled
    ? 'disabled'
    : needsCredentials
      ? 'credentials_required'
      : routable
        ? 'ready'
        : 'degraded';
  return {
    catalogId,
    providerId: provider.id,
    providerLabel: provider.label,
    modelId: model.modelId,
    displayName: model.displayName,
    enabled: model.enabled,
    routable,
    status,
    protocol: provider.protocol,
  };
}

async function toolsAdminResponse(config: ToolRuntimeConfig) {
  const store = getConfigStore();
  const [credential, catalog, providers, activity] = await Promise.all([
    store.getConnectorCredentialState('tinyfish'),
    store.listHubModels({ limit: 500 }),
    store.listProviders(),
    store.listToolRuns({ limit: 10 }),
  ]);
  const catalogById = new Map(catalog.models.map((model) => [model.id, model]));
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const warnings: ToolConfigValidationError[] = [];
  for (const slot of ['primaryCatalogId', 'fallbackCatalogId'] as const) {
    const summary = orchestratorSummary(config.orchestrator[slot], catalogById, providersById);
    if (summary && summary.status !== 'ready') {
      warnings.push({
        path: `orchestrator.${slot}`,
        code: `orchestrator_${summary.status}`,
        message: `The selected ${slot === 'primaryCatalogId' ? 'primary' : 'fallback'} orchestrator is ${summary.status}.`,
      });
    }
  }
  if (config.connectors.tinyfish.enabled && !credential.credentialConfigured) {
    warnings.push({
      path: 'connectors.tinyfish',
      code: 'credentials_required',
      message: 'TinyFish requires an API key before Search or Fetch can run.',
    });
  }
  const overrides = new Map(config.toolOverrides.map((override) => [override.toolId, override]));
  const connectorStatus = !config.connectors.tinyfish.enabled
    ? 'disabled'
    : credential.credentialConfigured
      ? 'ready'
      : 'credentials_required';

  return {
    product: { id: 'helmora-tools', displayName: 'Tools' },
    config,
    registry: {
      connectors: REGISTERED_CONNECTORS,
      tools: REGISTERED_TOOLS.map((tool) => ({
        ...tool,
        policy: overrides.get(tool.id),
      })),
    },
    orchestrator: {
      primary: orchestratorSummary(
        config.orchestrator.primaryCatalogId,
        catalogById,
        providersById,
      ),
      fallback: orchestratorSummary(
        config.orchestrator.fallbackCatalogId,
        catalogById,
        providersById,
      ),
    },
    connectors: {
      tinyfish: {
        ...credential,
        status: connectorStatus,
        profile: 'TinyFish Search + Fetch Free',
      },
    },
    controlHealth: getControlHealth(),
    warnings,
    activity,
  };
}

function validationError(res: import('express').Response, fields: ToolConfigValidationError[]) {
  res.status(400).json({
    error: {
      type: 'validation_error',
      message: 'Tools configuration is invalid.',
      fields,
    },
  });
}

function encodeActivityCursor(record: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: record.createdAt, id: record.id }), 'utf8')
    .toString('base64url');
}

function decodeActivityCursor(value: unknown): { createdAt: number; id: string } | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      !Number.isInteger(parsed.createdAt)
      || Number(parsed.createdAt) < 0
      || typeof parsed.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(parsed.id)
    ) return null;
    return { createdAt: Number(parsed.createdAt), id: parsed.id };
  } catch {
    return null;
  }
}

toolsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await toolsAdminResponse(await getToolRuntimeConfig()));
  } catch (error) {
    next(error);
  }
});

toolsRouter.put('/config', async (req, res, next) => {
  try {
    const structural = validateToolRuntimeConfigDraft(req.body);
    const normalized = normalizeToolRuntimeConfig(req.body);
    const store = getConfigStore();
    const [catalog, providers] = await Promise.all([
      store.listHubModels({ limit: 500 }),
      store.listProviders(),
    ]);
    const fields = [
      ...(structural.ok ? [] : structural.errors),
      ...validateToolOrchestratorReferences(normalized, catalog.models, providers),
    ];
    if (fields.length > 0) {
      validationError(res, fields);
      return;
    }
    const config = structural.ok ? structural.config : normalized;
    await setToolRuntimeConfig(config);
    res.json(await toolsAdminResponse(config));
  } catch (error) {
    next(error);
  }
});

toolsRouter.put('/connectors/tinyfish/credential', async (req, res, next) => {
  try {
    const body = req.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      validationError(res, [{ path: '', code: 'invalid_type', message: 'Body must be an object.' }]);
      return;
    }
    const keys = Object.keys(body);
    const unknown = keys.filter((key) => key !== 'secret' && key !== 'clear');
    if (unknown.length > 0) {
      validationError(res, unknown.map((key) => ({
        path: key,
        code: 'unknown_field',
        message: 'Unknown credential operation field.',
      })));
      return;
    }
    if (body.clear !== undefined && typeof body.clear !== 'boolean') {
      validationError(res, [{ path: 'clear', code: 'invalid_type', message: 'Clear must be boolean.' }]);
      return;
    }
    if (body.secret !== undefined && typeof body.secret !== 'string') {
      validationError(res, [{ path: 'secret', code: 'invalid_type', message: 'Secret must be a string.' }]);
      return;
    }
    if (
      typeof body.secret === 'string'
      && (body.secret.trim().length === 0 || body.secret.length > 16_384)
    ) {
      validationError(res, [{
        path: 'secret',
        code: 'invalid_secret',
        message: 'Secret must be non-empty and at most 16384 characters.',
      }]);
      return;
    }
    if (body.clear === true && body.secret !== undefined) {
      validationError(res, [{
        path: 'secret',
        code: 'conflicting_operation',
        message: 'Secret cannot be supplied when clearing the credential.',
      }]);
      return;
    }
    const secret = body.clear === true ? null : body.secret;
    const state = await getConfigStore().updateConnectorCredential('tinyfish', { secret });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

toolsRouter.post('/connectors/tinyfish/test', async (_req, res, next) => {
  const store = getConfigStore();
  const requestId = randomId('req');
  const startedAt = Date.now();
  try {
    const config = await getToolRuntimeConfig();
    const executor = await getTinyFishToolExecutor(store, config);
    const execution = await executor.execute(
      'web_search',
      { query: 'TinyFish connectivity check' },
      { bypassCache: true },
    );
    const durationMs = Math.max(0, Date.now() - startedAt);
    await store.recordToolRun({
      requestId,
      toolId: 'web_search',
      connector: 'tinyfish',
      surface: 'direct',
      source: 'admin_connector_test',
      answerCatalogId: null,
      plannerCatalogId: null,
      risk: 'read',
      status: 'completed',
      durationMs,
      sourceCount: execution.result.sources.length,
      errorCode: null,
    });
    res.json({
      ok: true,
      requestId,
      connectorId: 'tinyfish',
      toolId: 'web_search',
      cacheHit: execution.cacheHits > 0,
      attempts: execution.attempts,
      sourceCount: execution.result.sources.length,
      durationMs,
      health: executor.getHealth(),
    });
  } catch (error) {
    const code = error instanceof TinyFishConnectorError ? error.code : 'tool_execution_failed';
    try {
      await store.recordToolRun({
        requestId,
        toolId: 'web_search',
        connector: 'tinyfish',
        surface: 'direct',
        source: 'admin_connector_test',
        answerCatalogId: null,
        plannerCatalogId: null,
        risk: 'read',
        status: 'failed',
        durationMs: Math.max(0, Date.now() - startedAt),
        sourceCount: null,
        errorCode: code,
      });
    } catch {
      // Preserve the public connector failure instead of replacing it with an audit-store error.
      console.error('[tools] connector test audit persistence failed', { requestId });
    }
    if (error instanceof TinyFishConnectorError) {
      const status = code === 'rate_limited' || code === 'tool_rate_limited'
        ? 429
        : code === 'invalid_credentials' || code === 'tool_unavailable'
          ? 409
          : 502;
      res.status(status).json({
        error: {
          type: code,
          message: error.message,
          requestId,
          connectorId: 'tinyfish',
        },
      });
      return;
    }
    next(error);
  }
});

toolsRouter.get('/activity', async (req, res, next) => {
  try {
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (
      (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)))
      || !Number.isInteger(limit)
      || limit < 1
      || limit > 200
    ) {
      validationError(res, [{
        path: 'limit',
        code: 'invalid_limit',
        message: 'Activity limit must be an integer from 1 to 200.',
      }]);
      return;
    }
    const before = decodeActivityCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !before) {
      validationError(res, [{
        path: 'cursor',
        code: 'invalid_cursor',
        message: 'Activity cursor is invalid.',
      }]);
      return;
    }
    const rows = await getConfigStore().listToolRuns({ limit: limit + 1, ...(before ? { before } : {}) });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    res.json({
      items,
      nextCursor: rows.length > limit && last ? encodeActivityCursor(last) : null,
    });
  } catch (error) {
    next(error);
  }
});
