import { Router } from 'express';
import { z } from 'zod';
import { getActiveConfig, loadConfig, setActiveConfig, type RateBackend } from '../lib/config.js';
import { HEL_TABLE } from '../lib/hel-env.js';
import {
  maskRuntimeConfig,
  readRuntimeConfig,
  storageChoiceToBackend,
  updateTunnelConfig,
  writeRuntimeConfig,
  type RuntimeConfigFile,
  type StorageChoice,
} from '../lib/runtime-config.js';
import { getControlHealth, getStorage, reinitStorage } from '../storage/index.js';
import { maskSecret } from '../lib/crypto.js';
import { getTunnelStatus, stopTunnel } from '../tunnel/manager.js';
import {
  sealTunnelToken,
  startTunnelFromSavedConfig,
  syncTunnelMetaFromConfig,
  tunnelPublicPayload,
} from '../tunnel/service.js';

export const settingsRouter = Router();

/** Aggregated settings for SPA (tunnel read-only). */
settingsRouter.get('/', (_req, res) => {
  const config = getActiveConfig();
  const runtime = readRuntimeConfig(config.dataDir);
  const storage = getStorage();
  const form = maskRuntimeConfig(runtime);

  res.json({
    storage: {
      choice: config.storageChoice,
      options: [
        {
          id: 'local',
          label: 'Local',
          description: 'SQLite on this machine (default). Best for local / Docker.',
        },
        {
          id: 'sql',
          label: 'SQL (Supabase)',
          description:
            'Hybrid: control on Supabase, vault/workspace on local SQLite. Provider keys encrypted at rest.',
        },
      ],
      form: {
        supabaseUrl: form.supabaseUrl,
        supabaseServiceRoleConfigured: Boolean(runtime.supabaseServiceRoleKey),
        supabaseServiceRoleHint: maskSecret(runtime.supabaseServiceRoleKey),
        encryptionKeyConfigured: Boolean(runtime.encryptionKey),
        encryptionKeyHint: runtime.encryptionKey ? '••••' : null,
        rateBackend: form.rateBackend,
        redisConfigured: Boolean(runtime.redisUrl),
      },
      current: {
        choice: config.storageChoice,
        backend: storage.config.backend,
        rateBackend: storage.rate.backend,
        control: getControlHealth(),
      },
      migration: {
        supported: false,
        note: 'Phase A: changing storage applies on reinit/restart; no automatic data migration.',
      },
    },
    tunnel: tunnelPublicPayload(getTunnelStatus()),
  });
});

settingsRouter.get('/storage', (_req, res) => {
  const config = getActiveConfig();
  const runtime = readRuntimeConfig(config.dataDir);
  const storage = getStorage();
  const control = getControlHealth();

  res.json({
    options: [
      {
        id: 'local',
        label: 'Local',
        description: 'SQLite on this machine (default). Best for local / Docker.',
      },
      {
        id: 'sql',
        label: 'SQL (Supabase)',
        description:
          'Hybrid: control on Supabase, vault/workspace on local SQLite. Provider keys encrypted at rest.',
      },
    ],
    current: {
      choice: config.storageChoice,
      backend: storage.config.backend,
      rateBackend: storage.rate.backend,
      control,
    },
    control,
    form: maskRuntimeConfig(runtime),
    defaults: { choice: 'local' },
  });
});

settingsRouter.put('/storage', async (req, res, next) => {
  try {
    const schema = z.object({
      storageChoice: z.enum(['local', 'sql']),
      supabaseUrl: z.string().url().nullable().optional(),
      supabaseServiceRoleKey: z.string().min(1).nullable().optional(),
      encryptionKey: z.string().min(8).nullable().optional(),
      rateBackend: z.enum(['memory', 'redis']).optional(),
      redisUrl: z.string().min(1).nullable().optional(),
      /** Keep existing secrets when fields omitted / blank */
      clearSupabaseServiceRoleKey: z.boolean().optional(),
      clearEncryptionKey: z.boolean().optional(),
      /** Validate only — do not persist or reinit */
      testOnly: z.boolean().optional(),
      confirmDangerous: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: 'validation_error' } });
      return;
    }

    const body = parsed.data;
    const current = getActiveConfig();
    const prev = readRuntimeConfig(current.dataDir);

    let serviceKey = prev.supabaseServiceRoleKey;
    if (body.clearSupabaseServiceRoleKey) serviceKey = null;
    else if (body.supabaseServiceRoleKey !== undefined) {
      serviceKey = body.supabaseServiceRoleKey;
    }

    let encKey = prev.encryptionKey;
    if (body.clearEncryptionKey) encKey = null;
    else if (body.encryptionKey !== undefined) {
      encKey = body.encryptionKey;
    }

    const nextRuntime: RuntimeConfigFile = {
      storageChoice: body.storageChoice as StorageChoice,
      supabaseUrl:
        body.supabaseUrl !== undefined ? body.supabaseUrl : prev.supabaseUrl,
      supabaseServiceRoleKey: serviceKey,
      encryptionKey: encKey,
      rateBackend: (body.rateBackend ?? prev.rateBackend) as RateBackend,
      redisUrl: body.redisUrl !== undefined ? body.redisUrl : prev.redisUrl,
      tunnel: prev.tunnel,
      admin: prev.admin,
    };

    if (nextRuntime.storageChoice === 'sql') {
      if (!nextRuntime.supabaseUrl || !nextRuntime.supabaseServiceRoleKey) {
        res.status(400).json({
          error: {
            message:
              'SQL (Supabase) requires Supabase URL and Service Role Key. Run sql/supabase-schema.sql first.',
            type: 'validation_error',
          },
        });
        return;
      }
      const effectiveEnc =
        process.env.ENCRYPTION_KEY?.trim() || nextRuntime.encryptionKey;
      if (!effectiveEnc) {
        res.status(400).json({
          error: {
            message: 'SQL (Supabase) requires an Encryption Key (or ENCRYPTION_KEY env).',
            type: 'validation_error',
          },
        });
        return;
      }
    }

    if (body.testOnly) {
      if (nextRuntime.storageChoice === 'local') {
        res.json({
          ok: true,
          tested: true,
          message: 'Local SQLite does not require a remote connection test.',
        });
        return;
      }
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const client = createClient(
          nextRuntime.supabaseUrl!,
          nextRuntime.supabaseServiceRoleKey!,
          { auth: { persistSession: false, autoRefreshToken: false } }
        );
        const probe = await client.from(HEL_TABLE.settings).select('key').limit(1);
        if (probe.error) {
          res.status(400).json({
            ok: false,
            tested: false,
            error: {
              message: `Supabase probe failed: ${probe.error.message}`,
              type: 'connection_failed',
            },
          });
          return;
        }
        res.json({
          ok: true,
          tested: true,
          message: `Supabase connection OK (${HEL_TABLE.settings} reachable).`,
        });
      } catch (err) {
        res.status(400).json({
          ok: false,
          tested: false,
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'connection_failed',
          },
        });
      }
      return;
    }

    if (body.storageChoice === 'sql' && body.confirmDangerous !== true) {
      res.status(400).json({
        error: {
          message: 'confirmDangerous: true is required to switch storage.',
          type: 'confirmation_required',
        },
      });
      return;
    }

    writeRuntimeConfig(current.dataDir, nextRuntime);

    // Rebuild Config from disk + env
    const refreshed = loadConfig();
    // loadConfig already applied runtime file; ensure choice matches save
    refreshed.storageChoice = nextRuntime.storageChoice;
    refreshed.storageBackend = storageChoiceToBackend(nextRuntime.storageChoice);
    refreshed.supabaseUrl = nextRuntime.supabaseUrl || refreshed.supabaseUrl;
    refreshed.supabaseServiceRoleKey =
      nextRuntime.supabaseServiceRoleKey || refreshed.supabaseServiceRoleKey;
    refreshed.encryptionKey =
      process.env.ENCRYPTION_KEY?.trim() ||
      nextRuntime.encryptionKey ||
      refreshed.encryptionKey;
    refreshed.rateBackend = nextRuntime.rateBackend;
    refreshed.redisUrl = nextRuntime.redisUrl || refreshed.redisUrl;

    try {
      await reinitStorage(refreshed);
    } catch (err) {
      // Roll back file to previous so next boot is consistent
      writeRuntimeConfig(current.dataDir, prev);
      setActiveConfig(current);
      throw err;
    }

    const storage = getStorage();
    res.json({
      ok: true,
      message:
        nextRuntime.storageChoice === 'sql'
          ? 'Switched to SQL (Supabase). Provider keys are encrypted at rest.'
          : 'Switched to Local (SQLite).',
      current: {
        choice: refreshed.storageChoice,
        backend: storage.config.backend,
        rateBackend: storage.rate.backend,
      },
      form: maskRuntimeConfig(readRuntimeConfig(refreshed.dataDir)),
      apiKeyPreview: maskSecret(await storage.config.getUnifiedApiKey()),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.get('/tunnel', (_req, res) => {
  syncTunnelMetaFromConfig();
  res.json(tunnelPublicPayload(getTunnelStatus()));
});

settingsRouter.put('/tunnel', async (req, res, next) => {
  try {
    const schema = z.object({
      enabled: z.boolean().optional(),
      autoStart: z.boolean().optional(),
      token: z.string().min(20).nullable().optional(),
      hostname: z.string().max(253).nullable().optional(),
      clearToken: z.boolean().optional(),
      /** After save: start | stop | none */
      action: z.enum(['start', 'stop', 'none']).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const body = parsed.data;
    const config = getActiveConfig();
    const prev = readRuntimeConfig(config.dataDir).tunnel;

    let token = prev.token;
    if (body.clearToken) token = null;
    else if (body.token !== undefined && body.token !== null) {
      token = sealTunnelToken(body.token.trim());
    }

    let hostname = prev.hostname;
    if (body.hostname !== undefined) {
      hostname = body.hostname?.trim().replace(/^https?:\/\//, '') || null;
    }

    const enabled = body.enabled ?? prev.enabled;
    const autoStart = body.autoStart ?? prev.autoStart;

    updateTunnelConfig(config.dataDir, {
      enabled,
      autoStart,
      token,
      hostname,
    });

    const action = body.action ?? 'none';

    if (action === 'stop' || (enabled === false && getTunnelStatus().running)) {
      await stopTunnel();
    } else if (action === 'start') {
      if (!enabled) updateTunnelConfig(config.dataDir, { enabled: true });
      await startTunnelFromSavedConfig();
    }

    syncTunnelMetaFromConfig();
    res.json({
      ok: true,
      message:
        action === 'start'
          ? 'Tunnel started (token connector).'
          : action === 'stop'
            ? 'Tunnel stopped.'
            : 'Tunnel settings saved.',
      tunnel: tunnelPublicPayload(getTunnelStatus()),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post('/tunnel/start', async (_req, res, next) => {
  try {
    const config = getActiveConfig();
    updateTunnelConfig(config.dataDir, { enabled: true });
    const status = await startTunnelFromSavedConfig();
    res.json({
      ok: true,
      message: 'Tunnel started.',
      tunnel: tunnelPublicPayload(status),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post('/tunnel/stop', async (_req, res, next) => {
  try {
    const config = getActiveConfig();
    updateTunnelConfig(config.dataDir, { enabled: false });
    const status = await stopTunnel();
    syncTunnelMetaFromConfig();
    res.json({
      ok: true,
      message: 'Tunnel stopped.',
      tunnel: tunnelPublicPayload(status),
    });
  } catch (err) {
    next(err);
  }
});
