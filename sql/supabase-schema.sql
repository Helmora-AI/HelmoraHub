-- Helmora Hub hybrid storage schema for Supabase (Postgres)
-- SOURCE OF TRUTH for control-plane tables (settings, providers, agents, OAuth).
--
-- Apply BEFORE switching Settings → SQL (Supabase):
--   1. Supabase Dashboard → SQL Editor → New query
--   2. Paste this entire file and Run
--   3. Helmora Settings → SQL → Test connection → Apply
--
-- Also available via GET /api/settings/storage/schema (admin).
-- Existing ctrlhub_* installs: run sql/rename-ctrlhub-to-helmora.sql first.
-- See sql/migrations/README.md (no \i — Supabase SQL Editor does not support it).

create table if not exists public.helmora_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.helmora_providers (
  id text primary key,
  label text not null,
  enabled boolean not null default true,
  tier integer not null check (tier in (1, 2, 3)),
  base_url text,
  -- AES-GCM ciphertext only — never store plaintext API keys
  api_key_encrypted text,
  default_model text,
  allowed_modes jsonb not null default '[]'::jsonb,
  capabilities jsonb not null default '[]'::jsonb,
  protocol text not null default 'openai',
  auth_style text not null default 'bearer',
  benchmark_model text,
  pinned_models jsonb not null default '[]'::jsonb,
  verify_status text not null default 'never',
  verify_error text,
  verified_at bigint,
  source text not null default 'builtin',
  catalog_ready boolean not null default true,
  extra_headers jsonb,
  timeout_ms integer,
  updated_at timestamptz not null default now()
);

-- Existing installs: add columns if missing
alter table public.helmora_providers add column if not exists protocol text not null default 'openai';
alter table public.helmora_providers add column if not exists auth_style text not null default 'bearer';
alter table public.helmora_providers add column if not exists benchmark_model text;
alter table public.helmora_providers add column if not exists pinned_models jsonb not null default '[]'::jsonb;
alter table public.helmora_providers add column if not exists verify_status text not null default 'never';
alter table public.helmora_providers add column if not exists verify_error text;
alter table public.helmora_providers add column if not exists verified_at bigint;
alter table public.helmora_providers add column if not exists source text not null default 'builtin';
alter table public.helmora_providers add column if not exists catalog_ready boolean not null default true;
alter table public.helmora_providers add column if not exists extra_headers jsonb;
alter table public.helmora_providers add column if not exists timeout_ms integer;

create index if not exists helmora_providers_tier_idx
  on public.helmora_providers (tier);

create table if not exists public.helmora_agents (
  id text primary key,
  nickname text not null,
  enabled boolean not null default true,
  model text not null default 'auto',
  mode text not null default 'smart',
  desk_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.helmora_connector_credentials (
  connector_id text primary key,
  encrypted_secret text not null,
  encryption_version integer not null check (encryption_version = 1),
  configured_at bigint not null,
  updated_at bigint not null
);

create table if not exists public.helmora_tool_runs (
  id text primary key,
  request_id text not null,
  tool_id text not null,
  connector text not null,
  surface text not null,
  source text not null,
  answer_catalog_id text,
  planner_catalog_id text,
  risk text not null,
  status text not null,
  duration_ms integer,
  source_count integer,
  error_code text,
  created_at bigint not null
);

create index if not exists helmora_tool_runs_created_idx
  on public.helmora_tool_runs (created_at desc, id desc);

-- Lock down: only service_role (server) should access these tables.
alter table public.helmora_settings enable row level security;
alter table public.helmora_providers enable row level security;
alter table public.helmora_agents enable row level security;
alter table public.helmora_connector_credentials enable row level security;
alter table public.helmora_tool_runs enable row level security;

-- No policies for anon/authenticated → denied by default.
-- service_role bypasses RLS.

comment on column public.helmora_providers.api_key_encrypted is
  'AES-256-GCM payload encrypted with ENCRYPTION_KEY; decrypt only in Helmora Hub process memory';

comment on column public.helmora_connector_credentials.encrypted_secret is
  'AES-256-GCM connector credential; never plaintext and never exposed through public DTOs';

-- API keys currently use settings JSON blobs (helmora_settings key api_keys_v1,
-- plus usage_events_v1 / pricing_overrides / api_key_bootstrap) until dedicated
-- Postgres tables land.

-- OAuth credentials + pending PKCE state (hybrid control-plane; mirror of SQLite vault)
alter table public.helmora_providers
  add column if not exists auth_mode text not null default 'none';

-- Backfill once: paste/API key → api_key; never auto-set oauth
update public.helmora_providers
set auth_mode = 'api_key'
where auth_mode = 'none'
  and api_key_encrypted is not null
  and trim(api_key_encrypted) <> '';

create table if not exists public.helmora_provider_oauth_credentials (
  provider_id text primary key,
  encrypted_bundle text not null,
  encryption_version integer not null,
  schema_version integer not null,
  connected_at bigint not null,
  refreshed_at bigint,
  updated_at bigint not null,
  credential_version integer not null default 1
);

create table if not exists public.helmora_oauth_pending_states (
  state_hash text primary key,
  provider_id text not null,
  encrypted_verifier text not null,
  initiating_session_id text not null,
  created_at bigint not null,
  expires_at bigint not null,
  consumed_at bigint,
  return_path text not null default '/providers'
);

create index if not exists helmora_oauth_pending_expires_idx
  on public.helmora_oauth_pending_states (expires_at)
  where consumed_at is null;

alter table public.helmora_provider_oauth_credentials enable row level security;
alter table public.helmora_oauth_pending_states enable row level security;

-- Playground chat sessions + messages (optional on Supabase control plane;
-- hybrid Hub routes chat to local SQLite workspace like usage — these tables
-- keep schema parity / future cloud hosting. Apply 002 if you already ran an
-- older supabase-schema.sql without chat tables.)
create table if not exists public.helmora_chat_sessions (
  id text primary key,
  title text not null,
  model_selection jsonb not null default '{"kind":"auto"}'::jsonb,
  thinking boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists helmora_chat_sessions_updated_idx
  on public.helmora_chat_sessions (updated_at desc);

create or replace function public.helmora_chat_tool_activities_valid(
  p_activities jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when jsonb_typeof(p_activities) is distinct from 'array' then false
    else jsonb_array_length(p_activities) <= 20
      and not exists (
        select 1
        from jsonb_array_elements(p_activities) as activity(item)
        where jsonb_typeof(item) is distinct from 'object'
           or not (item ? 'toolId')
           or item ->> 'toolId' not in ('web_search', 'web_fetch')
           or not (item ? 'status')
           or item ->> 'status' not in ('completed', 'failed')
           or not (item ? 'sourceCount')
           or jsonb_typeof(item -> 'sourceCount') is distinct from 'number'
           or case
                when (item ->> 'sourceCount') ~ '^[0-9]{1,5}$'
                  then (item ->> 'sourceCount')::integer > 10000
                else true
              end
           or not (item ? 'errorCode')
           or jsonb_typeof(item -> 'errorCode') not in ('string', 'null')
           or (
             jsonb_typeof(item -> 'errorCode') = 'string'
             and char_length(item ->> 'errorCode') > 120
           )
      )
  end
$function$;

create table if not exists public.helmora_chat_messages (
  id text primary key,
  session_id text not null references public.helmora_chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  status text,
  error_code text,
  tool_activities jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  seq integer not null
);

alter table public.helmora_chat_messages
  add column if not exists tool_activities jsonb not null default '[]'::jsonb;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'helmora_chat_messages_tool_activities_check'
      and conrelid = 'public.helmora_chat_messages'::regclass
  ) then
    alter table public.helmora_chat_messages
      add constraint helmora_chat_messages_tool_activities_check
      check (public.helmora_chat_tool_activities_valid(tool_activities));
  end if;
end
$migration$;

create index if not exists helmora_chat_messages_session_seq_idx
  on public.helmora_chat_messages (session_id, seq);

alter table public.helmora_chat_sessions enable row level security;
alter table public.helmora_chat_messages enable row level security;

-- Helmora Hub additive migration 005: atomic chat message mutations.
--
-- Run the duplicate preflight below before the unique index is created. This
-- migration never deletes or renumbers operator data.

do $migration$
begin
  if exists (
    select 1
    from public.helmora_chat_messages
    group by session_id, seq
    having count(*) > 1
  ) then
    raise exception
      'Cannot apply migration 005: duplicate (session_id, seq) rows exist in public.helmora_chat_messages. Back up the table, assign an intentional unique sequence per session, then rerun this migration.'
      using errcode = '23505';
  end if;
end
$migration$;

create unique index if not exists helmora_chat_messages_session_seq_uidx
  on public.helmora_chat_messages (session_id, seq);

create or replace function public.append_chat_message_atomic(
  p_session_id text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_count integer;
  v_start integer;
  v_result jsonb := '[]'::jsonb;
begin
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'chat_messages_invalid: messages must be a JSON array'
      using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_messages);
  if v_count > 200 then
    raise exception 'chat_messages_invalid: at most 200 messages are allowed'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_messages) as input(item)
    where jsonb_typeof(item) <> 'object'
       or not (item ? 'role')
       or jsonb_typeof(item -> 'role') <> 'string'
       or item ->> 'role' not in ('user', 'assistant', 'system')
       or not (item ? 'content')
       or jsonb_typeof(item -> 'content') <> 'string'
       or char_length(item ->> 'content') > 200000
       or (
         item ? 'id'
         and jsonb_typeof(item -> 'id') not in ('string', 'null')
       )
       or (
         item ? 'createdAt'
         and jsonb_typeof(item -> 'createdAt') not in ('string', 'null')
       )
       or (
         item ? 'status'
         and jsonb_typeof(item -> 'status') not in ('string', 'null')
       )
       or (
         jsonb_typeof(item -> 'status') = 'string'
         and item ->> 'status' not in ('streaming', 'complete', 'stopped', 'error')
       )
       or (
         item ? 'errorCode'
         and jsonb_typeof(item -> 'errorCode') not in ('string', 'null')
       )
       or not public.helmora_chat_tool_activities_valid(
         coalesce(item -> 'toolActivities', '[]'::jsonb)
       )
  ) then
    raise exception 'chat_messages_invalid: a message violates role, content, identifier, timestamp, or status constraints'
      using errcode = '22023';
  end if;

  if coalesce((
    select sum(char_length(item ->> 'content'))
    from jsonb_array_elements(p_messages) as input(item)
  ), 0) > 10000000 then
    raise exception 'chat_messages_invalid: total message content exceeds 10000000 characters'
      using errcode = '22023';
  end if;

  perform 1
  from public.helmora_chat_sessions
  where id = p_session_id
  for update;
  if not found then
    raise exception 'chat_session_not_found'
      using errcode = 'P0002';
  end if;

  if v_count = 0 then
    return v_result;
  end if;

  select coalesce(max(seq), 0)
  into v_start
  from public.helmora_chat_messages
  where session_id = p_session_id;

  if v_start > 2147483647 - v_count then
    raise exception 'chat_messages_invalid: sequence range exhausted'
      using errcode = '22003';
  end if;

  with input as (
    select item, ordinality
    from jsonb_array_elements(p_messages) with ordinality as source(item, ordinality)
  ),
  inserted as (
    insert into public.helmora_chat_messages (
      id,
      session_id,
      role,
      content,
      status,
      error_code,
      tool_activities,
      created_at,
      seq
    )
    select
      coalesce(nullif(item ->> 'id', ''), gen_random_uuid()::text),
      p_session_id,
      item ->> 'role',
      item ->> 'content',
      nullif(item ->> 'status', ''),
      nullif(item ->> 'errorCode', ''),
      coalesce(item -> 'toolActivities', '[]'::jsonb),
      coalesce(nullif(item ->> 'createdAt', '')::timestamptz, now()),
      v_start + ordinality::integer
    from input
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(inserted) order by seq), '[]'::jsonb)
  into v_result
  from inserted;

  delete from public.helmora_chat_messages as message
  where message.id in (
    select old.id
    from public.helmora_chat_messages as old
    where old.session_id = p_session_id
    order by old.seq desc
    offset 200
  );

  update public.helmora_chat_sessions
  set updated_at = now()
  where id = p_session_id;

  return v_result;
end
$function$;

create or replace function public.replace_chat_messages_atomic(
  p_session_id text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_count integer;
  v_result jsonb := '[]'::jsonb;
begin
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'chat_messages_invalid: messages must be a JSON array'
      using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_messages);
  if v_count > 200 then
    raise exception 'chat_messages_invalid: at most 200 messages are allowed'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_messages) as input(item)
    where jsonb_typeof(item) <> 'object'
       or not (item ? 'role')
       or jsonb_typeof(item -> 'role') <> 'string'
       or item ->> 'role' not in ('user', 'assistant', 'system')
       or not (item ? 'content')
       or jsonb_typeof(item -> 'content') <> 'string'
       or char_length(item ->> 'content') > 200000
       or (
         item ? 'id'
         and jsonb_typeof(item -> 'id') not in ('string', 'null')
       )
       or (
         item ? 'createdAt'
         and jsonb_typeof(item -> 'createdAt') not in ('string', 'null')
       )
       or (
         item ? 'status'
         and jsonb_typeof(item -> 'status') not in ('string', 'null')
       )
       or (
         jsonb_typeof(item -> 'status') = 'string'
         and item ->> 'status' not in ('streaming', 'complete', 'stopped', 'error')
       )
       or (
         item ? 'errorCode'
         and jsonb_typeof(item -> 'errorCode') not in ('string', 'null')
       )
       or not public.helmora_chat_tool_activities_valid(
         coalesce(item -> 'toolActivities', '[]'::jsonb)
       )
  ) then
    raise exception 'chat_messages_invalid: a message violates role, content, identifier, timestamp, or status constraints'
      using errcode = '22023';
  end if;

  if coalesce((
    select sum(char_length(item ->> 'content'))
    from jsonb_array_elements(p_messages) as input(item)
  ), 0) > 10000000 then
    raise exception 'chat_messages_invalid: total message content exceeds 10000000 characters'
      using errcode = '22023';
  end if;

  perform 1
  from public.helmora_chat_sessions
  where id = p_session_id
  for update;
  if not found then
    raise exception 'chat_session_not_found'
      using errcode = 'P0002';
  end if;

  delete from public.helmora_chat_messages
  where session_id = p_session_id;

  with input as (
    select item, ordinality
    from jsonb_array_elements(p_messages) with ordinality as source(item, ordinality)
  ),
  inserted as (
    insert into public.helmora_chat_messages (
      id,
      session_id,
      role,
      content,
      status,
      error_code,
      tool_activities,
      created_at,
      seq
    )
    select
      coalesce(nullif(item ->> 'id', ''), gen_random_uuid()::text),
      p_session_id,
      item ->> 'role',
      item ->> 'content',
      nullif(item ->> 'status', ''),
      nullif(item ->> 'errorCode', ''),
      coalesce(item -> 'toolActivities', '[]'::jsonb),
      coalesce(nullif(item ->> 'createdAt', '')::timestamptz, now()),
      ordinality::integer
    from input
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(inserted) order by seq), '[]'::jsonb)
  into v_result
  from inserted;

  update public.helmora_chat_sessions
  set updated_at = now()
  where id = p_session_id;

  return v_result;
end
$function$;

revoke all on function public.append_chat_message_atomic(text, jsonb) from public, anon, authenticated;
revoke all on function public.replace_chat_messages_atomic(text, jsonb) from public, anon, authenticated;
revoke all on function public.helmora_chat_tool_activities_valid(jsonb) from public, anon, authenticated;
grant execute on function public.append_chat_message_atomic(text, jsonb) to service_role;
grant execute on function public.replace_chat_messages_atomic(text, jsonb) to service_role;
grant execute on function public.helmora_chat_tool_activities_valid(jsonb) to service_role;
