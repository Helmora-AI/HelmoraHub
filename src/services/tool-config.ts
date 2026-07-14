import { REGISTERED_TOOLS } from '../tools/registry.js';
import type {
  ConnectorCredentialMetadata,
  RegisteredToolId,
  ToolConfigValidationError,
  ToolPolicyOverride,
  ToolRuntimeConfig,
  ToolSurface,
} from '../tools/types.js';

const TOOL_IDS = new Set<RegisteredToolId>(REGISTERED_TOOLS.map((tool) => tool.id));
const TOOL_SURFACES: ToolSurface[] = ['mini', 'catalog', 'mode', 'direct'];
const SERVER_OWNED_OVERRIDE_FIELDS = [
  'connectorId',
  'risk',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'immutable',
] as const;
const SECRET_FIELD_PATTERN = /(?:api.?key|credential|secret|token|authorization)/i;

const DEFAULT_SCOPES: Record<ToolSurface, boolean> = {
  mini: true,
  catalog: true,
  mode: true,
  direct: true,
};

export const DEFAULT_TOOL_RUNTIME_CONFIG: ToolRuntimeConfig = {
  version: 1,
  enabled: false,
  orchestrator: {
    primaryCatalogId: null,
    fallbackCatalogId: null,
  },
  connectors: {
    tinyfish: {
      enabled: false,
      searchRequestsPerMinute: 25,
      fetchUrlsPerMinute: 120,
      searchCacheSeconds: 60,
      fetchCacheSeconds: 300,
    },
  },
  toolOverrides: REGISTERED_TOOLS.map((tool) => ({
    toolId: tool.id,
    enabled: true,
    scopes: { ...DEFAULT_SCOPES },
  })),
};

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function catalogId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : fallback;
}

function normalizeOverride(
  toolId: RegisteredToolId,
  input: Record<string, unknown> | undefined
): ToolPolicyOverride {
  const scopesInput = record(input?.scopes);
  const scopes = { ...DEFAULT_SCOPES };
  for (const surface of TOOL_SURFACES) {
    if (typeof scopesInput?.[surface] === 'boolean') scopes[surface] = scopesInput[surface];
  }
  return {
    toolId,
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : true,
    scopes,
  };
}

export function normalizeToolRuntimeConfig(input: unknown): ToolRuntimeConfig {
  const root = record(input);
  const orchestrator = record(root?.orchestrator);
  const connectors = record(root?.connectors);
  const tinyfish = record(connectors?.tinyfish);
  const overrideInputs = new Map<RegisteredToolId, Record<string, unknown>>();
  if (Array.isArray(root?.toolOverrides)) {
    for (const candidate of root.toolOverrides) {
      const item = record(candidate);
      const toolId = item?.toolId;
      if (item && typeof toolId === 'string' && TOOL_IDS.has(toolId as RegisteredToolId)) {
        overrideInputs.set(toolId as RegisteredToolId, item);
      }
    }
  }

  const defaults = DEFAULT_TOOL_RUNTIME_CONFIG.connectors.tinyfish;
  return {
    version: 1,
    enabled: typeof root?.enabled === 'boolean' ? root.enabled : false,
    orchestrator: {
      primaryCatalogId: catalogId(orchestrator?.primaryCatalogId),
      fallbackCatalogId: catalogId(orchestrator?.fallbackCatalogId),
    },
    connectors: {
      tinyfish: {
        enabled: typeof tinyfish?.enabled === 'boolean' ? tinyfish.enabled : false,
        searchRequestsPerMinute: boundedInteger(
          tinyfish?.searchRequestsPerMinute, 1, 30, defaults.searchRequestsPerMinute
        ),
        fetchUrlsPerMinute: boundedInteger(
          tinyfish?.fetchUrlsPerMinute, 1, 150, defaults.fetchUrlsPerMinute
        ),
        searchCacheSeconds: boundedInteger(
          tinyfish?.searchCacheSeconds, 0, 86_400, defaults.searchCacheSeconds
        ),
        fetchCacheSeconds: boundedInteger(
          tinyfish?.fetchCacheSeconds, 0, 86_400, defaults.fetchCacheSeconds
        ),
      },
    },
    toolOverrides: REGISTERED_TOOLS.map((tool) =>
      normalizeOverride(tool.id, overrideInputs.get(tool.id))
    ),
  };
}

function error(
  errors: ToolConfigValidationError[],
  path: string,
  code: string,
  message: string
): void {
  errors.push({ path, code, message });
}

function validateInteger(
  errors: ToolConfigValidationError[],
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number
): void {
  const value = source[field];
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    error(errors, `connectors.tinyfish.${field}`, 'out_of_range', `${field} must be ${min}–${max}.`);
  }
}

export function validateToolRuntimeConfigDraft(input: unknown):
  | { ok: true; config: ToolRuntimeConfig }
  | { ok: false; errors: ToolConfigValidationError[] } {
  const errors: ToolConfigValidationError[] = [];
  const root = record(input);
  if (!root) return {
    ok: false,
    errors: [{ path: '', code: 'invalid_type', message: 'Configuration must be an object.' }],
  };

  for (const key of Object.keys(root)) {
    if (!['version', 'enabled', 'orchestrator', 'connectors', 'toolOverrides'].includes(key)) {
      error(errors, key, SECRET_FIELD_PATTERN.test(key) ? 'secret_not_allowed' : 'unknown_field',
        SECRET_FIELD_PATTERN.test(key) ? 'Secrets must use the connector credential endpoint.' : 'Unknown field.');
    }
  }
  if (root.version !== 1) error(errors, 'version', 'unsupported_version', 'Version must be 1.');
  if (typeof root.enabled !== 'boolean') error(errors, 'enabled', 'invalid_type', 'Enabled must be boolean.');

  const orchestrator = record(root.orchestrator);
  if (!orchestrator) {
    error(errors, 'orchestrator', 'invalid_type', 'Orchestrator must be an object.');
  } else {
    for (const field of ['primaryCatalogId', 'fallbackCatalogId'] as const) {
      const value = orchestrator[field];
      if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
        error(errors, `orchestrator.${field}`, 'invalid_catalog_id', 'Catalog ID must be non-empty or null.');
      }
    }
    const primary = catalogId(orchestrator.primaryCatalogId);
    const fallback = catalogId(orchestrator.fallbackCatalogId);
    if (primary && fallback && primary === fallback) {
      error(errors, 'orchestrator.fallbackCatalogId', 'duplicate_orchestrator_model',
        'Primary and fallback catalog models must differ.');
    }
  }

  const connectors = record(root.connectors);
  if (connectors) {
    for (const connectorId of Object.keys(connectors)) {
      if (connectorId !== 'tinyfish') {
        error(
          errors,
          `connectors.${connectorId}`,
          'unknown_connector',
          'Connector ID is not registered.',
        );
      }
    }
  }
  const tinyfish = record(connectors?.tinyfish);
  if (!connectors || !tinyfish) {
    error(errors, 'connectors.tinyfish', 'invalid_type', 'TinyFish connector config is required.');
  } else {
    for (const key of Object.keys(tinyfish)) {
      if (![
        'enabled',
        'searchRequestsPerMinute',
        'fetchUrlsPerMinute',
        'searchCacheSeconds',
        'fetchCacheSeconds',
      ].includes(key)) {
        const secret = SECRET_FIELD_PATTERN.test(key);
        error(errors, `connectors.tinyfish.${key}`, secret ? 'secret_not_allowed' : 'unknown_field',
          secret ? 'Secrets must use the connector credential endpoint.' : 'Unknown connector field.');
      }
    }
    if (typeof tinyfish.enabled !== 'boolean') {
      error(errors, 'connectors.tinyfish.enabled', 'invalid_type', 'Enabled must be boolean.');
    }
    validateInteger(errors, tinyfish, 'searchRequestsPerMinute', 1, 30);
    validateInteger(errors, tinyfish, 'fetchUrlsPerMinute', 1, 150);
    validateInteger(errors, tinyfish, 'searchCacheSeconds', 0, 86_400);
    validateInteger(errors, tinyfish, 'fetchCacheSeconds', 0, 86_400);
  }

  const seen = new Set<RegisteredToolId>();
  if (!Array.isArray(root.toolOverrides)) {
    error(errors, 'toolOverrides', 'invalid_type', 'Tool overrides must be an array.');
  } else {
    root.toolOverrides.forEach((candidate, index) => {
      const item = record(candidate);
      const base = `toolOverrides.${index}`;
      if (!item) {
        error(errors, base, 'invalid_type', 'Tool override must be an object.');
        return;
      }
      for (const field of SERVER_OWNED_OVERRIDE_FIELDS) {
        if (field in item) {
          error(errors, `${base}.${field}`, 'server_owned_field', `${field} is owned by the server registry.`);
        }
      }
      const toolId = item.toolId;
      if (typeof toolId !== 'string' || !TOOL_IDS.has(toolId as RegisteredToolId)) {
        error(errors, `${base}.toolId`, 'unknown_tool', 'Tool ID is not registered.');
      } else if (seen.has(toolId as RegisteredToolId)) {
        error(errors, `${base}.toolId`, 'duplicate_tool_override', 'Tool override is duplicated.');
      } else {
        seen.add(toolId as RegisteredToolId);
      }
      if (typeof item.enabled !== 'boolean') {
        error(errors, `${base}.enabled`, 'invalid_type', 'Enabled must be boolean.');
      }
      const scopes = record(item.scopes);
      if (!scopes) {
        error(errors, `${base}.scopes`, 'invalid_type', 'Scopes must be an object.');
      } else {
        for (const scope of Object.keys(scopes)) {
          if (!TOOL_SURFACES.includes(scope as ToolSurface)) {
            error(errors, `${base}.scopes.${scope}`, 'unknown_scope', 'Tool scope is not supported.');
          }
        }
        for (const surface of TOOL_SURFACES) {
          if (typeof scopes[surface] !== 'boolean') {
            error(errors, `${base}.scopes.${surface}`, 'invalid_type', 'Scope must be boolean.');
          }
        }
      }
    });
  }
  for (const toolId of TOOL_IDS) {
    if (!seen.has(toolId)) {
      error(errors, 'toolOverrides', 'missing_tool_override', `Missing override for ${toolId}.`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: normalizeToolRuntimeConfig(root) };
}

export function maskConnectorCredential(secret: string | null): ConnectorCredentialMetadata {
  if (!secret) return { credentialConfigured: false, credentialHint: null };
  return {
    credentialConfigured: true,
    credentialHint: `…${secret.slice(-4)}`,
  };
}
