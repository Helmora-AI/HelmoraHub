import { Router } from 'express';
import { z } from 'zod';
import { extractBearerToken } from '../lib/auth.js';
import { getActiveConfig } from '../lib/config.js';
import { maskSecret } from '../lib/crypto.js';
import { isHelRecoverySessionToken } from '../lib/hel-env.js';
import {
  readRecoverySupabaseCredential,
  recoverySupabaseCredentialConfigured,
  writeRecoverySupabaseCredential,
} from '../lib/recovery-control-vault.js';
import {
  readRuntimeConfig,
  writeRuntimeConfig,
} from '../lib/runtime-config.js';
import {
  probeSupabaseControlCapabilities,
  readSupabaseSchemaSql,
  supabaseSchemaApiHints,
  SUPABASE_SCHEMA_APPLY_HINT,
  SUPABASE_SCHEMA_REL_PATH,
  type SupabaseCapabilityProbeClient,
} from '../lib/supabase-schema.js';
import { requireRecovery } from '../middleware/requireRecovery.js';
import { getControlHealth } from '../storage/index.js';

export const recoveryRouter = Router();

recoveryRouter.use((req, _res, next) => {
  const pathName = req.originalUrl.split('?')[0] ?? req.path;
  if (
    (req.method === 'GET' && pathName === '/api/storage/health') ||
    (req.method === 'POST' && pathName === '/api/storage/test')
  ) {
    next();
    return;
  }
  const bearer = extractBearerToken(req.header('authorization'));
  if (!bearer || !isHelRecoverySessionToken(bearer)) {
    next('router');
    return;
  }
  next();
});

recoveryRouter.use(requireRecovery);

function maskedRecoveryStorage() {
  const config = getActiveConfig();
  const runtime = readRuntimeConfig(config.dataDir);
  return {
    current: {
      choice: config.storageChoice,
      control: getControlHealth(),
    },
    form: {
      storageChoice: runtime.storageChoice,
      supabaseUrl: runtime.supabaseUrl || config.supabaseUrl,
      supabaseServiceRoleConfigured: Boolean(config.supabaseServiceRoleKey),
      supabaseServiceRoleHint: maskSecret(config.supabaseServiceRoleKey),
      encryptionKeyConfigured: Boolean(config.encryptionKey),
      credentialEnvironmentManaged: Boolean(
        process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
      ),
      credentialInRecoveryVault: recoverySupabaseCredentialConfigured(
        config.dataDir
      ),
    },
    schema: supabaseSchemaApiHints(),
  };
}

recoveryRouter.get('/storage/health', (_req, res) => {
  const health = getControlHealth();
  res.json({
    ok: true,
    controlState: health.controlPlane,
    servingReady: health.servingReady,
    recoveryReady: health.recoveryReady,
    snapshotAvailable: health.snapshotAvailable,
    degradedReason: health.degradedReason,
    degradedCapability: health.degradedCapability,
  });
});

recoveryRouter.post('/storage/test', async (req, res) => {
  try {
    const parsed = z
      .object({
        supabaseUrl: z.string().url().optional(),
        supabaseServiceRoleKey: z.string().min(16).max(4096).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { type: 'validation_error', message: parsed.error.message },
      });
      return;
    }

    const config = getActiveConfig();
    const supabaseUrl = parsed.data.supabaseUrl || config.supabaseUrl;
    const serviceRoleKey =
      parsed.data.supabaseServiceRoleKey || config.supabaseServiceRoleKey;
    if (!supabaseUrl || !serviceRoleKey) {
      res.status(400).json({
        error: {
          type: 'recovery_storage_incomplete',
          message: 'Supabase URL and Service Role Key are required for testing.',
        },
      });
      return;
    }

    const { createClient } = await import('@supabase/supabase-js');
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'Cache-Control': 'no-cache' } },
    }) as unknown as SupabaseCapabilityProbeClient;
    const result = await probeSupabaseControlCapabilities(client);
    res.json({
      ok: result.ok,
      tested: true,
      cache: 'bypass',
      capabilities: result.capabilities,
      schema: supabaseSchemaApiHints(),
    });
  } catch {
    res.status(400).json({
      ok: false,
      tested: false,
      error: {
        type: 'connection_failed',
        message: 'Supabase capability testing could not be completed.',
      },
    });
  }
});

recoveryRouter.get('/settings/storage', (_req, res) => {
  res.json(maskedRecoveryStorage());
});

recoveryRouter.get('/settings/storage/schema', (_req, res) => {
  try {
    const { sql } = readSupabaseSchemaSql();
    res.json({
      path: SUPABASE_SCHEMA_REL_PATH,
      applyHint: SUPABASE_SCHEMA_APPLY_HINT,
      sql,
    });
  } catch (error) {
    res.status(500).json({
      error: {
        type: 'schema_unavailable',
        message: error instanceof Error ? error.message : 'Schema unavailable',
      },
    });
  }
});

const credentialOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retain') }).strict(),
  z.object({ kind: z.literal('replace'), value: z.string().min(16).max(4096) }).strict(),
]);

const storageModeOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retain') }).strict(),
  z.object({ kind: z.literal('switch_to_sql') }).strict(),
]);

recoveryRouter.put('/settings/storage', (req, res) => {
  const parsed = z
    .object({
      supabaseUrl: z.string().url().optional(),
      supabaseCredentialOperation: credentialOperationSchema.optional(),
      storageModeOperation: storageModeOperationSchema.optional(),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { type: 'validation_error', message: parsed.error.message },
    });
    return;
  }

  const config = getActiveConfig();
  const previous = readRuntimeConfig(config.dataDir);
  const credentialOperation = parsed.data.supabaseCredentialOperation;
  const modeOperation = parsed.data.storageModeOperation;
  const urlChanged =
    parsed.data.supabaseUrl !== undefined &&
    parsed.data.supabaseUrl !== previous.supabaseUrl;
  const credentialChanged = credentialOperation?.kind === 'replace';
  const modeChanged =
    modeOperation?.kind === 'switch_to_sql' && previous.storageChoice !== 'sql';
  if (!urlChanged && !credentialChanged && !modeChanged) {
    res.status(400).json({
      error: {
        type: 'no_changes',
        message: 'At least one storage repair field must change.',
      },
    });
    return;
  }

  if (
    credentialOperation?.kind === 'replace' &&
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  ) {
    res.status(409).json({
      error: {
        type: 'credential_env_managed',
        message: 'SUPABASE_SERVICE_ROLE_KEY is managed by the environment.',
      },
    });
    return;
  }

  if (credentialOperation?.kind === 'replace' && !config.encryptionKey) {
    res.status(409).json({
      error: {
        type: 'encryption_key_unavailable',
        message: 'The existing ENCRYPTION_KEY is required for credential repair.',
      },
    });
    return;
  }

  const next = {
    ...previous,
    storageChoice:
      modeOperation?.kind === 'switch_to_sql' ? ('sql' as const) : previous.storageChoice,
    supabaseUrl:
      parsed.data.supabaseUrl !== undefined
        ? parsed.data.supabaseUrl
        : previous.supabaseUrl,
    supabaseServiceRoleKey:
      credentialOperation?.kind === 'replace'
        ? null
        : previous.supabaseServiceRoleKey,
  };

  const effectiveUrl = next.supabaseUrl || config.supabaseUrl;
  const effectiveCredentialConfigured = Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
      (credentialOperation?.kind === 'replace' && credentialOperation.value) ||
      previous.supabaseServiceRoleKey ||
      readRecoverySupabaseCredential(config.dataDir, config.encryptionKey)
  );
  if (next.storageChoice === 'sql' && (!effectiveUrl || !effectiveCredentialConfigured)) {
    res.status(400).json({
      error: {
        type: 'recovery_storage_incomplete',
        message: 'Switching to SQL requires a Supabase URL and configured credential.',
      },
    });
    return;
  }

  if (credentialOperation?.kind === 'replace') {
    writeRecoverySupabaseCredential(
      config.dataDir,
      config.encryptionKey!,
      credentialOperation.value
    );
  }
  writeRuntimeConfig(config.dataDir, next);

  res.json({
    ok: true,
    restartRequired: true,
    storage: maskedRecoveryStorage(),
  });
});
