-- ============================================================
-- Relik: сезоны, история предмета, доступ к истории для владельца
-- Supabase → SQL Editor → Run (можно повторно).
-- ============================================================

alter table public.nft_drops add column if not exists season text;
alter table public.nft_drops add column if not exists ends_at timestamptz;

update public.nft_drops
   set season = coalesce(season, 'Сезон 1')
 where season is null;

-- владелец предмета видит всю его историю
drop policy if exists nft_transfers_owner on public.nft_transfers;
create policy nft_transfers_owner on public.nft_transfers for select to authenticated
  using (exists (
    select 1 from public.nft_items i
    where i.id = nft_transfers.item_id and i.owner_id = auth.uid()
  ));

-- покупать можно только активные и не закончившиеся выпуски
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
  if d.ends_at is not null and d.ends_at < now() then
    raise exception 'drop_ended';
  end if;

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
