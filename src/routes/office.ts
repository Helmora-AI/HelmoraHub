import { Router } from 'express';
import { listAgents, getActiveMode } from '../db/index.js';
import { MODE_PROFILES } from '../types.js';

export const officeRouter = Router();

/** SPA summary of Claw3D-compatible runtime (`/health`, `/state`, `/registry`). */
officeRouter.get('/runtime', async (_req, res, next) => {
  try {
    const agents = await listAgents();
    const enabled = agents.filter((a) => a.enabled);
    const mode = await getActiveMode();
    const active: Record<string, string> = {};
    for (const agent of enabled) {
      active[agent.id] = agent.model;
    }

    res.json({
      ok: true,
      health: {
        ok: true,
        status: 'healthy',
        service: 'Helmora AI',
      },
      state: {
        profileName: 'helmora',
        registry_profile: 'helmora',
        active,
        identity: {
          name: 'Helmora Office',
          role: 'coordinator',
          lane: 'helmora',
          model_id: enabled.find((a) => a.id === 'coordinator')?.model ?? 'auto',
        },
        runtime: {
          name: 'Helmora AI',
          status: 'running',
          active_model: mode,
          governance: MODE_PROFILES[mode].label,
        },
        agents: enabled.map((a) => ({
          id: a.id,
          nickname: a.nickname,
          model: a.model,
          mode: a.mode,
          deskId: a.deskId,
        })),
        mode,
      },
      /** Studio custom runtime URL — point Helmora Office here (Hub root). */
      customRuntimeHint: {
        profile: 'custom',
        paths: ['/health', '/state', '/registry', '/v1/chat/completions'],
        note: 'Helmora Office (Claw3D fork) uses custom runtime → Hub root URL + API key for /v1.',
      },
    });
  } catch (err) {
    next(err);
  }
});
