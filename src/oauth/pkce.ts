import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 7636 code_verifier: 43–128 chars from unreserved set. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

export function verifyPkceChallenge(verifier: string, challenge: string): boolean {
  const expected = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(challenge);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}
