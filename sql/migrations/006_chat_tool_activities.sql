-- Helmora Hub additive migration 006: persist bounded, redacted tool activity
-- metadata on Playground assistant messages. This migration never stores tool
-- queries, fetched URLs, snippets, or raw connector payloads.

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
       or (item ? 'id' and jsonb_typeof(item -> 'id') not in ('string', 'null'))
       or (item ? 'createdAt' and jsonb_typeof(item -> 'createdAt') not in ('string', 'null'))
       or (item ? 'status' and jsonb_typeof(item -> 'status') not in ('string', 'null'))
       or (
         jsonb_typeof(item -> 'status') = 'string'
         and item ->> 'status' not in ('streaming', 'complete', 'stopped', 'error')
       )
       or (item ? 'errorCode' and jsonb_typeof(item -> 'errorCode') not in ('string', 'null'))
       or not public.helmora_chat_tool_activities_valid(
         coalesce(item -> 'toolActivities', '[]'::jsonb)
       )
  ) then
    raise exception 'chat_messages_invalid: a message violates content or metadata constraints'
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
    raise exception 'chat_session_not_found' using errcode = 'P0002';
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
      id, session_id, role, content, status, error_code, tool_activities, created_at, seq
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
       or (item ? 'id' and jsonb_typeof(item -> 'id') not in ('string', 'null'))
       or (item ? 'createdAt' and jsonb_typeof(item -> 'createdAt') not in ('string', 'null'))
       or (item ? 'status' and jsonb_typeof(item -> 'status') not in ('string', 'null'))
       or (
         jsonb_typeof(item -> 'status') = 'string'
         and item ->> 'status' not in ('streaming', 'complete', 'stopped', 'error')
       )
       or (item ? 'errorCode' and jsonb_typeof(item -> 'errorCode') not in ('string', 'null'))
       or not public.helmora_chat_tool_activities_valid(
         coalesce(item -> 'toolActivities', '[]'::jsonb)
       )
  ) then
    raise exception 'chat_messages_invalid: a message violates content or metadata constraints'
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
    raise exception 'chat_session_not_found' using errcode = 'P0002';
  end if;

  delete from public.helmora_chat_messages
  where session_id = p_session_id;

  with input as (
    select item, ordinality
    from jsonb_array_elements(p_messages) with ordinality as source(item, ordinality)
  ),
  inserted as (
    insert into public.helmora_chat_messages (
      id, session_id, role, content, status, error_code, tool_activities, created_at, seq
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

revoke all on function public.helmora_chat_tool_activities_valid(jsonb) from public, anon, authenticated;
revoke all on function public.append_chat_message_atomic(text, jsonb) from public, anon, authenticated;
revoke all on function public.replace_chat_messages_atomic(text, jsonb) from public, anon, authenticated;
grant execute on function public.helmora_chat_tool_activities_valid(jsonb) to service_role;
grant execute on function public.append_chat_message_atomic(text, jsonb) to service_role;
grant execute on function public.replace_chat_messages_atomic(text, jsonb) to service_role;
