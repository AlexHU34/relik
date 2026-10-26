-- ============================================================
-- Relik: коллекционные предметы за Relics (офчейн)
-- Supabase → SQL Editor → Run (можно повторно).
-- Все проверки на сервере: номер, тираж, баланс, владение.
-- ============================================================

create sequence if not exists public.nft_serial_seq start 1;

create table if not exists public.nft_drops (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  art        text not null,
  rarity     text not null default 'common'
             check (rarity in ('common', 'rare', 'epic', 'legendary')),
  total      int not null check (total between 1 and 10000),
  price      int not null check (price between 1 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.nft_items (
  id         uuid primary key default gen_random_uuid(),
  drop_id    uuid not null references public.nft_drops(id) on delete cascade,
  serial     bigint not null default nextval('public.nft_serial_seq'),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  minted_at  timestamptz not null default now(),
  unique (drop_id, serial)
);
create index if not exists nft_items_owner_idx on public.nft_items (owner_id);
create index if not exists nft_items_drop_idx on public.nft_items (drop_id);

create table if not exists public.nft_transfers (
  id         bigserial primary key,
  item_id    uuid not null references public.nft_items(id) on delete cascade,
  from_user  uuid references public.profiles(id) on delete set null,
  to_user    uuid not null references public.profiles(id) on delete cascade,
  price      int not null default 0,
  kind       text not null default 'buy' check (kind in ('buy', 'gift')),
  created_at timestamptz not null default now()
);
create index if not exists nft_transfers_item_idx on public.nft_transfers (item_id, created_at desc);

create table if not exists public.nft_showcase (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  slot     smallint not null check (slot between 1 and 3),
  item_id  uuid not null references public.nft_items(id) on delete cascade,
  primary key (owner_id, slot),
  unique (item_id)
);

alter table public.nft_drops enable row level security;
alter table public.nft_items enable row level security;
alter table public.nft_transfers enable row level security;
alter table public.nft_showcase enable row level security;

drop policy if exists nft_drops_read on public.nft_drops;
create policy nft_drops_read on public.nft_drops for select to authenticated using (true);

drop policy if exists nft_items_read on public.nft_items;
create policy nft_items_read on public.nft_items for select to authenticated using (true);

drop policy if exists nft_transfers_read on public.nft_transfers;
create policy nft_transfers_read on public.nft_transfers for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

drop policy if exists nft_showcase_read on public.nft_showcase;
create policy nft_showcase_read on public.nft_showcase for select to authenticated using (true);

-- ── тираж: нельзя выпустить больше, чем заявлено ───────────
create or replace function public.nft_mint_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cap int;
  used int;
begin
  select total into cap from public.nft_drops where id = new.drop_id;
  if cap is null then
    raise exception 'drop_not_found';
  end if;
  select count(*) into used from public.nft_items where drop_id = new.drop_id;
  if used >= cap then
    raise exception 'sold_out';
  end if;
  return new;
end;
$$;

drop trigger if exists nft_mint_guard on public.nft_items;
create trigger nft_mint_guard
  before insert on public.nft_items
  for each row execute function public.nft_mint_guard();

-- ── покупка предмета за Relics ─────────────────────────────
create or replace function public.nft_buy(p_drop uuid)
returns public.nft_items
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  d public.nft_drops;
  item public.nft_items;
  bal int;
begin
  if me is null then raise exception 'not authenticated'; end if;

  select * into d from public.nft_drops where id = p_drop;
  if d.id is null then raise exception 'drop_not_found'; end if;
  if not d.active then raise exception 'drop_inactive'; end if;

  if (select count(*) from public.nft_items where drop_id = p_drop) >= d.total then
    raise exception 'sold_out';
  end if;

  perform public.relik_wallet_init();

  select balance into bal from public.wallets where user_id = me for update;
  if bal is null or bal < d.price then
    raise exception 'not_enough_relics';
  end if;

  update public.wallets set balance = balance - d.price, updated_at = now() where user_id = me;
  insert into public.wallet_tx (user_id, delta, reason, meta)
  values (me, -d.price, 'nft_buy', jsonb_build_object('drop', d.slug));

  insert into public.nft_items (drop_id, owner_id)
  values (p_drop, me)
  returning * into item;

  insert into public.nft_transfers (item_id, from_user, to_user, price, kind)
  values (item.id, null, me, d.price, 'buy');

  return item;
end;
$$;

-- ── передача предмета ──────────────────────────────────────
create or replace function public.nft_transfer(p_item uuid, p_to uuid)
returns public.nft_items
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  item public.nft_items;
  last_at timestamptz;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if p_to = me then raise exception 'self_transfer'; end if;

  select * into item from public.nft_items where id = p_item for update;
  if item.id is null then raise exception 'item_not_found'; end if;
  if item.owner_id <> me then raise exception 'not_owner'; end if;

  if not exists (select 1 from public.profiles p where p.id = p_to) then
    raise exception 'recipient_not_found';
  end if;

  select max(created_at) into last_at
  from public.nft_transfers
  where item_id = p_item and kind = 'gift';
  if last_at is not null and last_at > now() - interval '1 hour' then
    raise exception 'cooldown';
  end if;

  update public.nft_items set owner_id = p_to where id = p_item
  returning * into item;

  insert into public.nft_transfers (item_id, from_user, to_user, price, kind)
  values (p_item, me, p_to, 0, 'gift');

  delete from public.nft_showcase where item_id = p_item;

  return item;
end;
$$;

-- ── витрина профиля: 3 слота ───────────────────────────────
create or replace function public.nft_showcase_set(p_item uuid, p_slot int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if p_slot is null or p_slot < 1 or p_slot > 3 then raise exception 'invalid_slot'; end if;
  if not exists (select 1 from public.nft_items where id = p_item and owner_id = me) then
    raise exception 'not_owner';
  end if;

  delete from public.nft_showcase where owner_id = me and slot = p_slot;
  insert into public.nft_showcase (owner_id, slot, item_id)
  values (me, p_slot, p_item)
  on conflict (owner_id, slot) do update set item_id = excluded.item_id;
end;
$$;

revoke all on function public.nft_buy(uuid) from public;
revoke all on function public.nft_transfer(uuid, uuid) from public;
revoke all on function public.nft_showcase_set(uuid, int) from public;
grant execute on function public.nft_buy(uuid) to authenticated;
grant execute on function public.nft_transfer(uuid, uuid) to authenticated;
grant execute on function public.nft_showcase_set(uuid, int) to authenticated;

-- ── стартовые выпуски (арт уже лежит в assets/relics) ──────
insert into public.nft_drops (slug, name, art, rarity, total, price)
values
  ('scroll-wanderer', 'Свиток странника', 'assets/relics/relics-flat.png', 'common', 500, 10),
  ('scroll-keeper',   'Печать хранителя', 'assets/relics/relics-scroll.png', 'rare', 100, 50),
  ('scroll-moon',     'Лунный свиток',    'assets/relics/relics-glass.png', 'epic', 10, 250),
  ('scroll-origin',   'Первый свиток',    'assets/relics/relics-icon.png', 'legendary', 1, 2000)
on conflict (slug) do nothing;
