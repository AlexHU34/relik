-- ============================================================
-- Relik: починка личных чатов + удаление аккаунта
-- Выполните один раз в Supabase → SQL Editor → Run.
--   ensure_dm_member(conv uuid, other_user uuid) → boolean
--   delete_my_account() → void
-- ============================================================

-- ── 1. Гарантировать, что в личном чате есть оба участника ──
-- Нужно для старых чатов, созданных до supabase/dm_fix.sql:
-- сообщение могло уйти в чат, где собеседника нет, и он его не видел.
create or replace function public.ensure_dm_member(conv uuid, other_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  kind text;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if conv is null or other_user is null or other_user = me then
    return false;
  end if;

  select c.kind into kind from public.conversations c where c.id = conv;
  if kind is null or kind <> 'dm' then
    return false;
  end if;

  if not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = me
  ) then
    raise exception 'not a member';
  end if;

  if not exists (select 1 from public.profiles p where p.id = other_user) then
    return false;
  end if;

  insert into public.conversation_members (conversation_id, user_id)
  values (conv, other_user)
  on conflict (conversation_id, user_id) do nothing;

  return true;
end;
$$;

-- ── 2. Полное удаление своего аккаунта ──
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  /* сообщения, где я автор: у messages.sender_id нет каскада */
  delete from public.messages where sender_id = me;
  delete from public.reactions where user_id = me;

  /* таблицы, которых может не быть на старых проектах */
  begin
    delete from public.read_receipts where user_id = me;
  exception when undefined_table then null;
  end;

  begin
    delete from public.group_keys where user_id = me or sender_id = me;
  exception when undefined_table then null;
  end;

  begin
    delete from public.user_prefs where user_id = me;
  exception when undefined_table then null;
  end;

  begin
    delete from public.contact_requests where from_user = me or to_user = me;
  exception when undefined_table then null;
  end;

  begin
    delete from public.device_keys where user_id = me;
  exception when undefined_table then null;
  end;

  begin
    delete from public.one_time_prekeys where user_id = me;
  exception when undefined_table then null;
  end;

  /* членство в чатах */
  delete from public.conversation_members where user_id = me;

  /* пустые чаты, которые я создавал */
  delete from public.conversations c
   where c.created_by = me
     and not exists (
       select 1 from public.conversation_members m where m.conversation_id = c.id
     );

  /* остальные чаты, где я был создателем, оставляем без автора */
  update public.conversations set created_by = null where created_by = me;

  /* профиль */
  delete from public.profiles where id = me;
end;
$$;

revoke all on function public.ensure_dm_member(uuid, uuid) from public;
revoke all on function public.delete_my_account() from public;

grant execute on function public.ensure_dm_member(uuid, uuid) to authenticated;
grant execute on function public.delete_my_account() to authenticated;
