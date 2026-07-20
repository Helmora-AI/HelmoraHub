import type {
  ToolRunCreate,
  ToolRunRecord,
  ToolRunPatch,
  ToolRunSource,
  ToolRunStatus,
} from './types.js';
import type { RegisteredConnectorId, RegisteredToolId, ToolRisk, ToolSurface } from '../tools/types.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const TOOLS = new Set<RegisteredToolId>(['web_search', 'web_fetch']);
const CONNECTORS = new Set<RegisteredConnectorId>(['tinyfish']);
const SURFACES = new Set<ToolSurface>(['mini', 'catalog', 'mode', 'direct']);
const SOURCES = new Set<ToolRunSource>(['runtime', 'admin_connector_test']);
const RISKS = new Set<ToolRisk>(['read', 'write']);
const STATUSES = new Set<ToolRunStatus>(['running', 'completed', 'failed', 'rejected']);

function identifier(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`Invalid tool-run ${field}.`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647) {
    throw new Error(`Invalid tool-run ${field}.`);
  }
  return Number(value);
}

export function createToolRunRecord(
  input: ToolRunCreate,
  generatedId: string,
  createdAt: number,
): ToolRunRecord {
  const toolId = identifier(input.toolId, 'toolId') as RegisteredToolId;
  const connector = identifier(input.connector, 'connector') as RegisteredConnectorId;
  const surface = input.surface;
  const source = input.source;
  const risk = input.risk;
  const status = input.status;
  if (!TOOLS.has(toolId) || !CONNECTORS.has(connector)) throw new Error('Unknown tool-run identity.');
  if (!SURFACES.has(surface) || !SOURCES.has(source) || !RISKS.has(risk) || !STATUSES.has(status)) {
    throw new Error('Invalid tool-run classification.');
  }
  const errorCode = input.errorCode == null ? null : String(input.errorCode);
  if (errorCode !== null && !ERROR_CODE.test(errorCode)) throw new Error('Invalid tool-run errorCode.');
  return {
    id: identifier(input.id ?? generatedId, 'id')!,
    requestId: identifier(input.requestId, 'requestId')!,
    toolId,
    connector,
    surface,
    source,
    answerCatalogId: identifier(input.answerCatalogId, 'answerCatalogId', true),
    plannerCatalogId: identifier(input.plannerCatalogId, 'plannerCatalogId', true),
    risk,
    status,
    durationMs: optionalInteger(input.durationMs, 'durationMs'),
    sourceCount: optionalInteger(input.sourceCount, 'sourceCount'),
    errorCode,
    createdAt,
  };
}

export function toolRunFromRow(
  row: Record<string, unknown>,
  options: { preserveRunning?: boolean } = {},
): ToolRunRecord {
  const interrupted = row.status === 'running' && !options.preserveRunning;
  const status = interrupted ? 'failed' : row.status;
  return createToolRunRecord({
    id: String(row.id),
    requestId: String(row.request_id),
    toolId: String(row.tool_id) as RegisteredToolId,
    connector: String(row.connector) as RegisteredConnectorId,
    surface: String(row.surface) as ToolSurface,
    source: String(row.source) as ToolRunSource,
    answerCatalogId: row.answer_catalog_id == null ? null : String(row.answer_catalog_id),
    plannerCatalogId: row.planner_catalog_id == null ? null : String(row.planner_catalog_id),
    risk: String(row.risk) as ToolRisk,
    status: status as ToolRunStatus,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    sourceCount: row.source_count == null ? null : Number(row.source_count),
    errorCode: interrupted
      ? 'run_interrupted'
      : row.error_code == null
        ? null
        : String(row.error_code),
  }, String(row.id), Number(row.created_at));
}

export function toolRunToRow(record: ToolRunRecord): Record<string, unknown> {
  return {
    id: record.id,
    request_id: record.requestId,
    tool_id: record.toolId,
    connector: record.connector,
    surface: record.surface,
    source: record.source,
    answer_catalog_id: record.answerCatalogId,
    planner_catalog_id: record.plannerCatalogId,
    risk: record.risk,
    status: record.status,
    duration_ms: record.durationMs,
    source_count: record.sourceCount,
    error_code: record.errorCode,
    created_at: record.createdAt,
  };
}

export function updateToolRunRecord(
  existing: ToolRunRecord,
  patch: ToolRunPatch,
): ToolRunRecord {
  return createToolRunRecord({
    ...existing,
    ...patch,
  }, existing.id, existing.createdAt);
}
