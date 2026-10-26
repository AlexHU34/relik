-- ============================================================
-- Relik: валюта «Relics» (внутренние подарки, как звёзды)
-- Supabase → SQL Editor → Run (можно повторно).
-- Всё считается на сервере: баланс нельзя накрутить из клиента.
-- ============================================================

create table if not exists public.wallets (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  balance    int not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_tx (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  delta      int not null,
  reason     text not null,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists wallet_tx_user_idx on public.wallet_tx (user_id, created_at desc);

create table if not exists public.gifts (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  from_user  uuid not null references public.profiles(id) on delete cascade,
  to_user    uuid not null references public.profiles(id) on delete cascade,
  amount     int not null check (amount between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists gifts_chat_idx on public.gifts (chat_id, created_at desc);
create index if not exists gifts_msg_idx on public.gifts (message_id);

alter table public.wallets enable row level security;
alter table public.wallet_tx enable row level security;
alter table public.gifts enable row level security;

drop policy if exists wallets_own on public.wallets;
create policy wallets_own on public.wallets for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists wallet_tx_own on public.wallet_tx;
create policy wallet_tx_own on public.wallet_tx for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists gifts_read on public.gifts;
create policy gifts_read on public.gifts for select to authenticated
  using (
    auth.uid() = from_user or auth.uid() = to_user
    or exists (
      select 1 from public.conversation_members m
      where m.conversation_id = gifts.chat_id and m.user_id = auth.uid()
    )
  );

-- ── кошелёк: создать и выдать приветственные Relics ────────
create or replace function public.relik_wallet_init()
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  w public.wallets;
begin
  if me is null then raise exception 'not authenticated'; end if;

  insert into public.wallets (user_id, balance)
  values (me, 25)
  on conflict (user_id) do nothing;

  insert into public.wallet_tx (user_id, delta, reason)
  select me, 25, 'welcome'
  where not exists (
    select 1 from public.wallet_tx t where t.user_id = me and t.reason = 'welcome'
  );

  select * into w from public.wallets where user_id = me;
  return w;
end;
$$;

-- ── ежедневный бонус: +5 раз в 20 часов ────────────────────
create or replace function public.relik_daily_bonus()
returns public.wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  last_at timestamptz;
  w public.wallets;
begin
  if me is null then raise exception 'not authenticated'; end if;

  perform public.relik_wallet_init();

  select max(created_at) into last_at
  from public.wallet_tx where user_id = me and reason = 'daily';

  if last_at is not null and last_at > now() - interval '20 hours' then
    raise exception 'bonus_too_early';
  end if;

  update public.wallets
     set balance = balance + 5, updated_at = now()
   where user_id = me;

  insert into public.wallet_tx (user_id, delta, reason) values (me, 5, 'daily');

  select * into w from public.wallets where user_id = me;
  return w;
end;
$$;

-- ── подарок: перевод Relics собеседнику за сообщение ───────
create or replace function public.relik_send_gift(
  p_chat uuid,
  p_message uuid,
  p_to uuid,
  p_amount int
)
returns public.gifts
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  my_balance int;
  g public.gifts;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000 then
    raise exception 'invalid_amount';
  end if;
  if p_to = me then raise exception 'self_gift'; end if;

  if not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_chat and m.user_id = me
  ) then
    raise exception 'not_a_member';
  end if;
  if not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_chat and m.user_id = p_to
  ) then
    raise exception 'recipient_not_a_member';
  end if;

  perform public.relik_wallet_init();

  select balance into my_balance from public.wallets where user_id = me for update;
  if my_balance < p_amount then raise exception 'not_enough_relics'; end if;

  update public.wallets set balance = balance - p_amount, updated_at = now() where user_id = me;
  update public.wallets set balance = balance + p_amount, updated_at = now()
   where user_id = p_to;
  if not found then
    insert into public.wallets (user_id, balance) values (p_to, p_amount);
  end if;

  insert into public.wallet_tx (user_id, delta, reason, meta)
  values (me, -p_amount, 'gift_out', jsonb_build_object('to', p_to, 'message', p_message));

  insert into public.wallet_tx (user_id, delta, reason, meta)
  values (p_to, p_amount, 'gift_in', jsonb_build_object('from', me, 'message', p_message));

  insert into public.gifts (chat_id, message_id, from_user, to_user, amount)
  values (p_chat, p_message, me, p_to, p_amount)
  returning * into g;

  return g;
end;
$$;

revoke all on function public.relik_wallet_init() from public;
revoke all on function public.relik_daily_bonus() from public;
revoke all on function public.relik_send_gift(uuid, uuid, uuid, int) from public;
grant execute on function public.relik_wallet_init() to authenticated;
grant execute on function public.relik_daily_bonus() to authenticated;
grant execute on function public.relik_send_gift(uuid, uuid, uuid, int) to authenticated;

-- realtime: подарки приходят сразу
do $$
begin
  alter publication supabase_realtime add table public.gifts;
exception
  when duplicate_object then null;
  when undefined_object then null;
  when others then null;
end;
$$;
