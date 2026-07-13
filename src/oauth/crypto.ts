import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:oauth:v1:';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** AAD binding: providerId + credential type + schema version. */
export function oauthBundleAad(providerId: string, schemaVersion: number): Buffer {
  return Buffer.from(`oauth|${providerId}|${schemaVersion}`, 'utf8');
}

export function encryptOAuthPayload(
  plaintext: string,
  encryptionKey: string,
  aad: Buffer
): string {
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required to store OAuth secrets');
  }
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptOAuthPayload(
  payload: string,
  encryptionKey: string,
  aad: Buffer
): string {
  if (!payload.startsWith(PREFIX)) {
    throw new Error('Invalid OAuth encrypted payload');
  }
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required to decrypt OAuth secrets');
  }
  const body = payload.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid OAuth encrypted payload');
  }
  const key = deriveKey(encryptionKey);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
