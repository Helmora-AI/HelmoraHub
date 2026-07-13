import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-relative path shown in docs and API hints. */
export const SUPABASE_SCHEMA_REL_PATH = 'sql/supabase-schema.sql';

export const SUPABASE_SCHEMA_APPLY_HINT =
  'Open Supabase Dashboard → SQL Editor → paste and run sql/supabase-schema.sql, then Test Connection in Helmora Settings. Legacy ctrlhub_* installs: run sql/rename-ctrlhub-to-helmora.sql once.';

const SCHEMA_FILE_NAME = 'supabase-schema.sql';

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

/** Enrich Supabase PostgREST errors when control-plane tables were never applied. */
export function formatSupabaseControlError(operation: string, message: string): Error {
  if (isSupabaseMissingTableError(message)) {
    return new Error(
      `Supabase ${operation}: control-plane tables missing (${message}). ` +
        `Apply ${SUPABASE_SCHEMA_REL_PATH} in the Supabase SQL Editor first ` +
        `(or GET /api/settings/storage/schema). ${SUPABASE_SCHEMA_APPLY_HINT}`
    );
  }
  return new Error(`Supabase ${operation}: ${message}`);
}

export function supabaseSchemaApiHints() {
  return {
    path: SUPABASE_SCHEMA_REL_PATH,
    applyHint: SUPABASE_SCHEMA_APPLY_HINT,
    endpoint: '/api/settings/storage/schema',
  };
}
