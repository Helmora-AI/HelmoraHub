/**
 * In-process Hub Verify enqueue.
 * Callback enqueues at most once per provider; processor runs async (setImmediate/microtask).
 * SPA refetch must not call verify — only Hub enqueue + explicit Retry.
 */

export type OAuthVerifyProcessor = (providerId: string) => Promise<void> | void;

const pending = new Set<string>();
const queue: string[] = [];
let processCalls = 0;
let processor: OAuthVerifyProcessor | null = null;
let drainScheduled = false;

/** Injected from app bootstrap / oauth routes (ConfigStore + handler.verify). */
export function setOAuthVerifyProcessor(fn: OAuthVerifyProcessor | null): void {
  processor = fn;
}

export function getOAuthVerifyProcessor(): OAuthVerifyProcessor | null {
  return processor;
}

/** Enqueue at most one outstanding verify job per providerId; schedule drain. */
export function enqueueOAuthVerify(providerId: string): boolean {
  if (pending.has(providerId)) return false;
  pending.add(providerId);
  queue.push(providerId);
  scheduleDrain();
  return true;
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  const run = () => {
    drainScheduled = false;
    void processOAuthVerifyJobs();
  };
  if (typeof setImmediate === 'function') {
    setImmediate(run);
  } else {
    queueMicrotask(run);
  }
}

/**
 * Drain the queue. Invokes the injected processor (or override) per job.
 * Returns provider ids that were processed.
 */
export async function processOAuthVerifyJobs(
  overrideProcessor?: OAuthVerifyProcessor
): Promise<string[]> {
  processCalls += 1;
  const jobs = queue.splice(0, queue.length);
  const fn = overrideProcessor ?? processor;
  for (const id of jobs) {
    pending.delete(id);
    if (!fn) continue;
    try {
      await fn(id);
    } catch {
      // fail-open — leave oauth_state as set by caller (usually verification_pending)
    }
  }
  return jobs;
}

export function getOAuthVerifyQueueSnapshot(): {
  pending: string[];
  queued: string[];
  processCalls: number;
} {
  return {
    pending: [...pending],
    queued: [...queue],
    processCalls,
  };
}

export function clearOAuthVerifyQueue(): void {
  pending.clear();
  queue.length = 0;
  processCalls = 0;
  drainScheduled = false;
}
