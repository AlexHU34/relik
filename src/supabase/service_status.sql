-- ============================================================
-- Relik: состояние сервера (VPS) внутри Supabase
-- VPS раз в минуту пишет сюда метрики; приложение читает их
-- и показывает состояние инфраструктуры без входа на сервер.
-- Supabase → SQL Editor → Run (можно повторно).
-- ============================================================

create table if not exists public.service_status (
  id            int primary key default 1,
  checked_at    timestamptz not null default now(),
  supabase_ok   boolean not null default false,
  supabase_ms   int,
  turn_ok       boolean not null default false,
  disk_free_gb  numeric(8,2),
  backup_age_h  numeric(8,1),
  queue_depth   int,
  push_ready    boolean not null default false,
  agent_version text,
  note          text
);

alter table public.service_status enable row level security;

/* Читают все (это агрегаты, без персональных данных), пишет только сервис. */
drop policy if exists service_status_read on public.service_status;
create policy service_status_read on public.service_status
  for select to anon, authenticated using (true);

drop policy if exists service_status_write on public.service_status;
create policy service_status_write on public.service_status
  for all to service_role using (true) with check (true);

insert into public.service_status (id) values (1)
on conflict (id) do nothing;

-- ── Обслуживание по расписанию ─────────────────────────────
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

  return jsonb_build_object('events_deleted', ev, 'subs_deleted', subs, 'queue_deleted', q);
end;
$$;

revoke all on function public.relik_maintenance() from public;
grant execute on function public.relik_maintenance() to service_role;
