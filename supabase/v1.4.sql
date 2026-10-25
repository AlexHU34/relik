-- ============================================================
-- Relik v1.4 — все миграции одного файла
-- Supabase → SQL Editor → Run. Скрипт идемпотентный:
-- повторный запуск ничего не ломает.
--   1) group_keys: E2E-ключи групп + политики участников
--   2) storage:    bucket files для шифрованных медиа
--   3) user_prefs: синхронизация настроек между устройствами
-- ============================================================

-- ============================================================
-- Relik: E2E-ключи групповых чатов + безопасное управление участниками
-- Выполните один раз в Supabase → SQL Editor → Run.
-- Без этой миграции группы работают как раньше (без E2E),
-- а приложение продолжает работать.
-- ============================================================

-- ── Помощники без рекурсии RLS ─────────────────────────────
create or replace function public.is_conversation_member(conv uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members m
    where m.conversation_id = conv and m.user_id = uid
  );
$$;

create or replace function public.is_conversation_creator(conv uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = conv and c.created_by = uid
  );
$$;

revoke all on function public.is_conversation_member(uuid, uuid) from public;
revoke all on function public.is_conversation_creator(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.is_conversation_creator(uuid, uuid) to authenticated;

-- ── Участники: создатель может добавлять и удалять, участник — выйти ──
drop policy if exists "members add" on public.conversation_members;
create policy "members add"
  on public.conversation_members for insert
  with check (
    user_id = auth.uid()
    or public.is_conversation_creator(conversation_id, auth.uid())
  );

drop policy if exists "members leave" on public.conversation_members;
create policy "members leave"
  on public.conversation_members for delete
  using (user_id = auth.uid());

drop policy if exists "creator removes members" on public.conversation_members;
create policy "creator removes members"
  on public.conversation_members for delete
  using (public.is_conversation_creator(conversation_id, auth.uid()));

-- ── Ключи групп: каждому участнику — своя зашифрованная копия ──
create table if not exists public.group_keys (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  sender_id uuid references public.profiles(id),
  iv text not null,
  ciphertext text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id, key_version)
);

create index if not exists group_keys_by_user
  on public.group_keys(user_id, conversation_id, key_version desc);

alter table public.group_keys enable row level security;

drop policy if exists "own group keys read" on public.group_keys;
create policy "own group keys read"
  on public.group_keys for select
  using (user_id = auth.uid());

drop policy if exists "members distribute group keys" on public.group_keys;
create policy "members distribute group keys"
  on public.group_keys for insert
  with check (
    auth.uid() = sender_id
    and public.is_conversation_member(conversation_id, auth.uid())
    and public.is_conversation_member(conversation_id, user_id)
  );

drop policy if exists "own group keys update" on public.group_keys;
create policy "own group keys update"
  on public.group_keys for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Realtime для group_keys не нужен: ключи читаются при открытии чата.

-- ============================================================
-- После миграции: ключ создаётся при создании группы и при первом
-- сообщении в старой группе; при удалении участника ключ ротируется.
-- ============================================================


-- ============================================================
-- Relik: Supabase Storage для E2E-шифрованных медиа
-- Выполните один раз в Supabase → SQL Editor → Run.
--
-- В bucket 'files' попадает только AES-GCM-шифротекст.
-- Ключ файла передаётся внутри зашифрованного сообщения,
-- поэтому публичное чтение безопасно: без ключа это мусор.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', true, 104857600)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit;

drop policy if exists "relik files read" on storage.objects;
create policy "relik files read"
  on storage.objects for select
  using (bucket_id = 'files');

drop policy if exists "relik files upload" on storage.objects;
create policy "relik files upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'files');

drop policy if exists "relik files update" on storage.objects;
create policy "relik files update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'files' and owner = auth.uid())
  with check (bucket_id = 'files' and owner = auth.uid());

drop policy if exists "relik files delete" on storage.objects;
create policy "relik files delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'files' and owner = auth.uid());


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
