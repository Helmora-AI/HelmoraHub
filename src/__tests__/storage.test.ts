import { describe, it, expect } from 'vitest';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../lib/crypto.js';
import { MemoryRateStore } from '../storage/rate-store.js';

describe('crypto', () => {
  it('round-trips AES-GCM secrets', () => {
    const key = 'unit-test-master-key';
    const sealed = encryptSecret('sk-live-abc123', key);
    expect(isEncryptedSecret(sealed)).toBe(true);
    expect(decryptSecret(sealed, key)).toBe('sk-live-abc123');
  });

  it('rejects wrong master key', () => {
    const sealed = encryptSecret('secret', 'key-a');
    expect(() => decryptSecret(sealed, 'key-b')).toThrow();
  });

  it('passes through legacy plaintext', () => {
    expect(decryptSecret('plain-key', 'any')).toBe('plain-key');
  });
});

describe('MemoryRateStore', () => {
  it('cooldowns expire', async () => {
    const store = new MemoryRateStore();
    await store.setCooldown('p1', 1);
    expect(await store.isCoolingDown('p1')).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await store.isCoolingDown('p1')).toBe(false);
    await store.close();
  });

  it('increments rpm and sticky sessions', async () => {
    const store = new MemoryRateStore();
    expect(await store.incrRpm('p1')).toBe(1);
    expect(await store.incrRpm('p1')).toBe(2);
    await store.setSticky('sess', 'p1', 60);
    expect(await store.getSticky('sess')).toBe('p1');
    await store.close();
  });
});
