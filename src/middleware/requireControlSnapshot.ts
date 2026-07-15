import type { NextFunction, Request, Response } from 'express';
import { getControlHealth } from '../storage/index.js';

export function requireControlSnapshot(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  const health = getControlHealth();
  if (health.servingReady) {
    next();
    return;
  }

  res.status(503).json({
    error: {
      type: 'control_snapshot_unavailable',
      message:
        'Helmora Hub is online, but no complete local control snapshot is available yet.',
      recoveryAvailable: health.recoveryReady,
    },
  });
}
