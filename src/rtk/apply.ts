/**
 * RTK (Tier 1) — tool-output compression before upstream dispatch.
 * Ported from 9Router open-sse/rtk (fail-open).
 */
import { compressMessages } from './index.js';
import { helEnvTruthy } from '../lib/hel-env.js';
import { MODE_PROFILES, type HubMode } from '../types.js';

export type RtkHit = { shape: string; filter: string; saved: number };

export type RtkStats = {
  bytesBefore: number;
  bytesAfter: number;
  hits: RtkHit[];
  savedBytes: number;
  enabled: boolean;
};

export function isRtkEnabledForMode(mode: HubMode): boolean {
  const truthy = helEnvTruthy('RTK');
  if (truthy === false) return false;
  if (truthy === true) return true;
  return Boolean(MODE_PROFILES[mode]?.rtk);
}

/**
 * Clone request body, compress tool outputs in-place on the clone.
 * Returns compressed body + stats (or original + null stats if disabled/no-op).
 */
export function applyRtk<T extends { messages?: unknown; input?: unknown }>(
  body: T,
  enabled: boolean
): { body: T; stats: RtkStats | null } {
  if (!enabled) {
    return { body, stats: null };
  }

  let clone: T;
  try {
    clone = JSON.parse(JSON.stringify(body)) as T;
  } catch {
    return { body, stats: null };
  }

  try {
    const raw = compressMessages(clone, true) as {
      bytesBefore: number;
      bytesAfter: number;
      hits: RtkHit[];
    } | null;

    if (!raw) {
      return { body: clone, stats: null };
    }

    const savedBytes = Math.max(0, raw.bytesBefore - raw.bytesAfter);
    return {
      body: clone,
      stats: {
        bytesBefore: raw.bytesBefore,
        bytesAfter: raw.bytesAfter,
        hits: raw.hits ?? [],
        savedBytes,
        enabled: true,
      },
    };
  } catch (err) {
    console.warn('[rtk] compress failed — passthrough:', err);
    return { body, stats: null };
  }
}

export function setRtkHeaders(
  res: { setHeader: (k: string, v: string) => void },
  stats: RtkStats | null,
  headersAlreadySent?: boolean
): void {
  if (!stats || headersAlreadySent) return;
  res.setHeader('X-Ctrl-Rtk', '1');
  res.setHeader('X-Ctrl-Rtk-Saved', String(stats.savedBytes));
  res.setHeader('X-Ctrl-Rtk-Hits', String(stats.hits.length));
  res.setHeader('X-Ctrl-Rtk-Before', String(stats.bytesBefore));
  res.setHeader('X-Ctrl-Rtk-After', String(stats.bytesAfter));
}
