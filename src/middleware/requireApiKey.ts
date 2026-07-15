import type { Request, Response, NextFunction } from 'express';
import { extractBearerToken } from '../lib/auth.js';
import { helEnv } from '../lib/hel-env.js';
import { getConfigStore } from '../storage/index.js';
import type { ApiKeyRecord } from '../keys/types.js';
import { hashApiKey } from '../keys/generate.js';
import { isRecoveryCredentialToken } from '../lib/admin-auth.js';

export type ApiKeyAuthContext = {
  apiKey: ApiKeyRecord;
};

declare global {
  namespace Express {
    interface Request {
      ctrlApiKey?: ApiKeyAuthContext;
    }
  }
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const bearer = extractBearerToken(req.header('authorization'));
    const headerKey = req.header('x-api-key')?.trim() || null;
    const token = bearer || headerKey;

    if (!token) {
      res.status(401).json({
        error: {
          message:
            'Invalid or missing API key. Use Authorization: Bearer hel_dev_… or hel_pro_…',
          type: 'invalid_api_key',
        },
      });
      return;
    }

    if (isRecoveryCredentialToken(token)) {
      res.status(401).json({
        error: {
          message: 'Recovery credentials cannot authenticate model requests.',
          type: 'invalid_api_key',
        },
      });
      return;
    }

    const store = getConfigStore();
    let record = await store.findApiKeyByHash(hashApiKey(token));

    // Accept HELMORA_API_KEY env even before/without row (bootstrap edge)
    if (!record && helEnv('API_KEY') === token) {
      const keys = await store.listApiKeys();
      if (keys.length > 0) {
        record = await store.getApiKeyById(keys[0].id);
      }
    }

    if (!record || !record.enabled) {
      res.status(401).json({
        error: {
          message:
            'Invalid or missing API key. Use Authorization: Bearer hel_dev_… or hel_pro_…',
          type: 'invalid_api_key',
        },
      });
      return;
    }

    if (record.expiresAt != null && record.expiresAt <= Date.now()) {
      res.status(401).json({
        error: {
          message: 'API key expired',
          type: 'api_key_expired',
        },
      });
      return;
    }

    if (record.budgetUsd != null && record.spentUsd >= record.budgetUsd) {
      res.status(429).json({
        error: {
          message: 'API key budget exceeded',
          type: 'insufficient_quota',
          spent_usd: record.spentUsd,
          budget_usd: record.budgetUsd,
        },
      });
      return;
    }

    req.ctrlApiKey = { apiKey: record };
    await store.touchApiKey(record.id);
    next();
  } catch (err) {
    next(err);
  }
}
