import type { NextFunction, Request, Response } from 'express';

export class OriginConfigurationError extends Error {
  constructor() {
    super('Invalid Helmora browser origin configuration.');
    this.name = 'OriginConfigurationError';
  }
}

export function normalizeConfiguredOrigin(input: string): string {
  const raw = input.trim();
  if (!raw || raw === '*' || raw.toLowerCase() === 'null') {
    throw new OriginConfigurationError();
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OriginConfigurationError();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OriginConfigurationError();
  }
  if (url.username || url.password) throw new OriginConfigurationError();
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new OriginConfigurationError();
  }
  if (url.hostname.endsWith('.') || raw.includes('*')) {
    throw new OriginConfigurationError();
  }
  return url.origin;
}

export function parseConfiguredOrigins(input: {
  publicUrl?: string | null;
  frontendUrl?: string | null;
  additionalOrigins?: string | null;
}): string[] {
  const rawOrigins = [input.publicUrl, input.frontendUrl].filter(
    (value): value is string => Boolean(value?.trim())
  );
  if (input.additionalOrigins?.trim()) {
    rawOrigins.push(
      ...input.additionalOrigins
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    );
  }
  return [...new Set(rawOrigins.map(normalizeConfiguredOrigin))];
}

const ALLOWED_HEADERS = [
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
].join(', ');

const EXPOSED_HEADERS = [
  'X-Helmora-Identity',
  'X-Helmora-Mini-Role',
  'X-Helmora-Mini-Slot',
  'X-Ctrl-Meta-Model',
  'X-Routed-Via',
].join(', ');

export function browserOriginPolicy(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawOrigin = req.header('origin');
    if (!rawOrigin) {
      next();
      return;
    }

    let normalized: string;
    try {
      normalized = normalizeConfiguredOrigin(rawOrigin);
    } catch {
      res.status(403).json({
        error: {
          type: 'origin_not_allowed',
          message: 'Browser origin is not allowed.',
        },
      });
      return;
    }
    if (!allowed.has(normalized)) {
      res.status(403).json({
        error: {
          type: 'origin_not_allowed',
          message: 'Browser origin is not allowed.',
        },
      });
      return;
    }

    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Origin', normalized);
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
    );
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
