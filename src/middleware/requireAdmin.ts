import type { Request, Response, NextFunction } from 'express';
import {
  authStatusPayload,
  extractAdminToken,
  isAdminAuthenticated,
  isSetupRequired,
  verifyAdminTokenPlain,
  verifySessionToken,
  getSessionFromRequest,
} from '../lib/admin-auth.js';
import { isHelSessionToken } from '../lib/hel-env.js';
import { verifyAdminSession } from '../lib/admin-sessions.js';

/** Protect /api/* except public auth routes mounted separately. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
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

  if (verifySessionToken(getSessionFromRequest(req))) {
    next();
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
            : 'Admin authentication required.',
        type: result.reason === 'expired' ? 'auth_expired' : 'admin_unauthorized',
      },
      auth: authStatusPayload(req),
    });
    return;
  }

  if (bearer && verifyAdminTokenPlain(bearer)) {
    next();
    return;
  }

  if (isAdminAuthenticated(req)) {
    next();
    return;
  }

  res.status(401).json({
    error: {
      message:
        'Admin authentication required. Log in or send Authorization: Bearer <session-or-admin-token>.',
      type: 'admin_unauthorized',
    },
    auth: authStatusPayload(req),
  });
}
