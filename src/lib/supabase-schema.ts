import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-relative path shown in docs and API hints. */
export const SUPABASE_SCHEMA_REL_PATH = 'sql/supabase-schema.sql';

export const SUPABASE_SCHEMA_APPLY_HINT =
  'Open Supabase Dashboard → SQL Editor → paste and run sql/supabase-schema.sql, then Test Connection in Helmora Settings. Legacy ctrlhub_* installs: run sql/rename-ctrlhub-to-helmora.sql once.';

const SCHEMA_FILE_NAME = 'supabase-schema.sql';

export type SupabaseControlFailureCode =
  | 'schema_incomplete'
  | 'unauthorized'
  | 'throttled'
  | 'timeout'
  | 'unreachable'
  | 'remote_unavailable'
  | 'remote_error';

export class SupabaseControlError extends Error {
  readonly degradable = true;

  constructor(
    readonly operation: string,
    readonly code: SupabaseControlFailureCode,
    readonly capability: string | null,
    message: string
  ) {
    super(message);
    this.name = 'SupabaseControlError';
  }
}

export function isDegradableSupabaseControlError(
  error: unknown
): error is SupabaseControlError {
  return error instanceof SupabaseControlError && error.degradable;
}

/**
 * Resolve schema SQL for both `tsx src/` and `node dist/` (cwd + module-relative).
 * Docker runtime copies `sql/` next to the app root.
 */
export function resolveSupabaseSchemaPath(): string | null {
  const candidates: string[] = [];

  const cwd = process.cwd();
  candidates.push(path.join(cwd, 'sql', SCHEMA_FILE_NAME));
  candidates.push(path.join(cwd, '..', 'sql', SCHEMA_FILE_NAME));

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/lib or dist/lib → repo root
    candidates.push(path.resolve(here, '..', '..', 'sql', SCHEMA_FILE_NAME));
    // dist/lib when sql was copied under dist/sql (unusual)
    candidates.push(path.resolve(here, '..', 'sql', SCHEMA_FILE_NAME));
  } catch {
    // ignore — import.meta.url unavailable in odd runners
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

export function readSupabaseSchemaSql(): { sql: string; path: string } {
  const resolved = resolveSupabaseSchemaPath();
  if (!resolved) {
    throw new Error(
      `Could not find ${SUPABASE_SCHEMA_REL_PATH}. Ensure the Hub package includes the sql/ folder (Docker copies it; local runs from HelmoraHub root).`
    );
  }
  return { sql: fs.readFileSync(resolved, 'utf8'), path: resolved };
}

export function isSupabaseMissingTableError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('schema cache') ||
    m.includes('could not find the table') ||
    (m.includes('relation') && m.includes('does not exist')) ||
    (m.includes('table') && m.includes('does not exist'))
  );
}

function missingCapability(message: string): string | null {
  const helmoraTable = message.match(/\b(helmora_[a-z0-9_]+)\b/i);
  if (helmoraTable?.[1]) return helmoraTable[1].toLowerCase();
  const relation = message.match(/relation\s+["'](?:public\.)?([^"']+)["']/i);
  return relation?.[1]?.toLowerCase() ?? null;
}

function classifySupabaseControlFailure(message: string): SupabaseControlFailureCode {
  const normalized = message.toLowerCase();
  if (isSupabaseMissingTableError(message)) return 'schema_incomplete';
  if (
    normalized.includes('401') ||
    normalized.includes('403') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('jwt') ||
    normalized.includes('invalid api key')
  ) {
    return 'unauthorized';
  }
  if (
    normalized.includes('429') ||
    normalized.includes('too many requests') ||
    normalized.includes('rate limit')
  ) {
    return 'throttled';
  }
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('aborterror')
  ) {
    return 'timeout';
  }
  if (
    normalized.includes('fetch failed') ||
    normalized.includes('network') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('socket')
  ) {
    return 'unreachable';
  }
  if (
    /\b5\d\d\b/.test(normalized) ||
    normalized.includes('service unavailable') ||
    normalized.includes('bad gateway')
  ) {
    return 'remote_unavailable';
  }
  return 'remote_error';
}

/** Enrich Supabase PostgREST errors when control-plane tables were never applied. */
export function formatSupabaseControlError(
  operation: string,
  message: string
): SupabaseControlError {
  const code = classifySupabaseControlFailure(message);
  const capability = code === 'schema_incomplete' ? missingCapability(message) : null;
  if (code === 'schema_incomplete') {
    return new SupabaseControlError(
      operation,
      code,
      capability,
      `Supabase ${operation}: control-plane capability ${capability ?? 'unknown'} is missing. ` +
        `Apply ${SUPABASE_SCHEMA_REL_PATH} in the Supabase SQL Editor first ` +
        `(or GET /api/settings/storage/schema). ${SUPABASE_SCHEMA_APPLY_HINT}`
    );
  }
  return new SupabaseControlError(
    operation,
    code,
    null,
    `Supabase ${operation}: ${code}`
  );
}

export function supabaseSchemaApiHints() {
  return {
    path: SUPABASE_SCHEMA_REL_PATH,
    applyHint: SUPABASE_SCHEMA_APPLY_HINT,
    endpoint: '/api/settings/storage/schema',
  };
}
