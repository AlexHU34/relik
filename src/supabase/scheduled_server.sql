-- ============================================================
-- Relik: серверная отправка отложенных сообщений
-- Выполнить один раз в Supabase → SQL Editor (или применить скриптом).
--
-- Клиент шифрует сообщение сразу при планировании и кладёт в
-- scheduled_messages только шифротекст + время. pg_cron раз в минуту
-- переносит готовые записи в messages и ставит push в очередь.
-- Так отложенное уходит, даже если приложение закрыто.
-- ============================================================

create table if not exists public.scheduled_messages (
  id           uuid primary key,
  chat_id      uuid not null,
  sender_id    uuid not null,
  due_at       timestamptz not null,
  payload      jsonb not null,
  attempts     integer not null default 0,
  error        text,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists scheduled_due_idx on public.scheduled_messages (due_at)
  where delivered_at is null;

alter table public.scheduled_messages enable row level security;

drop policy if exists scheduled_insert_own on public.scheduled_messages;
create policy scheduled_insert_own on public.scheduled_messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and public.is_conversation_member(chat_id, auth.uid())
  );

drop policy if exists scheduled_select_own on public.scheduled_messages;
create policy scheduled_select_own on public.scheduled_messages
  for select to authenticated
  using (sender_id = auth.uid());

drop policy if exists scheduled_delete_own on public.scheduled_messages;
create policy scheduled_delete_own on public.scheduled_messages
  for delete to authenticated
  using (sender_id = auth.uid());

drop policy if exists scheduled_update_own on public.scheduled_messages;
create policy scheduled_update_own on public.scheduled_messages
  for update to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

create or replace function public.relik_flush_scheduled()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select * from public.scheduled_messages
     where delivered_at is null and due_at <= now()
     order by due_at
     limit 50
     for update skip locked
  loop
    begin
      insert into public.messages (id, conversation_id, sender_id, ciphertext, iv, reply_to, deleted)
      values (
        (r.payload->>'id')::uuid,
        r.chat_id,
        r.sender_id,
        coalesce(r.payload->>'ciphertext', ''),
        coalesce(r.payload->>'iv', ''),
        nullif(r.payload->>'reply_to', '')::uuid,
        false
      )
      on conflict (id) do nothing;

      /* пуш получателям: очередь читает сервис на VPS */
      insert into public.push_queue (chat_id, from_user)
      values (r.chat_id, r.sender_id);

      update public.scheduled_messages
         set delivered_at = now(), error = null
       where id = r.id;
      n := n + 1;
    exception when others then
      update public.scheduled_messages
         set attempts = attempts + 1,
             error = left(sqlerrm, 200),
             delivered_at = case when attempts >= 5 then now() else null end
       where id = r.id;
    end;
  end loop;

  delete from public.scheduled_messages
   where delivered_at is not null and delivered_at < now() - interval '7 days';

  return n;
end;
$$;

revoke all on function public.relik_flush_scheduled() from public;
grant execute on function public.relik_flush_scheduled() to authenticated, service_role;

do $$
begin
  perform cron.unschedule('relik-scheduled');
exception when others then
  null;
end;
$$;

select cron.schedule('relik-scheduled', '* * * * *', 'select public.relik_flush_scheduled()');

-- Проверка: select * from cron.job where jobname = 'relik-scheduled';
