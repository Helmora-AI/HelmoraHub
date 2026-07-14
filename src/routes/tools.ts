import { Router } from 'express';
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
  const [credential, catalog, providers] = await Promise.all([
    store.getConnectorCredentialState('tinyfish'),
    store.listHubModels({ limit: 500 }),
    store.listProviders(),
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
    activity: [],
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
