-- ============================================================
-- Relik — миграция 2026-10-30 #1: индексы под RLS и ленту
-- Безопасна для повторного запуска (IF NOT EXISTS).
-- Применять в SQL Editor Supabase или через scripts/sqlrun.
-- ============================================================

-- RLS-функция is_conversation_member(uuid) ищет по user_id.
-- Без этого индекса каждый SELECT сообщений делает seq scan по участникам.
create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

-- Проверка членства по паре уже покрыта первичным ключом,
-- но явный индекс помогает планировщику на больших чатах.
create index if not exists conversation_members_pair_idx
  on public.conversation_members (conversation_id, user_id);

-- Лента: выборка последних N сообщений чата (см. loadMessagesPage).
-- messages_by_chat из schema.sql уже покрывает, дублируем с явным именем
-- на случай, если схему поднимали вручную.
create index if not exists messages_chat_created_idx
  on public.messages (conversation_id, created_at desc);

-- Реакции и опросы читаются пачкой по message_id.
create index if not exists reactions_message_idx
  on public.reactions (message_id);
