import { Router } from 'express';
import { listAgents, listProviders, getActiveMode } from '../db/index.js';
import { MODE_PROFILES } from '../types.js';

export const runtimeRouter = Router();

runtimeRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    service: 'Helmora AI',
    version: '0.1.0',
  });
});

/** SPA / proxy alias — same payload as GET /health */
runtimeRouter.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    service: 'Helmora AI',
    version: '0.1.0',
  });
});

runtimeRouter.get('/state', async (_req, res, next) => {
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

runtimeRouter.get('/registry', async (_req, res, next) => {
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
