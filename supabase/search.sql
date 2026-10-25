-- ============================================================
-- Relik: быстрый поиск людей
-- Выполните один раз в Supabase → SQL Editor → Run.
-- Одна функция вместо перебора колонок: поиск по @username и имени,
-- сортировка «точное совпадение → префикс → вхождение».
-- ============================================================

create or replace function public.search_people(q text default '')
returns table (
  id uuid,
  display_name text,
  username text,
  avatar_hue smallint,
  avatar text,
  role text,
  last_seen timestamptz,
  public_key text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.display_name,
    p.username,
    p.avatar_hue,
    p.avatar,
    p.role,
    p.last_seen,
    p.public_key
  from public.profiles p
  where coalesce(btrim(q), '') = ''
     or p.username ilike '%' || btrim(q) || '%'
     or p.display_name ilike '%' || btrim(q) || '%'
  order by
    case
      when coalesce(btrim(q), '') = '' then 0
      when p.username ilike btrim(q) then 0
      when p.username ilike btrim(q) || '%' then 1
      when p.display_name ilike btrim(q) then 2
      when p.display_name ilike btrim(q) || '%' then 3
      else 4
    end,
    p.display_name
  limit 50;
$$;

revoke all on function public.search_people(text) from public;
grant execute on function public.search_people(text) to anon;
grant execute on function public.search_people(text) to authenticated;
