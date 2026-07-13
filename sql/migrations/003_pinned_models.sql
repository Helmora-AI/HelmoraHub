-- Migration 003: provider pinned_models (catalog pin list)
-- Run in Supabase SQL Editor if updateProvider fails with:
--   Could not find the 'pinned_models' column of 'helmora_providers'
-- Idempotent.

alter table public.helmora_providers
  add column if not exists pinned_models jsonb not null default '[]'::jsonb;

comment on column public.helmora_providers.pinned_models is
  'JSON array of catalog model ids pinned for this provider';
