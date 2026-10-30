-- ============================================================
-- Relik: второй фактор для панели модерации (admin.html)
-- Выполнить один раз в Supabase → SQL Editor.
--
-- Схема: Supabase-логин (email+пароль) = первый фактор.
-- Далее панель требует пароль панели + 6-значный TOTP.
-- Хэш пароля панели — PBKDF2-SHA256, TOTP-секрет — base32.
-- Доступ к строке только у владельца с ролью admin (RLS + is_admin()).
-- ============================================================

create table if not exists public.admin_access (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  pass_salt    text not null,
  pass_hash    text not null,
  iter         int  not null default 310000,
  totp_secret  text,
  totp_enabled boolean not null default false,
  failed_count int  not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.admin_access enable row level security;

drop policy if exists admin_access_self on public.admin_access;
create policy admin_access_self on public.admin_access
  for all to authenticated
  using (auth.uid() = user_id and public.is_admin())
  with check (auth.uid() = user_id and public.is_admin());

-- Журнал: добавим тип события для входа в панель (необязательно)
-- insert into public.admin_log (admin_id, action, details) values (auth.uid(), 'panel_login', '{}'::jsonb);
