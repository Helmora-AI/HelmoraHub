import { Router } from 'express';
import { z } from 'zod';
import { getConfigStore } from '../storage/index.js';
import {
  getPricingForModel,
  listCatalogModels,
  setPricingOverrides,
} from '../pricing/cost.js';
import { usageCostUsd } from '../keys/types.js';

export const keysRouter = Router();

keysRouter.get('/', async (_req, res, next) => {
  try {
    const keys = await getConfigStore().listApiKeys();
    res.json({ keys });
  } catch (err) {
    next(err);
  }
});

keysRouter.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(120),
      keyEnv: z.enum(['dev', 'pro']),
      budgetUsd: z.number().positive().nullable().optional(),
      expiresAt: z.number().int().positive().nullable().optional(),
      /** Relative expiry helper: days from now; ignored if expiresAt set */
      expiresInDays: z.number().positive().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    let expiresAt = parsed.data.expiresAt ?? null;
    if (expiresAt == null && parsed.data.expiresInDays != null) {
      expiresAt = Date.now() + parsed.data.expiresInDays * 86400000;
    }

    const created = await getConfigStore().createApiKey({
      name: parsed.data.name,
      keyEnv: parsed.data.keyEnv,
      budgetUsd: parsed.data.budgetUsd ?? null,
      expiresAt,
    });

    res.status(201).json({
      ok: true,
      message: 'API key created. Copy the plaintext key now — it will not be shown again.',
      key: created.record,
      plaintext: created.plaintext,
    });
  } catch (err) {
    next(err);
  }
});

keysRouter.patch('/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(120).optional(),
      budgetUsd: z.number().positive().nullable().optional(),
      expiresAt: z.number().int().positive().nullable().optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const updated = await getConfigStore().updateApiKey(req.params.id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ ok: true, key: updated });
  } catch (err) {
    next(err);
  }
});

keysRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await getConfigStore().deleteApiKey(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export const pricingRouter = Router();

pricingRouter.get('/', async (req, res, next) => {
  try {
    const model = typeof req.query.model === 'string' ? req.query.model : null;
    const overrides = await getConfigStore().getPricingOverrides();
    if (model) {
      res.json({
        model,
        pricing: getPricingForModel(model),
        override: overrides[model] ?? null,
      });
      return;
    }
    res.json({
      overrides,
      catalogSample: listCatalogModels(80),
      note: 'Rates are USD per 1M tokens. Unknown/free models resolve to $0.',
    });
  } catch (err) {
    next(err);
  }
});

pricingRouter.put('/', async (req, res, next) => {
  try {
    const schema = z.object({
      overrides: z.record(
        z.object({
          input: z.number(),
          output: z.number(),
          cached: z.number().optional(),
          reasoning: z.number().optional(),
          cache_creation: z.number().optional(),
        })
      ),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    await getConfigStore().setPricingOverrides(parsed.data.overrides);
    setPricingOverrides(parsed.data.overrides);
    res.json({ ok: true, overrides: parsed.data.overrides });
  } catch (err) {
    next(err);
  }
});

export const usageRouter = Router();

usageRouter.get('/', async (req, res, next) => {
  try {
    const apiKeyId = typeof req.query.keyId === 'string' ? req.query.keyId : undefined;
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const sourceRaw = typeof req.query.source === 'string' ? req.query.source : undefined;
    const source =
      sourceRaw === 'api' || sourceRaw === 'admin_chat' ? sourceRaw : undefined;
    // Fetch a wider window when filtering by source client-side-equivalent on server
    const fetchLimit = source ? Math.min(1000, Math.max(limit * 5, 200)) : limit;
    let events = await getConfigStore().listUsage({ apiKeyId, limit: fetchLimit });
    if (source) {
      events = events.filter((e) => e.source === source);
    }
    events = events.slice(0, limit);
    res.json({
      events: events.map((e) => ({
        ...e,
        costUsd: usageCostUsd(e),
      })),
    });
  } catch (err) {
    next(err);
  }
});
