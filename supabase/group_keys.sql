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
    or public.is_conversation_creator(conversation_id)
  );

drop policy if exists "members leave" on public.conversation_members;
create policy "members leave"
  on public.conversation_members for delete
  using (user_id = auth.uid());

drop policy if exists "creator removes members" on public.conversation_members;
create policy "creator removes members"
  on public.conversation_members for delete
  using (public.is_conversation_creator(conversation_id));

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
    and public.is_conversation_member(conversation_id)
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
