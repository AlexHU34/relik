-- Починка take_one_time_prekey: имена выходных параметров (prekey_id, public_key)
-- совпадают с колонками таблицы, поэтому без псевдонима PL/pgSQL падает с
-- 42702 "column reference prekey_id is ambiguous" и RPC отдаёт 400.
-- Причина: v2 не мог получить одноразовый prekey → сеанс X3DH собирался без него.

create or replace function public.take_one_time_prekey(p_user uuid, p_device uuid)
returns table(prekey_id integer, public_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  picked public.one_time_prekeys%rowtype;
begin
  select t.* into picked
  from public.one_time_prekeys t
  where t.user_id = p_user and t.device_id = p_device and t.used = false
  order by t.prekey_id
  limit 1
  for update skip locked;

  if picked.prekey_id is null then
    return;
  end if;

  update public.one_time_prekeys t
    set used = true
    where t.user_id = p_user and t.device_id = p_device and t.prekey_id = picked.prekey_id;

  prekey_id := picked.prekey_id;
  public_key := picked.public_key;
  return next;
end;
$$;

grant execute on function public.take_one_time_prekey(uuid, uuid) to authenticated;
