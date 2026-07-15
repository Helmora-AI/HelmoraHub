import { isMetaModel } from '../keys/types.js';
import { REGISTERED_TOOLS } from '../tools/registry.js';
import type { RegisteredTool, ToolRuntimeConfig, ToolSurface } from '../tools/types.js';

export type ToolsPolicy = 'off' | 'auto' | 'force';
export type ToolRequestSource = 'api' | 'admin_chat';
export type ToolRequestContext = {
  surface: ToolSurface;
  requestedPolicy: ToolsPolicy | undefined;
  effectivePolicy: ToolsPolicy;
  relevanceMatched: boolean;
  eligibleTools: readonly RegisteredTool[];
};

export type ParsedToolsHeader =
  | { ok: true; value: ToolsPolicy | undefined }
  | { ok: false; value: null };

export function parseToolsHeader(value: unknown): ParsedToolsHeader {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, value: null };
  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'auto' || normalized === 'force') {
    return { ok: true, value: normalized };
  }
  return { ok: false, value: null };
}

export function resolveToolsPolicy(input: {
  runtimeEnabled: boolean;
  requestHeader?: ToolsPolicy;
  surfaceDefault: 'off' | 'auto';
  hasEligibleTools: boolean;
  relevanceMatched: boolean;
}): ToolsPolicy {
  if (!input.runtimeEnabled) return 'off';

  const requested = input.requestHeader ?? input.surfaceDefault;
  if (requested === 'off') return 'off';
  if (!input.hasEligibleTools) return 'off';
  if (requested === 'auto' && !input.relevanceMatched) return 'off';
  return requested;
}

export function resolveToolSurface(model: string | undefined): ToolSurface {
  const normalized = model?.trim() ?? '';
  if (normalized === 'auto' || isMetaModel(normalized)) return 'mini';
  if (normalized.startsWith('catalog/')) return 'catalog';
  if (normalized.startsWith('mode/')) return 'mode';
  return 'direct';
}

export function toolSurfaceDefault(
  surface: ToolSurface,
  source: ToolRequestSource
): 'off' | 'auto' {
  if (source === 'admin_chat') return 'auto';
  return surface === 'mini' ? 'auto' : 'off';
}

export function projectEligibleTools(
  config: ToolRuntimeConfig,
  surface: ToolSurface
): readonly RegisteredTool[] {
  if (!config.connectors.tinyfish.enabled) return [];
  const overrides = new Map(config.toolOverrides.map((override) => [override.toolId, override]));
  return REGISTERED_TOOLS.filter((tool) => {
    const override = overrides.get(tool.id);
    return override?.enabled === true && override.scopes[surface] === true;
  });
}

function normalizeIntent(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const RELEVANCE_PHRASES = [
  'latest',
  'breaking news',
  'current information',
  'current sources',
  'current price',
  'current weather',
  'up to date',
  'real time',
  'search the web',
  'search online',
  'search internet',
  'look it up',
  'find sources',
  'cite sources',
  'research this',
  'verify online',
  'moi nhat',
  'tin moi',
  'thong tin hien tai',
  'gia hien tai',
  'thoi tiet hien tai',
  'cap nhat moi',
  'thoi gian thuc',
  'tim tren web',
  'tim kiem tren mang',
  'tra cuu',
  'tim nguon',
  'trich dan nguon',
  'nghien cuu',
  'kiem chung',
] as const;

export function hasToolRelevance(text: string): boolean {
  const normalized = normalizeIntent(text);
  if (!normalized) return false;
  if (/https:\/\/[^\s]+/i.test(text)) return true;
  return RELEVANCE_PHRASES.some((phrase) => normalized.includes(phrase));
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function hasUnsupportedClientTools(body: unknown): boolean {
  const root = objectRecord(body);
  if (!root) return false;
  if (Object.hasOwn(root, 'tools') || Object.hasOwn(root, 'tool_choice')) return true;
  if (!Array.isArray(root.messages)) return false;
  return root.messages.some((message) => objectRecord(message)?.role === 'tool');
}

export function latestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectRecord(messages[index]);
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          const item = objectRecord(part);
          return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }
  return '';
}

export function buildToolRequestContext(input: {
  config: ToolRuntimeConfig;
  model: string | undefined;
  source: ToolRequestSource;
  requestHeader: ToolsPolicy | undefined;
  messages: unknown;
}): ToolRequestContext {
  const surface = resolveToolSurface(input.model);
  const eligibleTools = projectEligibleTools(input.config, surface);
  const relevanceMatched = hasToolRelevance(latestUserText(input.messages));
  return {
    surface,
    requestedPolicy: input.requestHeader,
    effectivePolicy: resolveToolsPolicy({
      runtimeEnabled: input.config.enabled,
      requestHeader: input.requestHeader,
      surfaceDefault: toolSurfaceDefault(surface, input.source),
      hasEligibleTools: eligibleTools.length > 0,
      relevanceMatched,
    }),
    relevanceMatched,
    eligibleTools,
  };
}
