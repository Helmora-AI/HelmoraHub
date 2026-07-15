-- Helmora Hub additive migration 004: Tools control-plane tables.
--
-- Existing Supabase installs created before the Tools runtime can apply this
-- file independently. It is safe to run more than once. The complete and
-- authoritative schema remains sql/supabase-schema.sql.

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

-- No anon/authenticated policies are created. The server-side service role is
-- the only supported caller and bypasses RLS.
alter table public.helmora_connector_credentials enable row level security;
alter table public.helmora_tool_runs enable row level security;

comment on column public.helmora_connector_credentials.encrypted_secret is
  'AES-256-GCM connector credential; never plaintext and never exposed through public DTOs';
