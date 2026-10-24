-- ============================================================
-- Relik: схема данных Supabase + RLS (Фаза 4–5)
-- Защита: RLS даёт доступ только к чатам, где ты участник.
-- Шифрование (Фаза 6): messages.ciphertext — всегда зашифрованные байты.
-- ============================================================

-- ── Профили ────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default 'Anonymous',
  username text,                        -- @username: латиница, уникальный
  avatar_hue smallint not null default 0,
  avatar text,                          -- аватар (data URL, 256px JPEG)
  public_key text,                      -- ECDH P-256 (JWK, публичная часть)
  key_backup text,                      -- приватный ключ, шифр. паролем (PBKDF2+AES-GCM)
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "read all profiles"
  on public.profiles for select using (true);
create policy "upsert own profile"
  on public.profiles for insert with check (auth.uid() = id);
create policy "update own profile"
  on public.profiles for update using (auth.uid() = id);

-- ── Чаты ───────────────────────────────────────────────────
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'dm' check (kind in ('dm','group')),
  title text,                           -- только для групп
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

-- Чат видно/менять может только участник
create policy "members see conversations"
  on public.conversations for select
  using (exists (select 1 from public.conversation_members m
                 where m.conversation_id = conversations.id and m.user_id = auth.uid()));
create policy "creator inserts"
  on public.conversations for insert with check (auth.uid() = created_by);

create policy "members see membership"
  on public.conversation_members for select
  using (exists (select 1 from public.conversation_members m2
                 where m2.conversation_id = conversation_members.conversation_id and m2.user_id = auth.uid()));
create policy "members add"
  on public.conversation_members for insert with check (
    exists (select 1 from public.conversation_members m
            where m.conversation_id = conversation_members.conversation_id and m.user_id = auth.uid())
    and user_id = auth.uid()
  );

-- ── Сообщения (ТОЛЬКО шифротекст!) ─────────────────────────
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id),
  ciphertext text not null,             -- AES-GCM(base64): текст ИЛИ ключ файла
  iv text not null,
  reply_to uuid references public.messages(id) on delete set null,
  edited boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists messages_by_chat
  on public.messages(conversation_id, created_at desc);

alter table public.messages enable row level security;

create policy "members read messages"
  on public.messages for select
  using (exists (select 1 from public.conversation_members m
                 where m.conversation_id = messages.conversation_id and m.user_id = auth.uid()));
create policy "members send"
  on public.messages for insert
  with check (auth.uid() = sender_id and exists (
    select 1 from public.conversation_members m
    where m.conversation_id = messages.conversation_id and m.user_id = auth.uid()));
create policy "sender edits own"
  on public.messages for update using (auth.uid() = sender_id);

-- ── Реакции ────────────────────────────────────────────────
create table if not exists public.reactions (
  message_id uuid references public.messages(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  emoji text not null,
  primary key (message_id, user_id, emoji)
);
alter table public.reactions enable row level security;

create policy "members manage reactions"
  on public.reactions for all
  using (exists (select 1 from public.conversation_members m
                 join public.messages ms on ms.id = reactions.message_id
                 where m.conversation_id = ms.conversation_id and m.user_id = auth.uid()))
  with check (auth.uid() = user_id);

-- ── Прочитано ──────────────────────────────────────────────
create table if not exists public.read_receipts (
  conversation_id uuid references public.conversations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.read_receipts enable row level security;

create policy "own receipts"
  on public.read_receipts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Файлы (шифрованные блобы в Storage) ────────────────────
-- Bucket: 'files'. В Фазе 6 загружаем AES-GCM-шифрованные данные,
-- ключ передаём внутри ciphertext сообщения.
-- insert into storage.buckets (id, name, public) values ('files','files', false);

-- ============================================================
-- Realtime: живая доставка
--   В Supabase Studio: Database → Replication →
--   включить таблицу messages и reactions.
-- ============================================================
