import type { Request, Response, NextFunction } from 'express';
import {
  authStatusPayload,
  extractAdminToken,
  isSetupRequired,
} from '../lib/admin-auth.js';
import { isHelSessionToken } from '../lib/hel-env.js';
import { verifyAdminSession } from '../lib/admin-sessions.js';

/**
 * SPA admin session only — rejects /v1 consumer keys and long-lived admin tokens.
 */
export function requireAdminSession(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (isSetupRequired()) {
    res.status(403).json({
      error: {
        message: 'Admin setup required. Open /settings and create an admin password.',
        type: 'setup_required',
      },
      auth: authStatusPayload(req),
    });
    return;
  }

  const bearer = extractAdminToken(req);
  if (bearer && isHelSessionToken(bearer)) {
    const result = verifyAdminSession(bearer);
    if (result.ok) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        message:
          result.reason === 'expired'
            ? 'Admin session expired. Log in again.'
            : 'Admin session required.',
        type: result.reason === 'expired' ? 'auth_expired' : 'admin_unauthorized',
      },
      auth: authStatusPayload(req),
    });
    return;
  }

  res.status(401).json({
    error: {
      message:
        'SPA admin session required. Log in via the dashboard (Bearer helmora_session_…).',
      type: 'admin_unauthorized',
    },
    auth: authStatusPayload(req),
  });
}
