import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** AES-256-GCM. Output: enc:v1:<iv_b64>:<tag_b64>:<cipher_b64> */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  if (!plaintext) return plaintext;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required to store provider secrets');
  }
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(payload: string | null | undefined, encryptionKey: string): string | null {
  if (payload == null || payload === '') return null;
  if (!payload.startsWith(PREFIX)) {
    // Legacy plaintext (local Phase 1) — return as-is until rewritten
    return payload;
  }
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required to decrypt provider secrets');
  }
  const body = payload.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted secret payload');
  }
  const key = deriveKey(encryptionKey);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(PREFIX));
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 12) return '***';
  return `${value.slice(0, 10)}…${value.slice(-4)}`;
}
