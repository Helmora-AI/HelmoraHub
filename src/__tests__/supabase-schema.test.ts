import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

  it('ships a standalone idempotent Tools migration for existing Supabase installs', () => {
    const migrationPath = path.resolve(
      process.cwd(),
      'sql/migrations/004_tools_control_plane.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase();

    expect(sql).toContain(
      'create table if not exists public.helmora_connector_credentials'
    );
    expect(sql).toContain('create table if not exists public.helmora_tool_runs');
    expect(sql).toContain('create index if not exists helmora_tool_runs_created_idx');
    expect(sql).toContain(
      'alter table public.helmora_connector_credentials enable row level security'
    );
    expect(sql).toContain('alter table public.helmora_tool_runs enable row level security');
    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('truncate');
  });

  it('ships atomic service-role-only chat RPCs in canonical schema and migration 005', () => {
    const canonical = fs.readFileSync(
      path.resolve(process.cwd(), 'sql/supabase-schema.sql'),
      'utf8'
    ).toLowerCase();
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'sql/migrations/005_atomic_chat_messages.sql'),
      'utf8'
    ).toLowerCase();

    for (const sql of [canonical, migration]) {
      expect(sql).toContain('chat_session_not_found');
      expect(sql).toContain('for update');
      expect(sql).toContain('helmora_chat_messages_session_seq_uidx');
      expect(sql).toContain('create or replace function public.append_chat_message_atomic');
      expect(sql).toContain('create or replace function public.replace_chat_messages_atomic');
      expect(sql).toContain('security invoker');
      expect(sql).toContain("set search_path = ''");
      expect(sql).toContain(
        'revoke all on function public.append_chat_message_atomic(text, jsonb) from public, anon, authenticated'
      );
      expect(sql).toContain(
        'revoke all on function public.replace_chat_messages_atomic(text, jsonb) from public, anon, authenticated'
      );
      expect(sql).toContain(
        'grant execute on function public.append_chat_message_atomic(text, jsonb) to service_role'
      );
      expect(sql).toContain(
        'grant execute on function public.replace_chat_messages_atomic(text, jsonb) to service_role'
      );
      expect(sql).not.toContain('delete from public.helmora_chat_messages\n  where session_id = p_session_id;\n\n  -- validate');
      expect(sql).not.toMatch(/\bexecute\s+(?:format\s*\(|['$])/);
    }
    expect(migration).toContain('duplicate (session_id, seq) rows');
    expect(migration).not.toContain('truncate ');
  });

  it('ships bounded redacted chat tool activities in canonical schema and migration 006', () => {
    const canonical = fs.readFileSync(
      path.resolve(process.cwd(), 'sql/supabase-schema.sql'),
      'utf8'
    ).toLowerCase();
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'sql/migrations/006_chat_tool_activities.sql'),
      'utf8'
    ).toLowerCase();

    for (const sql of [canonical, migration]) {
      expect(sql).toContain("tool_activities jsonb not null default '[]'::jsonb");
      expect(sql).toContain('create or replace function public.helmora_chat_tool_activities_valid');
      expect(sql).toContain('jsonb_array_length(p_activities) <= 20');
      expect(sql).toContain("coalesce(item -> 'toolactivities', '[]'::jsonb)");
      expect(sql).not.toContain('tool_query');
      expect(sql).not.toContain('tool_url');
    }
    expect(migration).toContain('alter table public.helmora_chat_messages');
    expect(migration).not.toContain('drop table');
    expect(migration).not.toContain('truncate ');
  });

  it('exposes API hints', () => {
    const hints = supabaseSchemaApiHints();
    expect(hints.path).toBe('sql/supabase-schema.sql');
    expect(hints.endpoint).toBe('/api/settings/storage/schema');
    expect(hints.applyHint.length).toBeGreaterThan(20);
  });
});
