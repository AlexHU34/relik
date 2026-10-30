-- ============================================================
-- Relik — миграция 2026-10-30 #2: учёт версии схемы
-- Даёт ответ на вопрос «а ты этот SQL прогонял?» без чтения чатов.
-- ============================================================

create table if not exists public.schema_version (
  version text primary key,
  applied_at timestamptz not null default now(),
  note text
);

alter table public.schema_version enable row level security;

-- Читать может только service_role (у anon/authenticated политик нет).
-- Применение миграций идёт через SQL Editor / service key.

insert into public.schema_version (version, note)
values ('20261030_001_indexes', 'индексы RLS и ленты')
on conflict (version) do nothing;

insert into public.schema_version (version, note)
values ('20261030_002_schema_version', 'эта таблица')
on conflict (version) do nothing;
