import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getActiveConfig } from '../lib/config.js';
import {
  adminCredentialEnvironmentManaged,
  authDiagnosticsPayload,
  authStatusPayload,
  clearSessionCookie,
  createSessionToken,
  extractAdminToken,
  generateAdminToken,
  generateRecoveryToken,
  hashRecoveryToken,
  hashAdminToken,
  hashPassword,
  isSetupRequired,
  setSessionCookie,
  getSessionFromRequest,
  verifyAdminPassword,
  recoveryCredentialEnvironmentManaged,
  recoveryCredentialAvailable,
  verifyRecoveryCredential,
} from '../lib/admin-auth.js';
import {
  issueAdminSession,
  prepareAdminSession,
  revokeAdminSessions,
} from '../lib/admin-sessions.js';
import { isHelSessionToken } from '../lib/hel-env.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { issueRecoverySession } from '../lib/recovery-sessions.js';
import { getControlHealth } from '../storage/index.js';
import {
  getAdminAuthStore,
  getAdminAuthStoreHealth,
} from '../lib/admin-auth-store.js';
import {
  setupAttemptLimiter,
  verifySetupToken,
} from '../lib/setup-token.js';

export const authRouter = Router();

/** Simple in-memory rate limit for setup/login (per IP). */
const authHits = new Map<string, { n: number; resetAt: number }>();
const recoveryAuthHits = new Map<string, { n: number; resetAt: number }>();

function authRateKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimitAuth(req: Request, res: Response, next: NextFunction): void {
  const ip = authRateKey(req);
  const now = Date.now();
  const windowMs = 60_000;
  const max = 20;
  let row = authHits.get(ip);
  if (!row || row.resetAt < now) {
    row = { n: 0, resetAt: now + windowMs };
    authHits.set(ip, row);
  }
  row.n += 1;
  if (row.n > max) {
    res.status(429).json({
      error: { message: 'Too many auth attempts', type: 'rate_limited' },
    });
    return;
  }
  next();
}

function rateLimitRecoveryAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ip = authRateKey(req);
  const now = Date.now();
  const windowMs = 15 * 60_000;
  const max = 5;
  let row = recoveryAuthHits.get(ip);
  if (!row || row.resetAt < now) {
    row = { n: 0, resetAt: now + windowMs };
    recoveryAuthHits.set(ip, row);
  }
  row.n += 1;
  if (row.n > max) {
    res.status(429).json({
      error: {
        message: 'Too many recovery authentication attempts.',
        type: 'rate_limited',
      },
    });
    return;
  }
  next();
}

authRouter.get('/status', (req, res) => {
  const control = getControlHealth();
  res.json({
    ...authStatusPayload(req),
    recoveryMode: control.controlPlane === 'recovery_only',
  });
});

authRouter.use((req, res, next) => {
  if (getAdminAuthStoreHealth().ready) {
    next();
    return;
  }
  res.status(503).json({
    error: {
      type: 'auth_migration_incomplete',
      message: 'Authentication storage migration is incomplete.',
    },
  });
});

authRouter.post('/setup', (req, res) => {
  if (!isSetupRequired()) {
    res.status(409).json({
      error: { message: 'Admin already configured', type: 'already_configured' },
    });
    return;
  }

  const config = getActiveConfig();
  if (config.setupTokenState !== 'valid' || !config.setupToken) {
    res.status(503).json({
      error: {
        message: 'A valid HELMORA_SETUP_TOKEN is required before setup.',
        type: 'setup_token_not_configured',
      },
    });
    return;
  }

  const limit = setupAttemptLimiter.consume(
    req.socket.remoteAddress || 'unknown'
  );
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    res.status(429).json({
      error: {
        message: 'Too many setup attempts.',
        type: 'setup_rate_limited',
      },
    });
    return;
  }

  const schema = z.object({
    password: z.string().min(8).max(200),
    setupToken: z.string().max(512).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
    return;
  }

  if (!verifySetupToken(config.setupToken, parsed.data.setupToken)) {
    res.status(403).json({
      error: {
        message: 'Setup token is invalid.',
        type: 'setup_token_invalid',
      },
    });
    return;
  }

  const adminEnvManaged = adminCredentialEnvironmentManaged();
  const recoveryEnvManaged = recoveryCredentialEnvironmentManaged();
  const adminToken = adminEnvManaged ? null : generateAdminToken();
  const recoveryToken = recoveryEnvManaged ? null : generateRecoveryToken();
  const cookie = prepareAdminSession('cookie');
  const spa = prepareAdminSession('spa');
  const result = getAdminAuthStore(config.dataDir).attemptBootstrap({
    passwordHash: hashPassword(parsed.data.password),
    adminTokenHash: adminToken ? hashAdminToken(adminToken) : null,
    recoveryTokenHash: recoveryToken ? hashRecoveryToken(recoveryToken) : null,
    sessions: [cookie.record, spa.record],
  });
  if (!result.created) {
    res.status(409).json({
      error: { message: 'Admin already configured', type: 'already_configured' },
    });
    return;
  }

  setupAttemptLimiter.clear();
  setSessionCookie(req, res, cookie.token);
  res.json({
    ok: true,
    message: 'Admin password created. Save generated credentials now.',
    token: spa.token,
    expiresAt: spa.expiresAt,
    ...(adminToken ? { adminToken } : { adminTokenEnvManaged: true }),
    ...(recoveryToken
      ? { recoveryToken }
      : { recoveryTokenEnvManaged: true }),
    auth: { ...authStatusPayload(req), authenticated: true, setupRequired: false },
  });
});

authRouter.post('/login', rateLimitAuth, (req, res) => {
  if (isSetupRequired()) {
    res.status(403).json({
      error: { message: 'Setup required first', type: 'setup_required' },
    });
    return;
  }

  const schema = z.object({
    password: z.string().min(1).max(200),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
    return;
  }

  if (!verifyAdminPassword(parsed.data.password)) {
    res.status(401).json({
      error: { message: 'Invalid password', type: 'invalid_password' },
    });
    return;
  }

  const cookieSession = createSessionToken();
  setSessionCookie(req, res, cookieSession);
  const spa = issueAdminSession();

  res.json({
    ok: true,
    message: 'Logged in.',
    token: spa.token,
    expiresAt: spa.expiresAt,
    auth: { ...authStatusPayload(req), authenticated: true },
  });
});

authRouter.post('/recovery-login', rateLimitRecoveryAuth, (req, res) => {
  if (isSetupRequired()) {
    res.status(403).json({
      error: { message: 'Setup required first', type: 'setup_required' },
    });
    return;
  }
  if (!recoveryCredentialAvailable()) {
    res.status(503).json({
      error: {
        type: 'recovery_unavailable',
        message: 'No Helmora recovery credential is configured.',
      },
    });
    return;
  }

  const parsed = z.object({ token: z.string().min(16).max(512) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { type: 'validation_error', message: parsed.error.message },
    });
    return;
  }
  if (!verifyRecoveryCredential(parsed.data.token)) {
    res.status(401).json({
      error: {
        type: 'recovery_unauthorized',
        message: 'Invalid recovery credential.',
      },
    });
    return;
  }

  recoveryAuthHits.delete(authRateKey(req));
  res.json({ ok: true, ...issueRecoverySession() });
});

authRouter.post('/logout', (req, res) => {
  const bearer = extractAdminToken(req);
  const cookie = getSessionFromRequest(req);
  revokeAdminSessions([
    bearer && isHelSessionToken(bearer) ? bearer : null,
    cookie,
  ]);
  clearSessionCookie(req, res);
  res.json({
    ok: true,
    message: 'Logged out.',
    auth: { ...authStatusPayload(req), authenticated: false },
  });
});

authRouter.get('/me', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    auth: {
      ...authStatusPayload(req),
      ...authDiagnosticsPayload(),
    },
  });
});

authRouter.post('/rotate-token', requireAdmin, (req, res) => {
  const config = getActiveConfig();
  if (adminCredentialEnvironmentManaged()) {
    res.status(409).json({
      error: {
        message: 'The admin token is managed by HELMORA_ADMIN_TOKEN.',
        type: 'admin_token_env_managed',
      },
    });
    return;
  }
  const plainToken = generateAdminToken();
  getAdminAuthStore(config.dataDir).upsertIdentity({
    adminTokenHash: hashAdminToken(plainToken),
  });
  res.json({
    ok: true,
    message: 'New admin token created. Copy it now — it will not be shown again.',
    adminToken: plainToken,
    auth: authStatusPayload(req),
  });
});

authRouter.post('/rotate-recovery-token', requireAdmin, (_req, res) => {
  if (recoveryCredentialEnvironmentManaged()) {
    res.status(409).json({
      error: {
        message: 'The recovery token is managed by HELMORA_RECOVERY_TOKEN.',
        type: 'recovery_token_env_managed',
      },
    });
    return;
  }

  const config = getActiveConfig();
  const recoveryToken = generateRecoveryToken();
  getAdminAuthStore(config.dataDir).upsertIdentity({
    recoveryTokenHash: hashRecoveryToken(recoveryToken),
  });
  res.json({ ok: true, recoveryToken });
});

authRouter.put('/password', requireAdmin, (req, res) => {
  const schema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
    return;
  }

  if (!verifyAdminPassword(parsed.data.currentPassword)) {
    res.status(401).json({
      error: { message: 'Current password is wrong', type: 'invalid_password' },
    });
    return;
  }

  const config = getActiveConfig();
  getAdminAuthStore(config.dataDir).upsertIdentity({
    passwordHash: hashPassword(parsed.data.newPassword),
  });

  const cookieSession = createSessionToken();
  setSessionCookie(req, res, cookieSession);
  const spa = issueAdminSession();
  res.json({
    ok: true,
    message: 'Password updated.',
    token: spa.token,
    expiresAt: spa.expiresAt,
    auth: authStatusPayload(req),
  });
});
