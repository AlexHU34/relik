-- ============================================================
-- Relik: надёжное создание личного чата (DM)
-- Выполните один раз в Supabase → SQL Editor → Run.
-- Создаёт оба membership атомарно и не зависит от RLS-политик
-- на добавление второго участника.
-- ============================================================

create or replace function public.create_dm(target_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  conv uuid;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if target_user is null or target_user = me then
    raise exception 'invalid target user';
  end if;
  if not exists (select 1 from public.profiles p where p.id = target_user) then
    raise exception 'target profile not found';
  end if;

  select c.id into conv
  from public.conversations c
  join public.conversation_members a on a.conversation_id = c.id and a.user_id = me
  join public.conversation_members b on b.conversation_id = c.id and b.user_id = target_user
  where c.kind = 'dm'
    and (select count(*) from public.conversation_members m where m.conversation_id = c.id) = 2
  limit 1;

  if conv is not null then
    return conv;
  end if;

  conv := gen_random_uuid();
  insert into public.conversations (id, kind, created_by)
  values (conv, 'dm', me);

  insert into public.conversation_members (conversation_id, user_id)
  values (conv, me), (conv, target_user);

  return conv;
end;
$$;

revoke all on function public.create_dm(uuid) from public;
grant execute on function public.create_dm(uuid) to authenticated;
