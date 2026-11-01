-- Relik — групповые sender keys для crypto v2 (шаг 7).
-- Одна строка = «коробка» с цепочкой отправителя для ОДНОГО устройства получателя.
-- Цепочка идёт от отправителя; получатель расшифровывает свою коробку парным
-- ratchet-сеансом (таблицы device_keys / one_time_prekeys из crypto_v2.sql).
--
-- Запускать ПОСЛЕ crypto_v2.sql и group_keys.sql (там появляется
-- public.is_conversation_member(uuid)).
--
-- Клиент включает это только при CRYPTO_V2.groupsEnabled = true; без таблицы
-- он молча остаётся на прежнем групповом ключе.

create table if not exists public.group_sender_keys (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  sender_device text not null,
  recipient_device text not null,
  chain_id text not null,
  box jsonb not null,                 -- { header, iv, ct, x3dh?, ts } — уже зашифровано
  created_at timestamptz not null default now(),
  primary key (conversation_id, sender_id, sender_device, recipient_device)
);

create index if not exists group_sender_keys_recipient_idx
  on public.group_sender_keys (recipient_device);

alter table public.group_sender_keys enable row level security;

-- Чтение: только если recipient_device — моё устройство.
drop policy if exists "sender keys read own device" on public.group_sender_keys;
create policy "sender keys read own device" on public.group_sender_keys
  for select using (
    exists (
      select 1 from public.device_keys dk
      where dk.user_id = auth.uid()
        and dk.device_id = group_sender_keys.recipient_device
    )
  );

-- Запись: только от себя и только в чат, где я состою.
drop policy if exists "sender keys write" on public.group_sender_keys;
create policy "sender keys write" on public.group_sender_keys
  for insert with check (
    sender_id = auth.uid()
    and public.is_conversation_member(conversation_id)
  );

-- Перевыпуск своей цепочки (upsert) — обновляем только свои строки.
drop policy if exists "sender keys update" on public.group_sender_keys;
create policy "sender keys update" on public.group_sender_keys
  for update using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- Удаление: своя рассылка (ротация) или своя коробка (устройство ушло).
drop policy if exists "sender keys delete" on public.group_sender_keys;
create policy "sender keys delete" on public.group_sender_keys
  for delete using (
    sender_id = auth.uid()
    or exists (
      select 1 from public.device_keys dk
      where dk.user_id = auth.uid()
        and dk.device_id = group_sender_keys.recipient_device
    )
  );

grant select, insert, update, delete on public.group_sender_keys to authenticated;
