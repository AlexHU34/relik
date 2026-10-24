-- ============================================================
-- Relik: администраторы — выполнить один раз в Supabase SQL Editor
-- Даёт: бейдж ADMIN, удаление любых сообщений, закрытие любых
-- опросов и панель пользователей (выдача/снятие админки).
-- ============================================================

alter table public.profiles
  add column if not exists role text not null default 'user';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_check'
  ) then
    alter table public.profiles
      add constraint profiles_role_check check (role in ('user', 'admin'));
  end if;
end $$;

-- Проверка «является ли пользователь админом» для RLS
create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'admin'
  );
$$;

-- Админ может править (мягко удалять) любые сообщения
drop policy if exists "admins update any message" on public.messages;
create policy "admins update any message"
  on public.messages for update
  using (public.is_admin())
  with check (public.is_admin());

-- Админ может менять роли профилей
drop policy if exists "admins update any profile" on public.profiles;
create policy "admins update any profile"
  on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- Выдать админку и @Admin вашему профилю (id найден в вашей базе)
update public.profiles
set role = 'admin',
    username = coalesce(username, 'Admin')
where id = '7c61850e-290d-4934-9283-9a70e907db92';

-- Проверка
select id, display_name, username, role
from public.profiles
order by role desc, display_name;
