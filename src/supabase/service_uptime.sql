-- ============================================================
-- Relik: история доступности (для честного «99%»)
-- VPS-агент (scripts/push-service) раз в минуту проверяет сайт, Auth,
-- REST, Storage, Realtime и TURN; раз в 5 минут кладёт сюда срез,
-- а в service_status — последнее состояние.
-- Supabase → SQL Editor → Run. Скрипт идемпотентный.
-- Без этого файла всё работает, но без истории и с урезанным статусом.
-- ============================================================

-- ── 1. Расширенные поля последнего среза ────────────────────
alter table public.service_status add column if not exists front_ok      boolean;
alter table public.service_status add column if not exists front_ms      int;
alter table public.service_status add column if not exists front_version text;
alter table public.service_status add column if not exists auth_ok       boolean;
alter table public.service_status add column if not exists auth_ms       int;
alter table public.service_status add column if not exists storage_ok    boolean;
alter table public.service_status add column if not exists storage_ms    int;
alter table public.service_status add column if not exists realtime_ok   boolean;
alter table public.service_status add column if not exists realtime_ms   int;
alter table public.service_status add column if not exists uptime_24h    numeric(5,1);
alter table public.service_status add column if not exists checks        jsonb;

-- ── 2. История срезов ──────────────────────────────────────
create table if not exists public.service_samples (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  ok        boolean not null default false,
  rest_ms   int,
  front_ms  int,
  down      text[] not null default '{}',
  ver       text
);

create index if not exists service_samples_ts_idx on public.service_samples (ts desc);

alter table public.service_samples enable row level security;

/* Читают все: это только «работает/не работает» и миллисекунды.
   Никаких сообщений, ключей и идентификаторов здесь нет. */
drop policy if exists service_samples_read on public.service_samples;
create policy service_samples_read on public.service_samples
  for select to anon, authenticated using (true);

drop policy if exists service_samples_write on public.service_samples;
create policy service_samples_write on public.service_samples
  for all to service_role using (true) with check (true);

-- ── 3. Ночная чистка: +30 дней истории ─────────────────────
create or replace function public.relik_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ev int := 0;
  subs int := 0;
  q int := 0;
  samples int := 0;
begin
  begin
    delete from public.client_events where created_at < now() - interval '30 days';
    get diagnostics ev = row_count;
  exception when undefined_table then ev := 0;
  end;

  begin
    delete from public.push_subs
     where created_at < now() - interval '180 days'
       and (last_ok is null or last_ok < now() - interval '60 days');
    get diagnostics subs = row_count;
  exception when undefined_table then subs := 0;
  end;

  begin
    delete from public.push_queue where created_at < now() - interval '1 hour';
    get diagnostics q = row_count;
  exception when undefined_table then q := 0;
  end;

  begin
    delete from public.service_samples where ts < now() - interval '30 days';
    get diagnostics samples = row_count;
  exception when undefined_table then samples := 0;
  end;

  return jsonb_build_object(
    'events_deleted', ev,
    'subs_deleted', subs,
    'queue_deleted', q,
    'samples_deleted', samples
  );
end;
$$;

revoke all on function public.relik_maintenance() from public;
grant execute on function public.relik_maintenance() to service_role;

-- Проверка: последние срезы (должны появиться в течение 5 минут
-- после перезапуска relik-push).
-- select ts, ok, rest_ms, front_ms, down, ver
--   from public.service_samples order by ts desc limit 20;
