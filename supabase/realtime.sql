-- ============================================================
-- Relik: аватары + мгновенная доставка сообщений (Realtime)
-- Выполнить один раз в Supabase → SQL Editor.
-- Скрипт безопасно запускать повторно: уже добавленное пропускается.
-- ============================================================

-- 1) Аватар профиля (чтобы фото видели другие пользователи)
alter table public.profiles add column if not exists avatar text;

-- 2) Realtime: подключаем messages и reactions, только если их ещё нет
--    (повторный "add table" даёт ошибку 42710, поэтому проверяем)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'reactions'
  ) then
    execute 'alter publication supabase_realtime add table public.reactions';
  end if;
end $$;

-- 3) Полная строка в событиях UPDATE/DELETE (нужно Realtime при RLS)
alter table public.messages replica identity full;
alter table public.reactions replica identity full;

-- 4) Проверка: должны быть public | messages и public | reactions
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;

-- 5) Проверка replica identity: relreplident = 'f' (full)
select c.relname, c.relreplident
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('messages', 'reactions')
order by c.relname;

-- 6) Проверка колонки аватара
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
  and column_name = 'avatar';
