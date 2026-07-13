-- Migrate legacy CtrLHub Supabase tables to Helmora names.
-- Safe to run once on existing installs; no-op if ctrlhub_* tables are absent.

do $$
begin
  if to_regclass('public.ctrlhub_settings') is not null
     and to_regclass('public.helmora_settings') is null then
    alter table public.ctrlhub_settings rename to helmora_settings;
  end if;

  if to_regclass('public.ctrlhub_providers') is not null
     and to_regclass('public.helmora_providers') is null then
    alter table public.ctrlhub_providers rename to helmora_providers;
    if to_regclass('public.ctrlhub_providers_tier_idx') is not null then
      alter index public.ctrlhub_providers_tier_idx rename to helmora_providers_tier_idx;
    end if;
  end if;

  if to_regclass('public.ctrlhub_agents') is not null
     and to_regclass('public.helmora_agents') is null then
    alter table public.ctrlhub_agents rename to helmora_agents;
  end if;
end $$;
