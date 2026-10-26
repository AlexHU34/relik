-- ============================================================
-- Relik: витрина, шаринг предметов в чат, модерация выпусков
-- Supabase → SQL Editor → Run (можно повторно).
-- ============================================================

create table if not exists public.nft_shares (
  id         bigserial primary key,
  chat_id    uuid not null references public.conversations(id) on delete cascade,
  item_id    uuid not null references public.nft_items(id) on delete cascade,
  from_user  uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists nft_shares_chat_idx on public.nft_shares (chat_id, created_at);

alter table public.nft_shares enable row level security;

drop policy if exists nft_shares_read on public.nft_shares;
create policy nft_shares_read on public.nft_shares for select to authenticated
  using (exists (
    select 1 from public.conversation_members m
    where m.conversation_id = nft_shares.chat_id and m.user_id = auth.uid()
  ));

-- админ управляет выпусками
drop policy if exists nft_drops_admin on public.nft_drops;
create policy nft_drops_admin on public.nft_drops for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── показать предмет в чате (только владелец) ──────────────
create or replace function public.nft_share(p_item uuid, p_chat uuid)
returns public.nft_shares
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  row public.nft_shares;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.nft_items where id = p_item and owner_id = me) then
    raise exception 'not_owner';
  end if;
  if not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_chat and m.user_id = me
  ) then
    raise exception 'not_a_member';
  end if;

  insert into public.nft_shares (chat_id, item_id, from_user)
  values (p_chat, p_item, me)
  returning * into row;

  return row;
end;
$$;

revoke all on function public.nft_share(uuid, uuid) from public;
grant execute on function public.nft_share(uuid, uuid) to authenticated;

-- realtime: карточки появляются сразу
do $$
begin
  alter publication supabase_realtime add table public.nft_shares;
exception
  when duplicate_object then null;
  when undefined_object then null;
  when others then null;
end;
$$;
