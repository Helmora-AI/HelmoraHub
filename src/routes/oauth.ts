import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireAdminSession } from '../middleware/requireAdminSession.js';
import { extractAdminToken } from '../lib/admin-auth.js';
import { createOAuthCore } from '../oauth/create-core.js';
import { ensureOAuthVerifyProcessorWired } from '../oauth/wire-verify.js';
import '../oauth/handlers/index.js';

export { createOAuthCore } from '../oauth/create-core.js';

export const oauthRouter = Router();

ensureOAuthVerifyProcessorWired();

function setNoStoreHeaders(res: import('express').Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendOAuthError(
  res: import('express').Response,
  err: unknown,
  next: import('express').NextFunction
): void {
  const e = err as { code?: string; status?: number; message?: string };
  if (e.code === 'provider_not_supported') {
    res.status(404).json({
      error: { message: 'OAuth provider not supported', type: 'provider_not_supported' },
    });
    return;
  }
  if (e.status === 503) {
    res.status(503).json({
      error: { message: e.message || 'OAuth unavailable', type: e.code || 'oauth_unavailable' },
    });
    return;
  }
  next(err);
}

/** GET /api/oauth/callback — public IdP redirect (registered before param routes). */
oauthRouter.get('/callback', async (req, res, next) => {
  try {
    setNoStoreHeaders(res);
    const core = createOAuthCore();
    const { redirectUrl } = await core.handleCallback({
      query: req.query as Record<string, string | string[] | undefined>,
    });
    res.redirect(302, redirectUrl);
  } catch (err) {
    setNoStoreHeaders(res);
    sendOAuthError(res, err, next);
  }
});

/** POST /api/oauth/:providerId/start — SPA admin session only */
oauthRouter.post('/:providerId/start', requireAdminSession, async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || '').trim();
    if (!providerId) {
      res.status(400).json({ error: { message: 'providerId required', type: 'bad_request' } });
      return;
    }
    const sessionId = extractAdminToken(req) || 'unknown-session';
    const core = createOAuthCore();
    const result = await core.startOAuth({
      providerId,
      adminSessionId: sessionId,
    });
    res.json({
      authorizeUrl: result.authorizeUrl,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    sendOAuthError(res, err, next);
  }
});

/** POST /api/oauth/:providerId/refresh */
oauthRouter.post('/:providerId/refresh', requireAdmin, async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || '').trim();
    const core = createOAuthCore();
    const result = await core.refreshOAuth(providerId);
    res.json(result);
  } catch (err) {
    sendOAuthError(res, err, next);
  }
});

/** DELETE /api/oauth/:providerId */
oauthRouter.delete('/:providerId', requireAdmin, async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || '').trim();
    const core = createOAuthCore();
    const result = await core.disconnectOAuth(providerId);
    res.json(result);
  } catch (err) {
    sendOAuthError(res, err, next);
  }
});
