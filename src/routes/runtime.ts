import { Router } from 'express';
import { listAgents, listProviders, getActiveMode } from '../db/index.js';
import { MODE_PROFILES } from '../types.js';
import { requireControlSnapshot } from '../middleware/requireControlSnapshot.js';
import { getControlHealth } from '../storage/index.js';
import { getActiveConfig } from '../lib/config.js';
import { isSetupRequired } from '../lib/admin-auth.js';
import { getAdminAuthStoreHealth } from '../lib/admin-auth-store.js';
import { HUB_VERSION } from '../lib/version.js';

export const runtimeRouter = Router();

function healthPayload() {
  const control = getControlHealth();
  const authStore = getAdminAuthStoreHealth();
  const config = getActiveConfig();
  const setupRequired = isSetupRequired();
  const warnings: string[] = [];
  if (!authStore.ready) warnings.push('auth_migration_incomplete');
  else if (setupRequired && config.setupTokenState === 'missing') {
    warnings.push('setup_token_missing');
  } else if (setupRequired && config.setupTokenState === 'invalid') {
    warnings.push('setup_token_invalid');
  }
  return {
    ok: true,
    status: 'healthy',
    service: 'Helmora AI',
    version: HUB_VERSION,
    controlState: control.controlPlane,
    servingReady: control.servingReady,
    recoveryReady: control.recoveryReady,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

runtimeRouter.get('/health', (_req, res) => {
  res.json(healthPayload());
});

/** SPA / proxy alias — same payload as GET /health */
runtimeRouter.get('/api/health', (_req, res) => {
  res.json(healthPayload());
});

runtimeRouter.get('/ready', (_req, res) => {
  const control = getControlHealth();
  const authStore = getAdminAuthStoreHealth();
  const config = getActiveConfig();
  const setupUnavailable =
    isSetupRequired() && config.setupTokenState !== 'valid';
  const authReady = authStore.ready && !setupUnavailable;
  const ready = control.servingReady && authReady;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    status: ready ? 'ready' : 'not_ready',
    service: 'Helmora AI',
    version: HUB_VERSION,
    controlState: control.controlPlane,
    servingReady: control.servingReady,
    recoveryReady: control.recoveryReady,
    ...(!authReady
      ? {
          error: {
            type: authStore.ready
              ? 'setup_unavailable'
              : 'auth_migration_incomplete',
            message: authStore.ready
              ? 'Admin setup is unavailable until HELMORA_SETUP_TOKEN is configured.'
              : 'Authentication storage migration is incomplete.',
          },
        }
      : {}),
  });
});

runtimeRouter.get('/state', requireControlSnapshot, async (_req, res, next) => {
  try {
    const agents = (await listAgents()).filter((a) => a.enabled);
    const active: Record<string, string> = {};
    for (const agent of agents) {
      active[agent.id] = agent.model;
    }

    const mode = await getActiveMode();
    res.json({
      profileName: 'helmora',
      registry_profile: 'helmora',
      profile: 'helmora',
      active,
      identity: {
        name: 'Helmora Office',
        role: 'coordinator',
        lane: 'helmora',
        model_id: agents.find((a) => a.id === 'coordinator')?.model ?? 'auto',
        description:
          'Multi-role office agents (Boss, Dev, Ana, Scout, Ops, Review) with per-desk model/mode.',
      },
      runtime: {
        name: 'Helmora AI',
        version: HUB_VERSION,
        vendor: 'Helmora.ai',
        status: 'running',
        active_model: mode,
        governance: MODE_PROFILES[mode].label,
      },
      agents: agents.map((a) => ({
        id: a.id,
        nickname: a.nickname,
        model: a.model,
        mode: a.mode,
        deskId: a.deskId,
        enabled: a.enabled,
      })),
      mode,
    });
  } catch (err) {
    next(err);
  }
});

runtimeRouter.get('/registry', requireControlSnapshot, async (_req, res, next) => {
  try {
    const providers = (await listProviders()).filter((p) => p.enabled);
    const agents = (await listAgents()).filter((a) => a.enabled);
    const models: Record<string, { id: string; provider: string; tier: number }> = {
      auto: { id: 'auto', provider: 'helmora', tier: 0 },
    };

    for (const p of providers) {
      if (p.defaultModel) {
        models[p.defaultModel] = {
          id: p.defaultModel,
          provider: p.id,
          tier: p.tier,
        };
      }
    }

    for (const agent of agents) {
      if (agent.model && agent.model !== 'auto') {
        models[agent.model] = {
          id: agent.model,
          provider: agent.id,
          tier: 0,
        };
      }
    }

    res.json({ models });
  } catch (err) {
    next(err);
  }
});
