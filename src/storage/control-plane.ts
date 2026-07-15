/** Pure control-plane state machine + outbox helpers (no I/O). */

import type { SupabaseControlFailureCode } from '../lib/supabase-schema.js';

export const CONTROL_PROBE_INTERVAL_MS = 15_000;
export const CONTROL_FAILURES_TO_DEGRADED = 2;

export type ControlPlaneState =
  | 'recovery_only'
  | 'probing'
  | 'online'
  | 'degraded'
  | 'reconciling';
export type ControlVaultHealth = 'fresh' | 'stale' | 'replaying';

export type ControlOutboxEntity =
  | 'api_key'
  | 'provider'
  | 'agent'
  | 'setting'
  | 'connector_credential';
export type ControlOutboxAction = 'add' | 'modify' | 'delete';

export type ControlOutboxOp = {
  opId: string;
  entity: ControlOutboxEntity;
  action: ControlOutboxAction;
  entityId: string;
  /** Opaque JSON-serializable payload; may hold ciphertext — never log. */
  payload: Record<string, unknown>;
  createdAt: number;
  appliedAt: number | null;
};

export type ControlPlaneSnapshot = {
  state: ControlPlaneState;
  vault: ControlVaultHealth;
  failureCount: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastProbeAt: number | null;
  snapshotAvailable: boolean;
  degradedReason: SupabaseControlFailureCode | null;
  degradedCapability: string | null;
};

export type ControlHealthSnapshot = {
  controlPlane: ControlPlaneState;
  vault: ControlVaultHealth;
  outboxPending: number;
  snapshotAvailable: boolean;
  servingReady: boolean;
  recoveryReady: boolean;
  degradedReason: SupabaseControlFailureCode | null;
  degradedCapability: string | null;
};

export function createControlPlane(
  over: Partial<ControlPlaneSnapshot> = {}
): ControlPlaneSnapshot {
  return {
    state: 'online',
    vault: 'fresh',
    failureCount: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    lastProbeAt: null,
    snapshotAvailable: true,
    degradedReason: null,
    degradedCapability: null,
    ...over,
  };
}

export function toControlHealth(
  plane: ControlPlaneSnapshot,
  outboxPending: number
): ControlHealthSnapshot {
  return {
    controlPlane: plane.state,
    vault: plane.vault,
    outboxPending,
    snapshotAvailable: plane.snapshotAvailable,
    servingReady: plane.snapshotAvailable,
    recoveryReady: false,
    degradedReason: plane.degradedReason,
    degradedCapability: plane.degradedCapability,
  };
}

export function createHybridBootPlane(snapshotAvailable: boolean): ControlPlaneSnapshot {
  return createControlPlane({
    state: snapshotAvailable ? 'probing' : 'recovery_only',
    vault: snapshotAvailable ? 'fresh' : 'stale',
    snapshotAvailable,
  });
}

export function recordControlProbeFailure(
  plane: ControlPlaneSnapshot,
  nowMs: number,
  failure: { code: SupabaseControlFailureCode; capability: string | null }
): ControlPlaneSnapshot {
  return {
    ...plane,
    state: plane.snapshotAvailable ? 'degraded' : 'recovery_only',
    vault: plane.snapshotAvailable ? 'stale' : plane.vault,
    failureCount: plane.failureCount + 1,
    lastFailureAt: nowMs,
    lastProbeAt: nowMs,
    degradedReason: failure.code,
    degradedCapability: failure.capability,
  };
}

/** Transport / 5xx / timeout style failure — not validation 4xx. */
export function recordRemoteFailure(
  plane: ControlPlaneSnapshot,
  nowMs: number
): ControlPlaneSnapshot {
  if (plane.state === 'reconciling') {
    return {
      ...plane,
      failureCount: plane.failureCount + 1,
      lastFailureAt: nowMs,
      lastProbeAt: nowMs,
    };
  }

  const failureCount = plane.failureCount + 1;
  if (
    plane.state === 'online' &&
    failureCount >= CONTROL_FAILURES_TO_DEGRADED
  ) {
    return {
      ...plane,
      state: 'degraded',
      vault: 'stale',
      failureCount,
      lastFailureAt: nowMs,
      lastProbeAt: nowMs,
    };
  }

  return {
    ...plane,
    failureCount,
    lastFailureAt: nowMs,
    lastProbeAt: nowMs,
  };
}

export function recordRemoteSuccess(
  plane: ControlPlaneSnapshot,
  nowMs: number
): ControlPlaneSnapshot {
  if (plane.state === 'degraded') {
    return {
      ...plane,
      state: 'reconciling',
      vault: 'replaying',
      failureCount: 0,
      lastSuccessAt: nowMs,
      lastProbeAt: nowMs,
    };
  }

  if (plane.state === 'reconciling') {
    return {
      ...plane,
      lastSuccessAt: nowMs,
      lastProbeAt: nowMs,
    };
  }

  if (plane.state === 'probing' || plane.state === 'recovery_only') {
    return {
      ...plane,
      state: plane.snapshotAvailable ? 'online' : plane.state,
      vault: plane.snapshotAvailable ? 'fresh' : plane.vault,
      failureCount: 0,
      lastSuccessAt: nowMs,
      lastProbeAt: nowMs,
      degradedReason: null,
      degradedCapability: null,
    };
  }

  return {
    ...plane,
    failureCount: 0,
    vault: 'fresh',
    lastSuccessAt: nowMs,
    lastProbeAt: nowMs,
    degradedReason: null,
    degradedCapability: null,
  };
}

/** Call after outbox replay + vault refresh succeed. */
export function finishReconcile(
  plane: ControlPlaneSnapshot,
  nowMs: number
): ControlPlaneSnapshot {
  return {
    ...plane,
    state: 'online',
    vault: 'fresh',
    failureCount: 0,
    lastSuccessAt: nowMs,
    lastProbeAt: nowMs,
    degradedReason: null,
    degradedCapability: null,
  };
}

export function nextProbeDueMs(
  plane: ControlPlaneSnapshot,
  fromMs?: number
): number {
  const base = fromMs ?? plane.lastProbeAt ?? plane.lastFailureAt ?? 0;
  return base + CONTROL_PROBE_INTERVAL_MS;
}

export function sortOutboxPending(ops: ControlOutboxOp[]): ControlOutboxOp[] {
  return [...ops]
    .filter((o) => o.appliedAt == null)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.opId.localeCompare(b.opId);
    });
}

/** Latest pending op for an entity id (by createdAt, then opId). */
export function foldOutboxForEntity(
  ops: ControlOutboxOp[],
  entityId: string
): ControlOutboxOp | null {
  const pending = sortOutboxPending(ops.filter((o) => o.entityId === entityId));
  return pending.length ? pending[pending.length - 1]! : null;
}

/** Mark op applied; idempotent — keeps first appliedAt. */
export function markOutboxApplied(
  ops: ControlOutboxOp[],
  opId: string,
  appliedAt: number
): ControlOutboxOp[] {
  return ops.map((o) => {
    if (o.opId !== opId) return o;
    if (o.appliedAt != null) return o;
    return { ...o, appliedAt };
  });
}

export function countPendingOutbox(ops: ControlOutboxOp[]): number {
  return ops.filter((o) => o.appliedAt == null).length;
}
