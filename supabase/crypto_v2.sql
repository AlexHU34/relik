-- ============================================================
-- Relik: протокол v2 — устройства, prekeys, конверт сообщения
-- Выполните в Supabase → SQL Editor → Run. Идемпотентно.
-- Это подготовка X3DH + Double Ratchet. Старые сообщения v1
-- продолжают читаться: crypto_version по умолчанию 1.
-- ============================================================

create table if not exists public.device_keys (
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null,
  identity_key text not null,              -- ECDH P-256 public (JWK)
  identity_sign_key text not null,         -- ECDSA P-256 public (JWK)
  signed_prekey_id integer not null,
  signed_prekey text not null,             -- ECDH public (JWK)
  signed_prekey_sig text not null,         -- base64url ECDSA signature
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

create index if not exists device_keys_by_user on public.device_keys(user_id);

alter table public.device_keys enable row level security;

drop policy if exists "device keys read" on public.device_keys;
create policy "device keys read"
  on public.device_keys for select
  using (auth.role() = 'authenticated');

drop policy if exists "own device keys write" on public.device_keys;
create policy "own device keys write"
  on public.device_keys for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Одноразовые prekeys. Читать может любой авторизованный,
-- удалять — только владелец. Для атомарной выдачи — RPC ниже.
create table if not exists public.one_time_prekeys (
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null,
  prekey_id integer not null,
  public_key text not null,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, device_id, prekey_id)
);

create index if not exists otp_by_device on public.one_time_prekeys(user_id, device_id, used);

alter table public.one_time_prekeys enable row level security;

drop policy if exists "otp read" on public.one_time_prekeys;
create policy "otp read"
  on public.one_time_prekeys for select
  using (auth.role() = 'authenticated' and used = false);

drop policy if exists "own otp write" on public.one_time_prekeys;
create policy "own otp write"
  on public.one_time_prekeys for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Атомарно забрать один prekey и пометить использованным.
create or replace function public.take_one_time_prekey(p_user uuid, p_device uuid)
returns table(prekey_id integer, public_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  picked public.one_time_prekeys%rowtype;
begin
  select * into picked
  from public.one_time_prekeys
  where user_id = p_user and device_id = p_device and used = false
  order by prekey_id
  limit 1
  for update skip locked;

  if picked.prekey_id is null then
    return;
  end if;

  update public.one_time_prekeys
    set used = true
    where user_id = p_user and device_id = p_device and prekey_id = picked.prekey_id;

  prekey_id := picked.prekey_id;
  public_key := picked.public_key;
  return next;
end;
$$;

revoke all on function public.take_one_time_prekey(uuid, uuid) from public;
grant execute on function public.take_one_time_prekey(uuid, uuid) to authenticated;

-- Конверт v2 в существующей таблице сообщений.
alter table public.messages add column if not exists crypto_version integer not null default 1;
alter table public.messages add column if not exists sender_device uuid;
alter table public.messages add column if not exists envelope jsonb;

comment on column public.messages.crypto_version is '1 = ECDH/AES v1, 2 = X3DH/Double Ratchet';
comment on column public.messages.envelope is 'v2 header/ciphertext without plaintext';
