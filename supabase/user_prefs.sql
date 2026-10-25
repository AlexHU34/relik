-- Relik — синхронизация пользовательских настроек между устройствами
-- Выполните в Supabase SQL Editor (Dashboard → SQL Editor → Run).
-- Без этой таблицы приложение продолжает работать локально.

create table if not exists public.user_prefs (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_prefs enable row level security;

drop policy if exists "own user prefs" on public.user_prefs;
create policy "own user prefs"
  on public.user_prefs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
