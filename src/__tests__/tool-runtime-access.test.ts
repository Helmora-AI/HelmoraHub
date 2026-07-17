import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyRecord } from '../keys/types.js';
import { requireApiKeyToolRuntimeAccess } from '../services/chat-tool-execution.js';

function key(patch: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key_1',
    name: 'Runtime key',
    keyEnv: 'dev',
    keyPrefix: 'hel_dev_',
    keyHash: 'hash',
    keyHint: 'hel_dev_…test',
    budgetUsd: 1,
    spentUsd: 0,
    expiresAt: null,
    enabled: true,
    createdAt: 1,
    lastUsedAt: null,
    ...patch,
  };
}

describe('tool runtime API-key access', () => {
  it('returns the fresh active key', async () => {
    const fresh = key();
    const store = { getApiKeyById: vi.fn(async () => fresh) };

    await expect(requireApiKeyToolRuntimeAccess(store, fresh.id)).resolves.toBe(fresh);
  });

  it.each([
    [null, 'invalid_api_key', 401],
    [key({ enabled: false }), 'invalid_api_key', 401],
    [key({ expiresAt: 1 }), 'api_key_expired', 401],
    [key({ budgetUsd: 0.5, spentUsd: 0.5 }), 'insufficient_quota', 429],
  ] as const)('rejects stale access state %#', async (fresh, code, status) => {
    const store = { getApiKeyById: vi.fn(async () => fresh) };

    await expect(requireApiKeyToolRuntimeAccess(store, 'key_1')).rejects.toMatchObject({
      code,
      status,
    });
  });
});
