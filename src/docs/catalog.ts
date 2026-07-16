/**
 * Public API documentation catalog — served at GET /docs.json
 */
import { HUB_VERSION } from '../lib/version.js';

export const DOCS_CATALOG = {
  name: 'Helmora AI',
  version: HUB_VERSION,
  openai_compatible: true,
  base_paths: {
    v1: '/v1',
    docs: '/docs',
    health: '/health',
  },
  authentication: {
    schemes: [
      {
        type: 'http',
        scheme: 'bearer',
        description: 'Authorization: Bearer hel_dev_… or hel_pro_…',
      },
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Alternate header with the same plaintext key',
      },
    ],
    issue: 'Create keys in the admin SPA under Operate → API Keys',
  },
  endpoints: [
    {
      method: 'GET',
      path: '/v1/models',
      auth: 'api_key',
      summary: 'List routable / meta models',
    },
    {
      method: 'POST',
      path: '/v1/chat/completions',
      auth: 'api_key',
      summary: 'Chat completions (JSON or SSE stream)',
      stream: true,
    },
    {
      method: 'POST',
      path: '/v1/embeddings',
      auth: 'api_key',
      summary: 'Create embeddings (OpenAI-compatible)',
    },
    {
      method: 'GET',
      path: '/health',
      auth: 'none',
      summary: 'Liveness probe',
    },
    {
      method: 'GET',
      path: '/docs',
      auth: 'none',
      summary: 'Human-readable API documentation',
    },
    {
      method: 'GET',
      path: '/docs.json',
      auth: 'none',
      summary: 'This catalog',
    },
  ],
  notes: [
    'Admin Playground uses /api/chat/completions with a SPA session — not these API keys.',
    'Usage for /v1 is billed to the API key ledger (source=api).',
    'Embeddings fall back to deterministic demo vectors when no OpenAI-compatible upstream is ready.',
  ],
} as const;
