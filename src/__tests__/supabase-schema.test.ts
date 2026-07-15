import { describe, expect, it } from 'vitest';
import {
  formatSupabaseControlError,
  isDegradableSupabaseControlError,
  isSupabaseMissingTableError,
  readSupabaseSchemaSql,
  SupabaseControlError,
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
      'getConnectorCredentialRecord',
      "Could not find the table 'public.helmora_connector_credentials' in the schema cache"
    );
    expect(err).toBeInstanceOf(SupabaseControlError);
    expect(err).toMatchObject({
      code: 'schema_incomplete',
      operation: 'getConnectorCredentialRecord',
      capability: 'helmora_connector_credentials',
      degradable: true,
    });
    expect(err.message).toContain('sql/supabase-schema.sql');
    expect(err.message).toContain('getConnectorCredentialRecord');
    expect(err.message).toContain('/api/settings/storage/schema');
  });

  it.each([
    ['JWT expired: service_role_secret_should_not_leak', 'unauthorized'],
    ['HTTP 429 Too Many Requests', 'throttled'],
    ['request timed out after 10000ms', 'timeout'],
    ['TypeError: fetch failed ECONNREFUSED 127.0.0.1', 'unreachable'],
    ['HTTP 503 Service Unavailable', 'remote_unavailable'],
  ] as const)('normalizes and redacts degradable remote failure %s', (message, code) => {
    const err = formatSupabaseControlError('bootstrap', message);

    expect(err).toBeInstanceOf(SupabaseControlError);
    expect(err).toMatchObject({ code, operation: 'bootstrap', degradable: true });
    expect(err.message).not.toContain('service_role_secret_should_not_leak');
    expect(isDegradableSupabaseControlError(err)).toBe(true);
  });

  it('does not classify local SQLite or encryption errors as degradable', () => {
    expect(isDegradableSupabaseControlError(new Error('SQLITE_CORRUPT'))).toBe(false);
    expect(isDegradableSupabaseControlError(new Error('Unsupported encryption key'))).toBe(false);
  });

  it('reads schema SQL from the repo sql/ folder', () => {
    const { sql, path: resolved } = readSupabaseSchemaSql();
    expect(resolved.replace(/\\/g, '/')).toMatch(/sql\/supabase-schema\.sql$/);
    expect(sql).toContain('create table if not exists public.helmora_settings');
    expect(sql).toContain('helmora_providers');
    expect(sql).toContain('create table if not exists public.helmora_connector_credentials');
    expect(sql).toContain('encrypted_secret text not null');
    expect(sql).toContain('create table if not exists public.helmora_tool_runs');
    expect(sql).toContain('alter table public.helmora_tool_runs enable row level security');
    expect(sql).not.toContain('raw_url text');
  });

  it('exposes API hints', () => {
    const hints = supabaseSchemaApiHints();
    expect(hints.path).toBe('sql/supabase-schema.sql');
    expect(hints.endpoint).toBe('/api/settings/storage/schema');
    expect(hints.applyHint.length).toBeGreaterThan(20);
  });
});
