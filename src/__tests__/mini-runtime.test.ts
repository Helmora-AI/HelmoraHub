import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { closeStorage, initStorage } from '../storage/index.js';
import type { ProviderToggle } from '../types.js';
import type { MiniCatalogAttempt } from '../services/mini-route.js';

const dispatch = vi.hoisted(() => ({
  chat: vi.fn(),
  stream: vi.fn(),
}));

vi.mock('../providers/dispatch.js', () => ({
  dispatchChat: dispatch.chat,
  dispatchChatStream: dispatch.stream,
}));

import { routeMiniChat, routeMiniChatStream } from '../services/tier-router.js';

let tmpDir: string;

function provider(id: string): ProviderToggle {
  return {
    id,
    label: id,
    enabled: true,
    tier: 2,
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    defaultModel: null,
    allowedModes: ['smart'],
    capabilities: ['streaming'],
    protocol: 'openai',
    authStyle: 'bearer',
    benchmarkModel: null,
    pinnedModels: [],
    verifyStatus: 'ok',
    verifyError: null,
    verifiedAt: 1,
    source: 'test',
    catalogReady: true,
    extraHeaders: null,
    timeoutMs: null,
    authMode: 'api_key',
    oauthState: 'none',
  };
}

function attempts(prefix: string): MiniCatalogAttempt[] {
  return [
    {
      role: 'coding',
      slot: 'primary',
      catalogId: `${prefix}-primary`,
      provider: provider(`${prefix}-provider-primary`),
      modelId: `${prefix}-model-primary`,
      inheritedFromGeneral: false,
    },
    {
      role: 'coding',
      slot: 'fallback',
      catalogId: `${prefix}-fallback`,
      provider: provider(`${prefix}-provider-fallback`),
      modelId: `${prefix}-model-fallback`,
      inheritedFromGeneral: false,
    },
  ];
}

function visibleStream(model: string) {
  return {
    ok: true as const,
    providerId: model,
    model,
    chunks: (async function* () {
      yield { choices: [{ delta: { content: 'visible' } }] };
    })(),
    getAssembledContent: () => 'visible',
    getUsage: () => null,
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-mini-runtime-'));
  process.env.DATA_DIR = tmpDir;
  process.env.STORAGE_BACKEND = 'local';
  process.env.RATE_BACKEND = 'memory';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-mini-runtime';
  const config = loadConfig();
  config.dataDir = tmpDir;
  config.dbPath = path.join(tmpDir, 'helmora.db');
  config.storageChoice = 'local';
  config.storageBackend = 'sqlite';
  config.rateBackend = 'memory';
  await initStorage(config);
});

afterAll(async () => {
  await closeStorage();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  dispatch.chat.mockReset();
  dispatch.stream.mockReset();
});

describe('Mini exact runtime attempts', () => {
  it('advances from a retryable primary failure to the configured fallback', async () => {
    dispatch.chat
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        providerId: 'primary',
        model: 'primary',
        body: null,
        error: 'rate limited',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        providerId: 'fallback',
        model: 'fallback',
        body: { choices: [] },
      });

    const result = await routeMiniChat(
      { messages: [{ role: 'user', content: 'implement this' }] },
      attempts('retryable'),
      {
        mode: 'smart',
        identity: {
          enabled: true,
          surface: 'api',
          requestedModelRef: 'auto',
          meta: true,
          displayName: 'Helmora Mini 1.0',
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(result.selectedAttempt?.slot).toBe('fallback');
    expect(dispatch.chat).toHaveBeenCalledTimes(2);
    for (const call of dispatch.chat.mock.calls) {
      const request = call[1] as { messages: Array<{ role: string; content: unknown }> };
      const identities = request.messages.filter(
          (message) => message.role === 'system'
          && typeof message.content === 'string'
          && message.content.includes('Helmora Mini 1.0')
      );
      expect(identities).toHaveLength(1);
    }
  });

  it('stops on a deterministic client failure', async () => {
    dispatch.chat.mockResolvedValueOnce({
      ok: false,
      status: 400,
      providerId: 'primary',
      model: 'primary',
      body: null,
      error: 'invalid request body',
    });

    const result = await routeMiniChat(
      { messages: [{ role: 'user', content: 'implement this' }] },
      attempts('nonretryable'),
      { mode: 'smart' }
    );

    expect(result.ok).toBe(false);
    expect(dispatch.chat).toHaveBeenCalledTimes(1);
  });

  it('falls back when a stream fails before its first visible delta', async () => {
    dispatch.stream
      .mockResolvedValueOnce({
        ...visibleStream('primary'),
        chunks: (async function* () {
          yield { choices: [{ delta: { reasoning: 'internal' } }] };
          throw new Error('network disconnected');
        })(),
      })
      .mockResolvedValueOnce(visibleStream('fallback'));

    const result = await routeMiniChatStream(
      { messages: [{ role: 'user', content: 'implement this' }] },
      attempts('precommit'),
      { mode: 'smart' }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected stream success');
    expect(result.selectedAttempt.slot).toBe('fallback');
    expect(dispatch.stream).toHaveBeenCalledTimes(2);
    const chunks = [];
    for await (const chunk of result.stream.chunks) chunks.push(chunk);
    expect(chunks).toEqual([{ choices: [{ delta: { content: 'visible' } }] }]);
  });

  it('never changes models after a visible stream delta', async () => {
    dispatch.stream.mockResolvedValueOnce({
      ...visibleStream('primary'),
      chunks: (async function* () {
        yield { choices: [{ delta: { content: 'committed' } }] };
        throw new Error('late stream failure');
      })(),
    });

    const result = await routeMiniChatStream(
      { messages: [{ role: 'user', content: 'implement this' }] },
      attempts('postcommit'),
      { mode: 'smart' }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected committed stream');
    expect(result.selectedAttempt.slot).toBe('primary');
    await expect(async () => {
      for await (const _chunk of result.stream.chunks) {
        // consume until the simulated late failure
      }
    }).rejects.toThrow('late stream failure');
    expect(dispatch.stream).toHaveBeenCalledTimes(1);
  });
});
