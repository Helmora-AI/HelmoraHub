import type { NextFunction, Request, Response } from 'express';
import { extractBearerToken } from '../lib/auth.js';
import { isHelRecoverySessionToken } from '../lib/hel-env.js';
import { verifyRecoverySession } from '../lib/recovery-sessions.js';

const RECOVERY_ROUTE_KEYS = new Set([
  'GET /api/auth/status',
  'POST /api/auth/recovery-login',
  'GET /api/storage/health',
  'POST /api/storage/test',
  'GET /api/settings/storage',
  'GET /api/settings/storage/schema',
  'PUT /api/settings/storage',
]);

export function isRecoveryRouteAllowed(method: string, pathName: string): boolean {
  return RECOVERY_ROUTE_KEYS.has(`${method.toUpperCase()} ${pathName}`);
}

declare global {
  namespace Express {
    interface Request {
      recoveryScope?: 'recovery';
    }
  }
}

export function requireRecovery(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const pathName = req.originalUrl.split('?')[0] ?? req.path;
  if (!isRecoveryRouteAllowed(req.method, pathName)) {
    res.status(403).json({
      error: {
        type: 'recovery_scope_denied',
        message: 'The recovery session cannot access this route.',
      },
    });
    return;
  }

  const bearer = extractBearerToken(req.header('authorization'));
  if (!bearer || !isHelRecoverySessionToken(bearer)) {
    res.status(401).json({
      error: {
        type: 'recovery_unauthorized',
        message: 'A recovery session bearer token is required.',
      },
    });
    return;
  }

  const verification = verifyRecoverySession(bearer);
  if (!verification.ok) {
    res.status(401).json({
      error: {
        type:
          verification.reason === 'expired'
            ? 'recovery_auth_expired'
            : 'recovery_unauthorized',
        message:
          verification.reason === 'expired'
            ? 'The recovery session has expired.'
            : 'The recovery session is invalid.',
      },
    });
    return;
  }

  req.recoveryScope = 'recovery';
  next();
}
