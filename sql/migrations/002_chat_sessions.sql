-- Additive migration: Playground chat sessions + messages
-- For installs that already applied an older sql/supabase-schema.sql
-- (helmora_settings / providers / agents present).
--
-- Apply in Supabase Dashboard → SQL Editor (paste entire file; no \i).
-- Idempotent: safe to re-run.
--
-- Note: Helmora hybrid mode stores Playground chat in Hub local SQLite
-- workspace (like usage). These Postgres tables provide schema parity and
-- support the SupabaseConfigStore chat APIs if used.

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

create table if not exists public.helmora_chat_messages (
  id text primary key,
  session_id text not null references public.helmora_chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  status text,
  error_code text,
  created_at timestamptz not null default now(),
  seq integer not null
);

create index if not exists helmora_chat_messages_session_seq_idx
  on public.helmora_chat_messages (session_id, seq);

alter table public.helmora_chat_sessions enable row level security;
alter table public.helmora_chat_messages enable row level security;
