import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './lib/config.js';
import { runtimeRouter } from './routes/runtime.js';
import { v1Router } from './routes/v1.js';
import { adminRouter } from './routes/admin.js';
import { settingsRouter } from './routes/settings.js';
import { authRouter } from './routes/auth.js';
import { requireAdmin } from './middleware/requireAdmin.js';
import { requireControlSnapshot } from './middleware/requireControlSnapshot.js';
import { keysRouter, pricingRouter, usageRouter } from './routes/keys.js';
import { chatRouter } from './routes/chat.js';
import { officeRouter } from './routes/office.js';
import { oauthRouter } from './routes/oauth.js';
import { toolsRouter } from './routes/tools.js';
import { recoveryRouter } from './routes/recovery.js';
import './oauth/handlers/index.js';
import { DOCS_CATALOG } from './docs/catalog.js';
import { HUB_VERSION } from './lib/version.js';
import { browserOriginPolicy } from './lib/origin-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePublicDir(): string | undefined {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public'),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function inlineAssetHashes(publicDir: string | undefined): {
  scripts: string[];
  styles: string[];
} {
  if (!publicDir) return { scripts: [], styles: [] };
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const hash = (value: string) =>
    `'sha256-${crypto.createHash('sha256').update(value).digest('base64')}'`;
  for (const name of fs.readdirSync(publicDir)) {
    if (!name.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      if (match[1]) scripts.add(hash(match[1]));
    }
    for (const match of html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)) {
      if (match[1]) styles.add(hash(match[1]));
    }
  }
  return { scripts: [...scripts], styles: [...styles] };
}

function authResponseHeaders(
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

type BodyParserError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
};

export function publicErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction
) {
  const parserError = err as BodyParserError;

  if (parserError?.type === 'encoding.unsupported') {
    res.status(415).json({
      error: {
        type: 'unsupported_content_encoding',
        message: 'Compressed request bodies are not supported for this endpoint.',
      },
    });
    return;
  }
  if (parserError?.type === 'entity.too.large') {
    res.status(413).json({
      error: {
        type: 'payload_too_large',
        message: 'Request body exceeds the allowed size.',
      },
    });
    return;
  }
  if (parserError?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: {
        type: 'invalid_json',
        message: 'Request body is not valid JSON.',
      },
    });
    return;
  }
  if (
    typeof parserError?.status === 'number' &&
    parserError.status >= 400 &&
    parserError.status < 500
  ) {
    res.status(parserError.status).json({
      error: {
        type: 'invalid_request',
        message: 'Request could not be processed.',
      },
    });
    return;
  }

  // Arbitrary error messages and request bodies may contain credentials.
  console.error('[helmora] unexpected request error', {
    name: err instanceof Error ? err.name : 'UnknownError',
  });
  res.status(500).json({
    error: {
      type: 'internal_error',
      message: 'An unexpected internal error occurred.',
    },
  });
}

export function createApp(config: Config) {
  const app = express();
  const publicDir = resolvePublicDir();
  const cspHashes = inlineAssetHashes(publicDir);

  const authJson = express.json({ limit: '16kb', inflate: false });
  const controlJson = express.json({ limit: '256kb', inflate: false });
  const chatAndVisionJson = express.json({ limit: '10mb' });

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", ...cspHashes.scripts],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", ...cspHashes.styles],
        styleSrcAttr: ["'none'"],
      },
    },
  }));
  app.use(browserOriginPolicy(config.corsOrigins));

  // Claw3D custom runtime contract (no API key — Studio probes these)
  app.use(runtimeRouter);

  // OpenAI-compatible surface (hel_dev_ / hel_pro_ keys; legacy ctrl_* accepted)
  app.use('/v1', chatAndVisionJson, requireControlSnapshot, v1Router);

  // Auth bootstrap / login (public subset)
  app.use('/api/auth', authResponseHeaders, authJson, authRouter);

  // Admin Chat — SPA session only (before broad /api requireAdmin)
  app.use('/api/chat', chatAndVisionJson, requireControlSnapshot, chatRouter);

  // OAuth — callback is public; start/refresh/disconnect use their own middleware
  // Mount before broad /api requireAdmin so GET /callback stays unauthenticated.
  app.use('/api/oauth', controlJson, requireControlSnapshot, oauthRouter);

  // The remaining control plane uses a smaller, uncompressed JSON contract.
  app.use('/api', controlJson);

  // Recovery sessions are bearer-only and restricted to an exact method/path allowlist.
  app.use('/api', recoveryRouter);

  // Control plane — admin session cookie or admin bearer token
  app.use('/api/keys', requireControlSnapshot, requireAdmin, keysRouter);
  app.use('/api/pricing', requireControlSnapshot, requireAdmin, pricingRouter);
  app.use('/api/usage', requireControlSnapshot, requireAdmin, usageRouter);
  app.use('/api/settings', requireControlSnapshot, requireAdmin, settingsRouter);
  app.use('/api/office', requireControlSnapshot, requireAdmin, officeRouter);
  app.use('/api/tools', requireControlSnapshot, requireAdmin, toolsRouter);
  app.use('/api', requireControlSnapshot, requireAdmin, adminRouter);

  if (publicDir) {
    app.use('/public', express.static(publicDir));
    app.get('/docs', (_req, res) => {
      res.sendFile(path.join(publicDir, 'docs.html'));
    });
    app.get('/settings', (_req, res) => {
      res.sendFile(path.join(publicDir, 'settings.html'));
    });
    app.get('/providers', (_req, res) => {
      res.sendFile(path.join(publicDir, 'providers.html'));
    });
    app.get('/models', (_req, res) => {
      res.sendFile(path.join(publicDir, 'models.html'));
    });
  } else {
    app.get('/docs', (_req, res) => {
      res
        .status(503)
        .type('text')
        .send('Docs HTML not found. Ensure public/docs.html is packaged with the Hub.');
    });
  }

  app.get('/docs.json', (_req, res) => {
    res.json(DOCS_CATALOG);
  });

  app.get('/', (_req, res) => {
    res.json({
      name: 'Helmora AI',
      version: HUB_VERSION,
      storage: 'Settings UI: Local (default) | SQL (Supabase)',
      docs: {
        human: 'GET /docs (public)',
        json: 'GET /docs.json (public)',
        settings: 'GET /settings (admin password session)',
        providersUi: 'GET /providers (admin)',
        modelsUi: 'GET /models (admin)',
        auth: 'GET /api/auth/status · POST /api/auth/setup|login|logout',
        keys: 'GET|POST /api/keys · PATCH|DELETE /api/keys/:id (admin)',
        pricing: 'GET|PUT /api/pricing (admin)',
        usage: 'GET /api/usage (admin)',
        storageApi: 'GET|PUT /api/settings/storage (admin)',
        storageSchema: 'GET /api/settings/storage/schema (admin) — SQL DDL for Supabase',
        tunnelApi: 'GET|PUT /api/settings/tunnel (admin)',
        health: 'GET /health · GET /api/health',
        state: 'GET /state',
        registry: 'GET /registry',
        chat: 'POST /v1/chat/completions · POST /v1/embeddings (hel_* / ctrl_*) · POST /api/chat/completions (SPA session) · /api/chat/sessions (Hub SQL history)',
        models: 'GET /v1/models · GET /api/models (admin)',
        admin: 'GET /api/status (admin)',
        schema: 'sql/supabase-schema.sql (apply in Supabase SQL Editor before SQL mode)',
      },
    });
  });

  app.use((req, res) => {
    res.status(404).json({
      error: {
        message: `No route for ${req.method} ${req.path}`,
        type: 'not_found',
      },
    });
  });

  app.use(publicErrorHandler);

  return app;
}
