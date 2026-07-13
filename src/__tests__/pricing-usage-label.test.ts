import { describe, it, expect } from 'vitest';
import {
  billingModelId,
  costForModel,
  getPricingForModel,
  usageModelLabel,
} from '../pricing/cost.js';

describe('usage labels + open-weight pricing', () => {
  it('usageModelLabel prefers routed upstream id over catalog ref', () => {
    expect(
      usageModelLabel({
        requestedModel: 'catalog/mdl_abc',
        routedModel: 'gemma3:27b',
      })
    ).toBe('gemma3:27b');
  });

  it('billingModelId prefers routed model over provider default', () => {
    expect(
      billingModelId({
        requestedModel: 'catalog/mdl_abc',
        routedModel: 'gemma3:27b',
        defaultModel: 'some-other',
      })
    ).toBe('gemma3:27b');
  });

  it('estimates gemma/ollama-style tags via pattern pricing', () => {
    const p = getPricingForModel('gemma3:27b', 'ollama');
    expect(p?.input).toBe(0.1);
    expect(p?.output).toBe(0.4);
    const cost = costForModel(
      'gemma3:27b',
      { prompt_tokens: 1_000_000, completion_tokens: 0 },
      'ollama'
    );
    expect(cost).toBeCloseTo(0.1, 5);
  });
});

/** Default / typical model ids from chat-ready providers that previously priced as $0. */
describe('cross-provider default model pricing', () => {
  const TOKENS = { prompt_tokens: 1_000_000, completion_tokens: 0 };

  const cases: Array<{
    provider: string;
    model: string;
    expectInput: number;
    note?: string;
  }> = [
    { provider: 'ollama', model: 'gemma3:27b', expectInput: 0.1 },
    { provider: 'ollama', model: 'gpt-oss:120b', expectInput: 0.5 },
    { provider: 'cerebras', model: 'gpt-oss-120b', expectInput: 0.5 },
    { provider: 'ovh', model: 'gpt-oss-120b', expectInput: 0.5 },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', expectInput: 0.2 },
    { provider: 'mistral', model: 'mistral-large-latest', expectInput: 0.15 },
    { provider: 'llm7', model: 'codestral-latest', expectInput: 0.3 },
    { provider: 'cohere', model: 'command-r-plus-08-2024', expectInput: 0.5 },
    {
      provider: 'cloudflare',
      model: '@cf/meta/llama-3.1-70b-instruct',
      expectInput: 0.2,
    },
    { provider: 'zhipu', model: 'glm-4.5-flash', expectInput: 0.75 },
    { provider: 'glm-cn', model: 'glm-5.2', expectInput: 1.0 },
    { provider: 'deepseek', model: 'deepseek-v4-pro', expectInput: 0.435 },
    { provider: 'gemini', model: 'gemini-2.5-flash', expectInput: 0.3 },
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514', expectInput: 3.0 },
    { provider: 'openai', model: 'gpt-4o-mini', expectInput: 0.15 },
    { provider: 'xai', model: 'grok-4', expectInput: 0.5 },
    { provider: 'perplexity', model: 'sonar-pro', expectInput: 3.0 },
    { provider: 'reka', model: 'reka-flash-3', expectInput: 0.5 },
    { provider: 'venice', model: 'venice-uncensored-1-2', expectInput: 0.5 },
    { provider: 'kiraai', model: 'kira-3.5-pro', expectInput: 1.0 },
    { provider: 'xiaomi-mimo', model: 'mimo-v2.5-pro', expectInput: 0.5 },
    { provider: 'byteplus', model: 'seed-2-0-pro-260328', expectInput: 0.5 },
    { provider: 'volcengine-ark', model: 'Doubao-Seed-2.0-Code', expectInput: 0.5 },
    { provider: 'hyperbolic', model: 'Qwen/QwQ-32B', expectInput: 0.5 },
    { provider: 'nvidia', model: 'minimaxai/minimax-m2.7', expectInput: 0.5 },
    {
      provider: 'kilo',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      expectInput: 0.5,
      note: ':free still estimates at market rate for base id',
    },
    {
      provider: 'subscription-demo',
      model: 'demo/subscription',
      expectInput: 0,
    },
    { provider: 'pollinations', model: 'openai-fast', expectInput: 0.15 },
    { provider: 'opencode', model: 'big-pickle', expectInput: 0.5 },
    {
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      expectInput: 0.435,
    },
    {
      provider: 'nebius',
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      expectInput: 0.2,
    },
  ];

  for (const c of cases) {
    it(`${c.provider} · ${c.model}${c.note ? ` (${c.note})` : ''}`, () => {
      const p = getPricingForModel(c.model, c.provider);
      expect(p, `missing pricing for ${c.provider}/${c.model}`).toBeTruthy();
      expect(p!.input).toBeCloseTo(c.expectInput, 5);
      const cost = costForModel(c.model, TOKENS, c.provider);
      expect(cost).toBeCloseTo(c.expectInput, 5);
    });
  }

  it('auto:free does not use auto placeholder rate', () => {
    const p = getPricingForModel('auto:free', 'bazaarlink');
    // No market base id — estimate stays unset / zero cost
    expect(p).toBeNull();
    expect(costForModel('auto:free', TOKENS, 'bazaarlink')).toBe(0);
  });
});
