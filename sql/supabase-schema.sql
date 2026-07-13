-- Helmora Hub hybrid storage schema for Supabase (Postgres)
-- Run in Supabase SQL editor before STORAGE_BACKEND=supabase
-- Existing ctrlhub_* installs: run sql/rename-ctrlhub-to-helmora.sql first

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

-- Lock down: only service_role (server) should access these tables.
alter table public.helmora_settings enable row level security;
alter table public.helmora_providers enable row level security;
alter table public.helmora_agents enable row level security;

-- No policies for anon/authenticated → denied by default.
-- service_role bypasses RLS.

comment on column public.helmora_providers.api_key_encrypted is
  'AES-256-GCM payload encrypted with ENCRYPTION_KEY; decrypt only in Helmora Hub process memory';

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
