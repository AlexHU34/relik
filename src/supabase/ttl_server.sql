-- ============================================================
-- Relik: СЃРµСЂРІРµСЂРЅРѕРµ РёСЃС‚РµС‡РµРЅРёРµ TTL-СЃРѕРѕР±С‰РµРЅРёР№
-- Р’С‹РїРѕР»РЅРёС‚СЊ РѕРґРёРЅ СЂР°Р· РІ Supabase в†’ SQL Editor (РёР»Рё РїСЂРёРјРµРЅРёС‚СЊ СЃРєСЂРёРїС‚РѕРј).
--
-- РљР»РёРµРЅС‚ СЃРѕРѕР±С‰Р°РµС‚ СЃРµСЂРІРµСЂСѓ, РєРѕРіРґР° СЃРѕРѕР±С‰РµРЅРёРµ РґРѕР»Р¶РЅРѕ РёСЃС‡РµР·РЅСѓС‚СЊ
-- (С‚Р°Р±Р»РёС†Р° message_expiry вЂ” С‚РѕР»СЊРєРѕ РјРµС‚Р°РґР°РЅРЅС‹Рµ: id Рё РІСЂРµРјСЏ).
-- pg_cron СЂР°Р· РІ РјРёРЅСѓС‚Сѓ РїРѕРјРµС‡Р°РµС‚ С‚Р°РєРёРµ СЃРѕРѕР±С‰РµРЅРёСЏ deleted=true
-- Рё СЃС‚РёСЂР°РµС‚ С€РёС„СЂРѕС‚РµРєСЃС‚, РґР°Р¶Рµ РµСЃР»Рё РЅРё Сѓ РєРѕРіРѕ РЅРµ РѕС‚РєСЂС‹С‚Рѕ РїСЂРёР»РѕР¶РµРЅРёРµ.
--
-- РЎРѕРґРµСЂР¶РёРјРѕРµ РїРѕ-РїСЂРµР¶РЅРµРјСѓ РЅРµ С‡РёС‚Р°РµС‚СЃСЏ СЃРµСЂРІРµСЂРѕРј: РѕРЅ РІРёРґРёС‚ С‚РѕР»СЊРєРѕ
-- С€РёС„СЂРѕС‚РµРєСЃС‚ Рё РІСЂРµРјСЏ.
-- ============================================================

create extension if not exists pg_cron;

create table if not exists public.message_expiry (
  message_id uuid primary key references public.messages(id) on delete cascade,
  chat_id    uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists message_expiry_due_idx on public.message_expiry (expires_at);
create index if not exists message_expiry_chat_idx on public.message_expiry (chat_id);

alter table public.message_expiry enable row level security;

drop policy if exists expiry_insert_member on public.message_expiry;
create policy expiry_insert_member on public.message_expiry
  for insert to authenticated
  with check (public.is_conversation_member(chat_id, auth.uid()));

drop policy if exists expiry_select_member on public.message_expiry;
create policy expiry_select_member on public.message_expiry
  for select to authenticated
  using (public.is_conversation_member(chat_id, auth.uid()));

drop policy if exists expiry_delete_member on public.message_expiry;
create policy expiry_delete_member on public.message_expiry
  for delete to authenticated
  using (public.is_conversation_member(chat_id, auth.uid()));

/* РЎС‚РёСЂР°РЅРёРµ РїСЂРѕСЃСЂРѕС‡РµРЅРЅС‹С…: ciphertext Рё iv РѕР±РЅСѓР»СЏСЋС‚СЃСЏ, deleted=true.
   РљР»РёРµРЅС‚ РІРѕСЃРїСЂРёРЅРёРјР°РµС‚ СЌС‚Рѕ РєР°Рє В«СЃРѕРѕР±С‰РµРЅРёРµ СѓРґР°Р»РµРЅРѕВ». */
create or replace function public.relik_expire_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  update public.messages m
     set deleted = true,
         ciphertext = '',
         iv = ''
    from public.message_expiry e
   where e.message_id = m.id
     and e.expires_at <= now()
     and m.deleted = false;
  get diagnostics n = row_count;

  delete from public.message_expiry where expires_at <= now() - interval '1 day';
  return n;
end;
$$;

revoke all on function public.relik_expire_messages() from public;
grant execute on function public.relik_expire_messages() to authenticated, service_role;

/* Р Р°СЃРїРёСЃР°РЅРёРµ СЂР°Р· РІ РјРёРЅСѓС‚Сѓ */
do $$
begin
  perform cron.unschedule('relik-expire');
exception when others then
  null;
end;
$$;

select cron.schedule('relik-expire', '* * * * *', 'select public.relik_expire_messages()');

-- РџСЂРѕРІРµСЂРєР°: select * from cron.job where jobname = 'relik-expire';

