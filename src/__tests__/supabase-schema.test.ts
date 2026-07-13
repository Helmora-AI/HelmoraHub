import { describe, expect, it } from 'vitest';
import {
  formatSupabaseControlError,
  isSupabaseMissingTableError,
  readSupabaseSchemaSql,
  supabaseSchemaApiHints,
} from '../lib/supabase-schema.js';

describe('supabase-schema helpers', () => {
  it('detects PostgREST missing-table / schema cache errors', () => {
    expect(
      isSupabaseMissingTableError(
        "Could not find the table 'public.helmora_settings' in the schema cache"
      )
    ).toBe(true);
    expect(isSupabaseMissingTableError('relation "helmora_settings" does not exist')).toBe(true);
    expect(isSupabaseMissingTableError('JWT expired')).toBe(false);
  });

  it('enriches missing-table errors with apply instructions', () => {
    const err = formatSupabaseControlError(
      'getSetting',
      "Could not find the table 'public.helmora_settings' in the schema cache"
    );
    expect(err.message).toContain('sql/supabase-schema.sql');
    expect(err.message).toContain('getSetting');
    expect(err.message).toContain('/api/settings/storage/schema');
  });

  it('reads schema SQL from the repo sql/ folder', () => {
    const { sql, path: resolved } = readSupabaseSchemaSql();
    expect(resolved.replace(/\\/g, '/')).toMatch(/sql\/supabase-schema\.sql$/);
    expect(sql).toContain('create table if not exists public.helmora_settings');
    expect(sql).toContain('helmora_providers');
  });

  it('exposes API hints', () => {
    const hints = supabaseSchemaApiHints();
    expect(hints.path).toBe('sql/supabase-schema.sql');
    expect(hints.endpoint).toBe('/api/settings/storage/schema');
    expect(hints.applyHint.length).toBeGreaterThan(20);
  });
});
