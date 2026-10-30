-- ============================================================
-- Relik: очередь push-уведомлений
-- Клиент кладёт сюда строку после успешной отправки сообщения,
-- сервис на VPS забирает её и рассылает push. Входящий HTTPS не нужен.
-- Supabase → SQL Editor → Run (можно повторно).
-- ============================================================

create table if not exists public.push_queue (
  id         bigserial primary key,
  chat_id    uuid not null references public.conversations(id) on delete cascade,
  from_user  uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  tries      int not null default 0
);

create index if not exists push_queue_created_idx on public.push_queue (created_at);

alter table public.push_queue enable row level security;

drop policy if exists push_queue_insert on public.push_queue;
create policy push_queue_insert on public.push_queue
  for insert to authenticated
  with check (auth.uid() = from_user);

-- читать и удалять очередь может только сервис через service_role
drop policy if exists push_queue_service on public.push_queue;
create policy push_queue_service on public.push_queue
  for all to service_role
  using (true) with check (true);

-- чистим зависшие строки, чтобы очередь не росла
create or replace function public.push_queue_prune()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  removed int;
begin
  delete from public.push_queue where created_at < now() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.push_queue_prune() from public;
grant execute on function public.push_queue_prune() to authenticated;
