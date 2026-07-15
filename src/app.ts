import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'node:fs';
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
import './oauth/handlers/index.js';
import { DOCS_CATALOG } from './docs/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(_config: Config) {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(
    cors({
      origin: true,
      credentials: true,
      maxAge: 600,
      optionsSuccessStatus: 204,
      allowedHeaders: [
        'Accept',
        'Authorization',
        'Content-Type',
        'X-Admin-Token',
        'X-API-Key',
        'X-Ctrl-Mode',
        'X-CtrlHub-Mode',
        'X-Helmora-Identity',
        'X-Helmora-Mode',
        'X-Helmora-Tools',
      ],
      exposedHeaders: [
        'X-Helmora-Identity',
        'X-Helmora-Mini-Role',
        'X-Helmora-Mini-Slot',
        'X-Ctrl-Meta-Model',
        'X-Routed-Via',
      ],
    })
  );
  app.use(express.json({ limit: '10mb' }));

  // Claw3D custom runtime contract (no API key — Studio probes these)
  app.use(runtimeRouter);

  // OpenAI-compatible surface (hel_dev_ / hel_pro_ keys; legacy ctrl_* accepted)
  app.use('/v1', requireControlSnapshot, v1Router);

  // Auth bootstrap / login (public subset)
  app.use('/api/auth', authRouter);

  // Admin Chat — SPA session only (before broad /api requireAdmin)
  app.use('/api/chat', requireControlSnapshot, chatRouter);

  // OAuth — callback is public; start/refresh/disconnect use their own middleware
  // Mount before broad /api requireAdmin so GET /callback stays unauthenticated.
  app.use('/api/oauth', requireControlSnapshot, oauthRouter);

  // Control plane — admin session cookie or admin bearer token
  app.use('/api/keys', requireControlSnapshot, requireAdmin, keysRouter);
  app.use('/api/pricing', requireControlSnapshot, requireAdmin, pricingRouter);
  app.use('/api/usage', requireControlSnapshot, requireAdmin, usageRouter);
  app.use('/api/settings', requireControlSnapshot, requireAdmin, settingsRouter);
  app.use('/api/office', requireControlSnapshot, requireAdmin, officeRouter);
  app.use('/api/tools', requireControlSnapshot, requireAdmin, toolsRouter);
  app.use('/api', requireControlSnapshot, requireAdmin, adminRouter);

  const publicCandidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public'),
  ];
  const publicDir = publicCandidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

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
      version: '0.1.16',
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

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({
      error: {
        message: err instanceof Error ? err.message : 'Internal error',
        type: 'internal_error',
      },
    });
  });

  return app;
}
