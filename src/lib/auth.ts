import { randomBytes, timingSafeEqual } from 'node:crypto';

export { generateApiKey, generateClientApiKey, hashApiKey } from '../keys/generate.js';

export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
