import { describe, expect, it } from 'vitest';
import {
  createControlPlane,
  foldOutboxForEntity,
  markOutboxApplied,
  nextProbeDueMs,
  recordRemoteFailure,
  recordRemoteSuccess,
  sortOutboxPending,
  type ControlOutboxOp,
  type ControlPlaneSnapshot,
} from '../storage/control-plane.js';

function op(
  over: Partial<ControlOutboxOp> & Pick<ControlOutboxOp, 'opId' | 'entityId' | 'action'>
): ControlOutboxOp {
  return {
    entity: 'api_key',
    payload: {},
    createdAt: 1_000,
    appliedAt: null,
    ...over,
  };
}

describe('control plane state machine', () => {
  it('starts online with fresh vault', () => {
    const s = createControlPlane();
    expect(s.state).toBe('online');
    expect(s.vault).toBe('fresh');
    expect(s.failureCount).toBe(0);
  });

  it('enters degraded after 2 consecutive transport failures', () => {
    let s = createControlPlane();
    s = recordRemoteFailure(s, 1_000);
    expect(s.state).toBe('online');
    expect(s.failureCount).toBe(1);
    s = recordRemoteFailure(s, 1_100);
    expect(s.state).toBe('degraded');
    expect(s.vault).toBe('stale');
    expect(s.failureCount).toBe(2);
  });

  it('does not degrade on a single failure', () => {
    const s = recordRemoteFailure(createControlPlane(), 1_000);
    expect(s.state).toBe('online');
  });

  it('resets failure count on success while online', () => {
    let s = recordRemoteFailure(createControlPlane(), 1_000);
    s = recordRemoteSuccess(s, 1_200);
    expect(s.failureCount).toBe(0);
    expect(s.state).toBe('online');
    expect(s.vault).toBe('fresh');
  });

  it('moves degraded → reconciling on probe success, then online after reconcile done', () => {
    let s: ControlPlaneSnapshot = createControlPlane();
    s = recordRemoteFailure(s, 1_000);
    s = recordRemoteFailure(s, 1_100);
    expect(s.state).toBe('degraded');

    s = recordRemoteSuccess(s, 5_000);
    expect(s.state).toBe('reconciling');
    expect(s.vault).toBe('replaying');

    s = recordRemoteSuccess(s, 5_100); // reconcile complete signal
    // Still reconciling until explicit finishReconcile
    expect(s.state).toBe('reconciling');
  });

  it('finishReconcile returns online with fresh vault', async () => {
    const { finishReconcile } = await import('../storage/control-plane.js');
    let s = createControlPlane();
    s = recordRemoteFailure(s, 1);
    s = recordRemoteFailure(s, 2);
    s = recordRemoteSuccess(s, 3);
    expect(s.state).toBe('reconciling');
    s = finishReconcile(s, 4);
    expect(s.state).toBe('online');
    expect(s.vault).toBe('fresh');
    expect(s.failureCount).toBe(0);
  });

  it('schedules next probe 15s after last probe while degraded', () => {
    let s = createControlPlane();
    s = recordRemoteFailure(s, 1_000);
    s = recordRemoteFailure(s, 1_100);
    expect(nextProbeDueMs(s, 1_100)).toBe(1_100 + 15_000);
  });
});

describe('control outbox', () => {
  it('sorts pending by createdAt then opId', () => {
    const pending = [
      op({ opId: 'b', entityId: 'k1', action: 'modify', createdAt: 200 }),
      op({ opId: 'a', entityId: 'k1', action: 'add', createdAt: 100 }),
      op({ opId: 'c', entityId: 'k2', action: 'delete', createdAt: 100 }),
    ];
    const sorted = sortOutboxPending(pending);
    expect(sorted.map((o) => o.opId)).toEqual(['a', 'c', 'b']);
  });

  it('fold keeps later op for same entityId', () => {
    const pending = [
      op({ opId: '1', entityId: 'k1', action: 'add', createdAt: 100 }),
      op({ opId: '2', entityId: 'k1', action: 'modify', createdAt: 200 }),
      op({ opId: '3', entityId: 'k1', action: 'delete', createdAt: 300 }),
      op({ opId: '4', entityId: 'k2', action: 'add', createdAt: 150 }),
    ];
    const folded = foldOutboxForEntity(pending, 'k1');
    expect(folded?.opId).toBe('3');
    expect(folded?.action).toBe('delete');
  });

  it('markOutboxApplied is idempotent by opId', () => {
    const pending = [
      op({ opId: '1', entityId: 'k1', action: 'add', createdAt: 100 }),
      op({ opId: '2', entityId: 'k2', action: 'add', createdAt: 200 }),
    ];
    const once = markOutboxApplied(pending, '1', 9_000);
    expect(once.find((o) => o.opId === '1')?.appliedAt).toBe(9_000);
    const twice = markOutboxApplied(once, '1', 9_999);
    expect(twice.find((o) => o.opId === '1')?.appliedAt).toBe(9_000);
    expect(twice.filter((o) => o.appliedAt == null)).toHaveLength(1);
  });
});
