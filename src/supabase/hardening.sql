-- ============================================================
-- Relik: защита от флуда и обслуживание таблиц
-- Supabase → SQL Editor → Run. Можно повторно.
-- ============================================================

-- ── 1. Лимит отправки: не больше 20 сообщений в минуту ──────
create or replace function public.messages_rate_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cnt int;
begin
  select count(*) into cnt
  from public.messages m
  where m.sender_id = new.sender_id
    and m.created_at > now() - interval '60 seconds';

  if cnt >= 20 then
    raise exception 'rate_limited: too many messages per minute'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_rate_guard on public.messages;
create trigger messages_rate_guard
  before insert on public.messages
  for each row execute function public.messages_rate_guard();

-- ── 2. Быстрый поиск для лимита и статистики ───────────────
create index if not exists messages_sender_time_idx
  on public.messages (sender_id, created_at desc);

-- ── 3. Гигиена: старые технические события не храним вечно ─
create or replace function public.cleanup_client_events(days int default 30)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  removed int;
begin
  delete from public.client_events
   where created_at < now() - (days || ' days')::interval;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.cleanup_client_events(int) from public;
grant execute on function public.cleanup_client_events(int) to authenticated;

-- ── 4. Удаление мёртвых push-подписок ──────────────────────
create or replace function public.push_subs_prune()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  removed int;
begin
  delete from public.push_subs
   where created_at < now() - interval '180 days'
     and (last_ok is null or last_ok < now() - interval '60 days');
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.push_subs_prune() from public;
grant execute on function public.push_subs_prune() to authenticated;
