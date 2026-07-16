import { createHash, timingSafeEqual } from 'node:crypto';

const WINDOW_MS = 15 * 60_000;
const SOURCE_MAX = 10;
const PROCESS_MAX = 100;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function verifySetupToken(
  configured: string,
  submitted: string | undefined
): boolean {
  const configuredDigest = digest(configured);
  const submittedDigest = digest(submitted ?? '');
  return timingSafeEqual(configuredDigest, submittedDigest);
}

type LimitRow = { count: number; resetAt: number };

export type SetupLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export class SetupAttemptLimiter {
  private process: LimitRow | null = null;
  private readonly sources = new Map<string, LimitRow>();

  consume(source: string, now = Date.now()): SetupLimitResult {
    if (!this.process || now >= this.process.resetAt) {
      this.process = { count: 0, resetAt: now + WINDOW_MS };
    }
    let sourceRow = this.sources.get(source);
    if (!sourceRow || now >= sourceRow.resetAt) {
      sourceRow = { count: 0, resetAt: now + WINDOW_MS };
      this.sources.set(source, sourceRow);
    }

    this.process.count += 1;
    sourceRow.count += 1;

    const resets: number[] = [];
    if (this.process.count > PROCESS_MAX) resets.push(this.process.resetAt);
    if (sourceRow.count > SOURCE_MAX) resets.push(sourceRow.resetAt);
    if (resets.length === 0) return { allowed: true };

    const retryAt = Math.max(...resets);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
    };
  }

  clear(): void {
    this.process = null;
    this.sources.clear();
  }
}

export const setupAttemptLimiter = new SetupAttemptLimiter();
