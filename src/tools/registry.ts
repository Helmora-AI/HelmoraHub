import type { RegisteredConnector, RegisteredTool } from './types.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const REGISTERED_CONNECTORS: readonly RegisteredConnector[] = deepFreeze([
  { id: 'tinyfish', capabilities: ['search', 'fetch'] },
]);

export const REGISTERED_TOOLS: readonly RegisteredTool[] = deepFreeze([
  {
    id: 'web_search',
    title: 'Search web',
    description: 'Search the public web for current sources and evidence.',
    connectorId: 'tinyfish',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000 },
        location: { type: 'string', minLength: 1, maxLength: 200 },
        language: { type: 'string', minLength: 2, maxLength: 35 },
        page: { type: 'integer', minimum: 0, maximum: 10 },
        recencyMinutes: { type: 'integer', minimum: 1 },
        afterDate: { type: 'string', format: 'date' },
        beforeDate: { type: 'string', format: 'date' },
        domainType: { enum: ['web', 'news', 'research_paper'] },
        purpose: { type: 'string', maxLength: 500 },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'sources'],
      properties: {
        content: { type: 'string' },
        sources: { type: 'array', items: { type: 'object' } },
      },
    },
    immutable: true,
  },
  {
    id: 'web_fetch',
    title: 'Read URL',
    description: 'Fetch normalized Markdown or JSON from approved public HTTPS URLs.',
    connectorId: 'tinyfish',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['urls'],
      properties: {
        urls: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { type: 'string', format: 'uri', maxLength: 4_096 },
        },
        format: { enum: ['markdown', 'json'] },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'sources'],
      properties: {
        content: { type: 'string' },
        sources: { type: 'array', items: { type: 'object' } },
      },
    },
    immutable: true,
  },
]);
