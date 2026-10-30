-- ============================================================
-- Relik v2: наблюдаемость, push, блокировки, модерация
-- Выполните один раз в Supabase → SQL Editor → Run.
-- Безопасно запускать повторно.
-- ============================================================

-- ── 1. События клиента (ошибки, метрики) ────────────────────
create table if not exists public.client_events (
  id          bigserial primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  kind        text not null,
  data        jsonb not null default '{}'::jsonb,
  app_version text,
  created_at  timestamptz not null default now()
);
create index if not exists client_events_created_idx on public.client_events (created_at desc);
create index if not exists client_events_kind_idx on public.client_events (kind, created_at desc);

alter table public.client_events enable row level security;

drop policy if exists client_events_insert on public.client_events;
create policy client_events_insert on public.client_events
  for insert to authenticated
  with check (auth.uid() = user_id or user_id is null);

drop policy if exists client_events_admin_read on public.client_events;
create policy client_events_admin_read on public.client_events
  for select to authenticated
  using (public.is_admin());

-- ── 2. Подписки на Web Push ─────────────────────────────────
create table if not exists public.push_subs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz
);
create index if not exists push_subs_user_idx on public.push_subs (user_id);

alter table public.push_subs enable row level security;

drop policy if exists push_subs_own on public.push_subs;
create policy push_subs_own on public.push_subs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 3. Блокировки пользователей ─────────────────────────────
create table if not exists public.blocks (
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, blocked_id),
  constraint blocks_not_self check (owner_id <> blocked_id)
);

alter table public.blocks enable row level security;

drop policy if exists blocks_own on public.blocks;
create policy blocks_own on public.blocks
  for all to authenticated
  using (auth.uid() = owner_id or auth.uid() = blocked_id)
  with check (auth.uid() = owner_id);

-- ── 4. Жалобы ───────────────────────────────────────────────
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid references public.conversations(id) on delete set null,
  message_id  uuid references public.messages(id) on delete set null,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  sender_id   uuid references public.profiles(id) on delete set null,
  message_ts  timestamptz,
  reason      text not null default '',
  status      text not null default 'open' check (status in ('open','resolved','rejected')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);

/* на случай, если таблица уже была создана раньше */
alter table public.reports add column if not exists sender_id uuid references public.profiles(id) on delete set null;
alter table public.reports add column if not exists message_ts timestamptz;

create index if not exists reports_status_idx on public.reports (status, created_at desc);

alter table public.reports enable row level security;

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to authenticated
  with check (auth.uid() = reporter_id);

drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports
  for select to authenticated
  using (auth.uid() = reporter_id or public.is_admin());

drop policy if exists reports_admin_update on public.reports;
create policy reports_admin_update on public.reports
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── 5. Баны ─────────────────────────────────────────────────
create table if not exists public.bans (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  until      timestamptz,               -- null = навсегда
  reason     text not null default '',
  admin_id   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.bans enable row level security;

drop policy if exists bans_read on public.bans;
create policy bans_read on public.bans
  for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists bans_admin_write on public.bans;
create policy bans_admin_write on public.bans
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.is_banned(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bans b
    where b.user_id = uid and (b.until is null or b.until > now())
  );
$$;

revoke all on function public.is_banned(uuid) from public;
grant execute on function public.is_banned(uuid) to authenticated;

-- запрет отправки забаненным (политика "members send" из schema.sql)
drop policy if exists "members send" on public.messages;
create policy "members send"
  on public.messages for insert
  with check (
    auth.uid() = sender_id
    and not public.is_banned(auth.uid())
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = messages.conversation_id and m.user_id = auth.uid()
    )
  );

-- ── 6. Журнал действий администратора ───────────────────────
create table if not exists public.admin_log (
  id         bigserial primary key,
  admin_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  target     text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_log_created_idx on public.admin_log (created_at desc);

alter table public.admin_log enable row level security;

drop policy if exists admin_log_admin on public.admin_log;
create policy admin_log_admin on public.admin_log
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── 7. Realtime на новые жалобы (для админ-панели) ──────────
do $$
begin
  alter publication supabase_realtime add table public.reports;
exception
  when duplicate_object then null;
  when undefined_object then null;
  when others then null;
end;
$$;
