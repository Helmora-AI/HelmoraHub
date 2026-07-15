import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getActiveConfig } from '../lib/config.js';
import { updateAdminConfig } from '../lib/runtime-config.js';
import {
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
  verifyAdminPassword,
  recoveryCredentialEnvironmentManaged,
} from '../lib/admin-auth.js';
import {
  issueAdminSession,
  revokeAdminSession,
} from '../lib/admin-sessions.js';
import { isHelSessionToken } from '../lib/hel-env.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

export const authRouter = Router();

/** Simple in-memory rate limit for setup/login (per IP). */
const authHits = new Map<string, { n: number; resetAt: number }>();

function rateLimitAuth(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
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

let setupLock = false;

authRouter.get('/status', (req, res) => {
  res.json(authStatusPayload(req));
});

authRouter.post('/setup', rateLimitAuth, (req, res) => {
  if (!isSetupRequired()) {
    res.status(409).json({
      error: { message: 'Admin already configured', type: 'already_configured' },
    });
    return;
  }

  if (setupLock) {
    res.status(409).json({
      error: { message: 'Setup already in progress', type: 'setup_in_progress' },
    });
    return;
  }

  const schema = z.object({
    password: z.string().min(8).max(200),
    adminToken: z.string().min(16).max(200).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
    return;
  }

  setupLock = true;
  try {
    if (!isSetupRequired()) {
      res.status(409).json({
        error: { message: 'Admin already configured', type: 'already_configured' },
      });
      return;
    }

    const config = getActiveConfig();
    const plainToken = parsed.data.adminToken?.trim() || generateAdminToken();
    const sessionSecret = randomBytes(32).toString('hex');
    const recoveryToken = recoveryCredentialEnvironmentManaged()
      ? null
      : generateRecoveryToken();

    updateAdminConfig(config.dataDir, {
      passwordHash: hashPassword(parsed.data.password),
      adminTokenHash: hashAdminToken(plainToken),
      sessionSecret,
      recoveryTokenHash: recoveryToken ? hashRecoveryToken(recoveryToken) : null,
    });

    const cookieSession = createSessionToken();
    setSessionCookie(req, res, cookieSession);
    const spa = issueAdminSession();

    res.json({
      ok: true,
      message: 'Admin password created. Save adminToken once; use token for SPA sessions.',
      token: spa.token,
      expiresAt: spa.expiresAt,
      adminToken: plainToken,
      ...(recoveryToken
        ? { recoveryToken }
        : { recoveryTokenEnvManaged: true }),
      auth: { ...authStatusPayload(req), authenticated: true, setupRequired: false },
    });
  } finally {
    setupLock = false;
  }
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

authRouter.post('/logout', (req, res) => {
  const bearer = extractAdminToken(req);
  if (bearer && isHelSessionToken(bearer)) {
    revokeAdminSession(bearer);
  }
  clearSessionCookie(req, res);
  res.json({
    ok: true,
    message: 'Logged out.',
    auth: { ...authStatusPayload(req), authenticated: false },
  });
});

authRouter.get('/me', requireAdmin, (req, res) => {
  res.json({ ok: true, auth: authStatusPayload(req) });
});

authRouter.post('/rotate-token', requireAdmin, (req, res) => {
  const config = getActiveConfig();
  const plainToken = generateAdminToken();
  updateAdminConfig(config.dataDir, {
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
  updateAdminConfig(config.dataDir, {
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
  updateAdminConfig(config.dataDir, {
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
