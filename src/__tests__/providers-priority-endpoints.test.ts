import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG, isChatProtocolReady } from '../providers/catalog/index.js';
import { PRIORITY_PROVIDER_IDS } from '../providers/catalog/priority.js';

/** Independent expectations from the approved P3.1b spec — not used to build catalog. */
const EXPECTED_PRIORITY_PROVIDERS: Record<
  string,
  {
    label: string;
    baseUrl: string;
    authStyle: string;
    protocol: string;
    catalogReady: true;
  }
> = {
  ollama: {
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  modelscope: {
    label: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  llm7: {
    label: 'LLM7',
    baseUrl: 'https://api.llm7.io/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  kiraai: {
    label: 'Kira AI',
    baseUrl: 'https://kiraai.vn/api/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  aimlapi: {
    label: 'AI/ML API',
    baseUrl: 'https://api.aimlapi.com/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  gemini: {
    label: 'Gemini (AI Studio)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authStyle: 'query-key',
    protocol: 'gemini',
    catalogReady: true,
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    authStyle: 'account_token',
    protocol: 'openai',
    catalogReady: true,
  },
  'glm-cn': {
    label: 'BigModel.cn',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
  zhipu: {
    label: 'Zhipu / BigModel (paas)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authStyle: 'bearer',
    protocol: 'openai',
    catalogReady: true,
  },
};

describe('priority provider endpoints (catalog)', () => {
  it('exports priority ids only (no paid-upstream)', () => {
    expect(PRIORITY_PROVIDER_IDS.has('paid-upstream')).toBe(false);
    expect(PRIORITY_PROVIDER_IDS.size).toBe(Object.keys(EXPECTED_PRIORITY_PROVIDERS).length);
  });

  it('matches independent golden fields once per priority id', () => {
    for (const [id, expected] of Object.entries(EXPECTED_PRIORITY_PROVIDERS)) {
      expect(PRIORITY_PROVIDER_IDS.has(id)).toBe(true);
      const hits = PROVIDER_CATALOG.filter((e) => e.id === id);
      expect(hits).toHaveLength(1);
      const e = hits[0]!;
      expect(e.label).toBe(expected.label);
      expect(e.baseUrl).toBe(expected.baseUrl);
      expect(e.authStyle).toBe(expected.authStyle);
      expect(e.protocol).toBe(expected.protocol);
      expect(e.catalogReady).toBe(true);
      expect(e.baseUrl).not.toMatch(/\/chat\/completions\/?$/);
      expect(() => new URL(e.baseUrl!.replace('{accountId}', 'acct'))).not.toThrow();
      expect(isChatProtocolReady(e.protocol, e.catalogReady)).toBe(true);
    }
  });

  it('keeps Ollama Cloud on OpenAI-compat /v1', () => {
    expect(PROVIDER_CATALOG.find((e) => e.id === 'ollama')?.baseUrl).toBe(
      'https://ollama.com/v1'
    );
  });

  it('renames glm-cn label without changing id', () => {
    const row = PROVIDER_CATALOG.find((e) => e.id === 'glm-cn');
    expect(row?.id).toBe('glm-cn');
    expect(row?.label).toBe('BigModel.cn');
  });

  it('dedupes Gemini and Cloudflare Ready cards', () => {
    const google = PROVIDER_CATALOG.find((e) => e.id === 'google');
    const gemini = PROVIDER_CATALOG.find((e) => e.id === 'gemini');
    const cf = PROVIDER_CATALOG.find((e) => e.id === 'cloudflare');
    const cfAi = PROVIDER_CATALOG.find((e) => e.id === 'cloudflare-ai');

    expect(google).toBeTruthy();
    expect(gemini).toBeTruthy();
    expect(cf).toBeTruthy();
    expect(cfAi).toBeTruthy();

    expect(google!.catalogReady).toBe(false);
    expect(gemini!.catalogReady).toBe(true);
    expect(cf!.catalogReady).toBe(true);
    expect(cfAi!.catalogReady).toBe(false);
  });
});
