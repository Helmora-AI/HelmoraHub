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
    description: 'Search the public web for current facts and evidence. Use locale and freshness filters for time-sensitive claims; prefer recent authoritative sources.',
    connectorId: 'tinyfish',
    risk: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Focused search query.' },
        location: { type: 'string', minLength: 2, maxLength: 2, pattern: '^[A-Za-z]{2}$', description: 'ISO 3166-1 alpha-2 country code, for example VN or US.' },
        language: { type: 'string', minLength: 2, maxLength: 35, description: 'BCP 47 result language, for example vi or en.' },
        page: { type: 'integer', minimum: 0, maximum: 10 },
        recencyMinutes: { type: 'integer', minimum: 1, maximum: 5_256_000, description: 'Recent-result window. Do not combine with afterDate/beforeDate.' },
        afterDate: { type: 'string', format: 'date' },
        beforeDate: { type: 'string', format: 'date' },
        domainType: { enum: ['web', 'news', 'research_paper'], description: 'Use news for recent events and scores, research_paper for academic evidence, otherwise web.' },
        purpose: { type: 'string', maxLength: 2_000, description: 'The fact this search should establish for the user.' },
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
