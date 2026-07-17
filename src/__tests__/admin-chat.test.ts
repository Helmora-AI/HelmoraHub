import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request, { TEST_SETUP_TOKEN } from './test-request.js';
import { loadConfig, setActiveConfig } from '../lib/config.js';
import { initStorage, closeStorage, getConfigStore } from '../storage/index.js';
import { createApp } from '../app.js';
import type { Express } from 'express';
import { normalizeMiniRoleConfig, setMiniRoleConfig } from '../services/mini-route.js';
import { adminChatStatusForUpstreamFailure } from '../routes/chat.js';
import {
  DEFAULT_TOOL_RUNTIME_CONFIG,
  getToolRuntimeConfig,
  setToolRuntimeConfig,
} from '../services/tool-config.js';

let app: Express;
let tmpDir: string;
let spaToken: string;
let adminToken: string;
let v1Key: string;
let catalogId: string;
let codingCatalogId: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-chat-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-chat';
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  delete process.env.HELMORA_API_KEY;
  delete process.env.HELMORA_ADMIN_PASSWORD;
  delete process.env.HELMORA_ADMIN_TOKEN;
  delete process.env.CTRLHUB_ADMIN_PASSWORD;
  delete process.env.CTRLHUB_ADMIN_TOKEN;
  process.env.HELMORA_SETUP_TOKEN = TEST_SETUP_TOKEN;

  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.encryptionKey = 'test-encryption-key-chat';
  setActiveConfig(config);
  await initStorage(config);
  app = createApp(config);

  const setup = await request(app)
    .post('/api/auth/setup')
    .send({ password: 'chat-admin-password', setupToken: TEST_SETUP_TOKEN });
  expect(setup.status).toBe(200);
  expect(setup.body.token).toMatch(/^helmora_session_/);
  spaToken = setup.body.token;
  adminToken = setup.body.adminToken;
  v1Key = await getConfigStore().getUnifiedApiKey();

  // Mark paid-upstream verified so catalog models can be routable when enabled
  const store = getConfigStore();
  await store.updateProvider('paid-upstream', {
    enabled: true,
    verifyStatus: 'ok',
  });
  const created = await store.createHubModel({
    providerId: 'paid-upstream',
    modelId: 'demo/chat-test',
    displayName: 'Chat Test Model',
  });
  catalogId = created.id;
  const coding = await store.createHubModel({
    providerId: 'paid-upstream',
    modelId: 'demo/chat-coding',
    displayName: 'Chat Coding Model',
  });
  codingCatalogId = coding.id;
  const miniConfig = normalizeMiniRoleConfig({
    version: 2,
    enabled: true,
    roles: {
      general: { primaryCatalogId: catalogId, fallbackCatalogId: null },
      coding: { primaryCatalogId: codingCatalogId, fallbackCatalogId: null },
    },
  });
  await setMiniRoleConfig(miniConfig);
});

afterAll(async () => {
  await closeStorage();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('POST /api/chat/completions', () => {
  it('does not expose provider credential failures as admin-auth 401 responses', () => {
    expect(adminChatStatusForUpstreamFailure(401)).toBe(502);
    expect(adminChatStatusForUpstreamFailure(403)).toBe(502);
    expect(adminChatStatusForUpstreamFailure(429)).toBe(429);
    expect(adminChatStatusForUpstreamFailure(503)).toBe(503);
  });

  it('rejects an invalid Helmora tool policy before model resolution', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .set('X-Helmora-Tools', 'enabled')
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_tools_policy');
  });

  it('reports a forced but disabled tool runtime before resolving the chat model', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .set('X-Helmora-Tools', 'force')
      .send({
        model: 'catalog/missing-model',
        messages: [{ role: 'user', content: 'Use tools for the current gold price.' }],
        stream: false,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('runtime_disabled');
    expect(res.body.error.message).toContain('Settings > Tools');
  });

  it('uses the same forced-runtime preflight on the public API', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${v1Key}`)
      .set('X-Helmora-Tools', 'force')
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'Use tools for the current gold price.' }],
        stream: false,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('runtime_disabled');
    expect(res.body.error.message).toContain('Settings > Tools');
  });

  it('rejects /v1 consumer key', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${v1Key}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
    expect(res.status).toBe(401);
  });

  it('rejects long-lived admin token', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
    expect(res.status).toBe(401);
  });

  it('streams with SPA session + metadata event', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello stream' }],
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'] || '')).toContain('text/event-stream');
    const text =
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(text).toContain('event: metadata');
    expect(text).toContain('requestId');
    expect(text).toContain('[DONE]');
  });

  it('non-stream JSON with auto', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello json' }],
        stream: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.choices?.[0]?.message?.content).toBeTruthy();
    expect(res.body.model).toBe('helmora-mini-1.0');
    expect(res.headers['x-helmora-mini-role']).toBe('general');
    expect(res.headers['x-helmora-mini-slot']).toBe('primary');
  });

  it('classifies coding prompts and dispatches the coding catalog model', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'helmora-mini-1.0',
        messages: [{ role: 'user', content: 'Implement and debug this TypeScript function.' }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('helmora-mini-1.0');
    expect(res.headers['x-helmora-mini-role']).toBe('coding');
    expect(res.headers['x-helmora-mini-slot']).toBe('primary');
  });

  it('resolves catalog model ref', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: `catalog/${catalogId}`,
        messages: [{ role: 'user', content: 'catalog hi' }],
        stream: false,
      });
    expect(res.status).toBe(200);
  });

  it('rejects bare upstream model id', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'demo/chat-test',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.type).toBe('invalid_model_ref');
  });

  it('records admin_chat usage with null apiKeyId', async () => {
    await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'usage check' }],
        stream: false,
      });

    const events = await getConfigStore().listUsage({ limit: 20 });
    const admin = events.find(
      (e) => e.source === 'admin_chat' && e.miniRole === 'general'
    );
    expect(admin).toBeTruthy();
    expect(admin!.apiKeyId).toBeNull();
    expect(admin!.requestId).toMatch(/^req_/);
    expect(typeof admin!.costMicrosUsd).toBe('number');
    expect(admin!.miniSlot).toBe('primary');
    expect(admin!.miniCatalogId).toBe(catalogId);
  });

  it('records catalog usage under upstream model id', async () => {
    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .send({
        model: `catalog/${catalogId}`,
        messages: [{ role: 'user', content: 'label check' }],
        stream: false,
      });
    expect(res.status).toBe(200);

    const events = await getConfigStore().listUsage({ limit: 20 });
    const hit = events.find(
      (e) => e.source === 'admin_chat' && e.model === 'demo/chat-test'
    );
    expect(hit).toBeTruthy();
    expect(hit!.model).not.toMatch(/^catalog\//);
  });

  it('executes TinyFish through the native tool loop for the default Vietnamese auto request', async () => {
    const toolConfig = structuredClone(DEFAULT_TOOL_RUNTIME_CONFIG);
    toolConfig.enabled = true;
    toolConfig.connectors.tinyfish.enabled = true;
    await setToolRuntimeConfig(toolConfig);
    await getConfigStore().updateConnectorCredential('tinyfish', { secret: 'tinyfish-test-key' });
    await getConfigStore().updateProvider('paid-upstream', {
      baseUrl: 'https://model.test/v1',
      apiKey: 'model-test-key',
      capabilities: ['tools'],
      verifyStatus: 'ok',
    });

    let modelRounds = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.search.tinyfish.ai') {
        expect(url.searchParams.get('query')).toBe('giá vàng hôm nay');
        return new Response(JSON.stringify({
          query: 'giá vàng hôm nay',
          results: [{
            title: 'Giá vàng',
            snippet: 'Giá vàng cập nhật hôm nay',
            url: 'https://example.com/gold',
          }],
        }));
      }
      expect(url.href).toBe('https://model.test/v1/chat/completions');
      const upstream = JSON.parse(String(init?.body)) as {
        tools?: unknown[];
        messages: Array<{ role: string }>;
      };
      modelRounds += 1;
      expect(upstream.tools).toHaveLength(2);
      if (!upstream.messages.some((message) => message.role === 'tool')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_gold',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query: 'giá vàng hôm nay' }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 8, completion_tokens: 3 },
        }));
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: 'Giá vàng hôm nay đã được tra cứu.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }));
    });

    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .set('X-Helmora-Tools', 'auto')
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'Hãy dùng tools để tra giá vàng hôm nay' }],
        stream: false,
      });
    fetchMock.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toContain('đã được tra cứu');
    expect(modelRounds).toBe(2);
    expect(await getConfigStore().listToolRuns({ limit: 10 })).toContainEqual(
      expect.objectContaining({
        requestId: expect.stringMatching(/^req_/),
        source: 'runtime',
        toolId: 'web_search',
        status: 'completed',
        sourceCount: 1,
      }),
    );
    const usage = await getConfigStore().listUsage({ limit: 20 });
    expect(usage).toEqual(expect.arrayContaining([
      expect.objectContaining({ usagePhase: 'tool_planner', toolRound: 0 }),
      expect.objectContaining({ usagePhase: 'tool_synthesis', toolRound: 1 }),
    ]));
  });

  it('uses the configured catalog orchestrator for every round and audits its catalog id', async () => {
    const toolConfig = await getToolRuntimeConfig();
    toolConfig.orchestrator.primaryCatalogId = catalogId;
    await setToolRuntimeConfig(toolConfig);

    const models: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.search.tinyfish.ai') {
        return new Response(JSON.stringify({
          query: 'gold today',
          results: [{ title: 'Gold', snippet: 'Updated', url: 'https://example.com/gold' }],
        }));
      }
      const upstream = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content?: string }>;
      };
      models.push(upstream.model);
      if (upstream.model === 'demo/chat-coding') {
        expect(upstream.messages.some((message) => (
          message.role === 'system' && message.content?.includes('untrusted external tool output')
        ))).toBe(true);
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Answer model synthesis.' } }],
        }));
      }
      return new Response(JSON.stringify(upstream.messages.some((message) => message.role === 'tool')
        ? { choices: [{ message: { role: 'assistant', content: 'Planner complete.' } }] }
        : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
            id: 'call_orchestrated',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"gold today"}' },
          }] } }] }));
    });

    try {
      const res = await request(app)
        .post('/api/chat/completions')
        .set('Authorization', `Bearer ${spaToken}`)
        .set('X-Helmora-Tools', 'force')
        .send({
          model: `catalog/${codingCatalogId}`,
          messages: [{ role: 'user', content: 'Use tools for the current gold price.' }],
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('Answer model synthesis.');
      expect(models).toEqual(['demo/chat-test', 'demo/chat-test', 'demo/chat-coding']);
      expect(await getConfigStore().listToolRuns({ limit: 10 })).toContainEqual(
        expect.objectContaining({ plannerCatalogId: catalogId, status: 'completed' }),
      );
    } finally {
      fetchMock.mockRestore();
      toolConfig.orchestrator.primaryCatalogId = null;
      await setToolRuntimeConfig(toolConfig);
    }
  });

  it('keeps the Playground SSE contract and emits redacted tool activity', async () => {
    let modelRounds = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.search.tinyfish.ai') {
        return new Response(JSON.stringify({
          query: 'giá vàng hôm nay',
          results: [{ title: 'Gold', snippet: 'Current', url: 'https://example.com/gold' }],
        }));
      }
      const upstream = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      modelRounds += 1;
      return new Response(JSON.stringify(upstream.messages.some((message) => message.role === 'tool')
        ? {
            choices: [{ message: { role: 'assistant', content: 'Kết quả SSE từ TinyFish.' } }],
            usage: { prompt_tokens: 20, completion_tokens: 6 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
              id: 'call_stream',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"giá vàng hôm nay"}' },
            }] } }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          }));
    });

    const res = await request(app)
      .post('/api/chat/completions')
      .set('Authorization', `Bearer ${spaToken}`)
      .set('X-Helmora-Tools', 'force')
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'Tra giá vàng hôm nay' }],
        stream: true,
      });
    fetchMock.mockRestore();

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    const responseText = typeof res.text === 'string'
      ? res.text
      : Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
    expect(responseText).toContain('event: tool_activity');
    expect(responseText).toContain('"toolId":"web_search"');
    expect(responseText).toContain('Kết quả SSE từ TinyFish.');
    expect(responseText).toContain('[DONE]');
    expect(responseText).not.toContain('giá vàng hôm nay');
    expect(modelRounds).toBe(2);
  });

  it('uses the same TinyFish runtime contract on /v1 without exposing tool arguments', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.search.tinyfish.ai') {
        return new Response(JSON.stringify({
          query: 'current gold price',
          results: [{ title: 'Gold', snippet: 'Updated', url: 'https://example.com/gold' }],
        }));
      }
      const upstream = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
      return new Response(JSON.stringify(upstream.messages.some((message) => message.role === 'tool')
        ? {
            choices: [{ message: { role: 'assistant', content: 'Public API tool answer.' } }],
            usage: { prompt_tokens: 18, completion_tokens: 5 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
              id: 'call_v1',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"current gold price"}' },
            }] } }],
            usage: { prompt_tokens: 6, completion_tokens: 2 },
          }));
    });

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${v1Key}`)
      .set('X-Helmora-Tools', 'force')
      .send({
        model: 'auto',
        messages: [{ role: 'user', content: 'Tra giá vàng hôm nay' }],
        stream: false,
      });
    fetchMock.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Public API tool answer.');
    const apiUsage = (await getConfigStore().listUsage({ limit: 30 }))
      .filter((event) => event.source === 'api');
    expect(apiUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({ usagePhase: 'tool_planner', parentRequestId: expect.any(String) }),
      expect.objectContaining({ usagePhase: 'tool_synthesis', parentRequestId: expect.any(String) }),
    ]));
  });

  it('keeps the configured orchestrator separate from the /v1 answer model', async () => {
    const toolConfig = await getToolRuntimeConfig();
    toolConfig.orchestrator.primaryCatalogId = codingCatalogId;
    await setToolRuntimeConfig(toolConfig);

    const models: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.search.tinyfish.ai') {
        return new Response(JSON.stringify({
          query: 'current gold price',
          results: [{ title: 'Gold', snippet: 'Updated', url: 'https://example.com/gold' }],
        }));
      }
      const upstream = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ role: string; content?: string }>;
      };
      models.push(upstream.model);
      if (upstream.model === 'demo/chat-test') {
        expect(upstream.messages.some((message) => (
          message.role === 'system' && message.content?.includes('untrusted external tool output')
        ))).toBe(true);
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Public answer-model synthesis.' } }],
          usage: { prompt_tokens: 24, completion_tokens: 5 },
        }));
      }
      return new Response(JSON.stringify(upstream.messages.some((message) => message.role === 'tool')
        ? {
            choices: [{ message: { role: 'assistant', content: 'Planner complete.' } }],
            usage: { prompt_tokens: 18, completion_tokens: 2 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
              id: 'call_v1_orchestrated',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"current gold price"}' },
            }] } }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          }));
    });

    try {
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${v1Key}`)
        .set('X-Helmora-Tools', 'force')
        .send({
          model: 'auto',
          messages: [{ role: 'user', content: 'Use tools for the current gold price.' }],
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('Public answer-model synthesis.');
      expect(models).toEqual(['demo/chat-coding', 'demo/chat-coding', 'demo/chat-test']);
    } finally {
      fetchMock.mockRestore();
      toolConfig.orchestrator.primaryCatalogId = null;
      await setToolRuntimeConfig(toolConfig);
    }
  });
});
