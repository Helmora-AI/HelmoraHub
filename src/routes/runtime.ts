import { Router } from 'express';
import { listAgents, listProviders, getActiveMode } from '../db/index.js';
import { MODE_PROFILES } from '../types.js';
import { requireControlSnapshot } from '../middleware/requireControlSnapshot.js';
import { getControlHealth } from '../storage/index.js';

export const runtimeRouter = Router();

function healthPayload() {
  const control = getControlHealth();
  return {
    ok: true,
    status: 'healthy',
    service: 'Helmora AI',
    version: '0.1.0',
    controlState: control.controlPlane,
    servingReady: control.servingReady,
    recoveryReady: control.recoveryReady,
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
  res.status(control.servingReady ? 200 : 503).json({
    ok: control.servingReady,
    status: control.servingReady ? 'ready' : 'not_ready',
    service: 'Helmora AI',
    version: '0.1.0',
    controlState: control.controlPlane,
    servingReady: control.servingReady,
    recoveryReady: control.recoveryReady,
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
        version: '0.1.0',
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
