import type { AgentConfig } from '../types.js';
import type { Config } from '../lib/config.js';
import { catalogToSeedProvider, PROVIDER_CATALOG } from '../providers/catalog/index.js';

/** Built from full FreeLLMAPI + 9Router catalog (+ builtins). */
export const DEFAULT_PROVIDERS = PROVIDER_CATALOG.map(catalogToSeedProvider);

export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'coordinator', nickname: 'Boss', enabled: true, model: 'auto', mode: 'smart', deskId: 'desk-coordinator' },
  { id: 'developer', nickname: 'Dev', enabled: true, model: 'auto', mode: 'coding', deskId: 'desk-developer' },
  { id: 'analyst', nickname: 'Ana', enabled: true, model: 'auto', mode: 'smart', deskId: 'desk-analyst' },
  { id: 'scout', nickname: 'Scout', enabled: true, model: 'auto', mode: 'economy', deskId: 'desk-scout' },
  { id: 'ops', nickname: 'Ops', enabled: true, model: 'auto', mode: 'economy', deskId: 'desk-ops' },
  { id: 'reviewer', nickname: 'Review', enabled: true, model: 'auto', mode: 'premium', deskId: 'desk-reviewer' },
];

export function resolvePaidUpstreamSeed(config: Config): {
  baseUrl: string | null;
  apiKey: string | null;
  defaultModel: string | null;
} {
  return {
    baseUrl: config.upstreamBaseUrl,
    apiKey: config.upstreamApiKey,
    defaultModel: config.upstreamModel,
  };
}
