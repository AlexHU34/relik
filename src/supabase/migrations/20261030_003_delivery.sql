-- ============================================================
-- Relik — миграция 2026-10-30 #3: идемпотентность доставки
-- Клиент сам генерирует UUID сообщения (js/db/idb.js → newId()).
-- Первичный ключ messages.id и есть ключ идемпотентности:
-- повторная вставка того же id даёт 23505, и клиент считает
-- сообщение доставленным (см. retryMessage в composer.js).
--
-- Здесь только фиксируем контракт комментариями и проверяем,
-- что ключ действительно первичный.
-- ============================================================

comment on column public.messages.id is
  'Клиентский UUID = ключ идемпотентности. Повторная отправка с тем же id не создаёт дубль.';

comment on column public.messages.conversation_id is
  'Чат; доступ проверяется через public.is_conversation_member(uuid).';

-- Диагностика: должно вернуться 1 (messages.id — первичный ключ).
-- Если вернулось 0 — схема изменена вручную, идемпотентность под угрозой.
do $$
declare
  is_pk boolean;
begin
  select exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'messages'
      and c.contype = 'p'
  ) into is_pk;

  if not is_pk then
    raise exception 'messages.id должен быть PRIMARY KEY (ключ идемпотентности)';
  end if;
end $$;

insert into public.schema_version (version, note)
values ('20261030_003_delivery', 'идемпотентность по messages.id')
on conflict (version) do nothing;
