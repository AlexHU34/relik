-- Relik — короткоживущие TURN-креды (coturn «use-auth-secret»).
-- Применять один раз: SQL Editor → этот файл.
--
-- Зачем: статический логин/пароль в клиенте может забрать кто угодно.
-- Теперь клиент получает пару на 1 час, а секрет лежит в таблице,
-- к которой нет ни одной RLS-политики (значит, недоступна через API).
--
-- После применения:
--   1) в coturn.conf:  use-auth-secret = true,  static-auth-secret = <тот же секрет>
--   2) перезапустить coturn
--   3) из config.js убрать username/credential (оставить только urls/stunUrls)

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.turn_config (
  id      integer primary key default 1,
  login   text not null default 'relik',
  secret  text not null,
  ttl     integer not null default 3600,
  uris    jsonb not null default '["turn:62.113.99.46:3478?transport=udp","turn:62.113.99.46:3478?transport=tcp"]'::jsonb,
  constraint turn_config_single_row check (id = 1)
);

-- RLS включён и политик нет: читать может только SECURITY DEFINER-функция.
alter table public.turn_config enable row level security;
revoke all on public.turn_config from anon, authenticated;

-- ВАЖНО: замените секрет перед применением (или сразу после):
--   update public.turn_config set secret = 'ДЛИННАЯ_СЛУЧАЙНАЯ_СТРОКА' where id = 1;
insert into public.turn_config (id, secret)
values (1, 'CHANGE_ME_' || encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (id) do nothing;

create or replace function public.turn_creds()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cfg   public.turn_config;
  stamp bigint;
  uname text;
begin
  select * into cfg from public.turn_config where id = 1;
  if cfg.secret is null or cfg.secret = '' then
    raise exception 'turn_config is empty';
  end if;

  stamp := extract(epoch from now())::bigint + coalesce(cfg.ttl, 3600);
  uname := stamp::text || ':' || coalesce(cfg.login, 'relik');

  return jsonb_build_object(
    'username',   uname,
    'credential', encode(hmac(uname, cfg.secret, 'sha1'), 'base64'),
    'ttl',        coalesce(cfg.ttl, 3600),
    'uris',       cfg.uris
  );
end;
$$;

revoke all on function public.turn_creds() from public;
grant execute on function public.turn_creds() to anon, authenticated;
