-- ============================================================
-- Relik: контакты и заявки в контакты
-- Выполните один раз в Supabase → SQL Editor → Run.
-- Создаёт таблицу contact_requests, RLS и три функции:
--   send_contact_request(target_user uuid)  -> text
--   respond_contact_request(req_id uuid, accept boolean)
--   cancel_contact_request(req_id uuid)
--   remove_contact(other_user uuid)
-- ============================================================

create table if not exists public.contact_requests (
  id           uuid primary key default gen_random_uuid(),
  from_user    uuid not null references public.profiles(id) on delete cascade,
  to_user      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint contact_requests_not_self check (from_user <> to_user),
  constraint contact_requests_pair_unique unique (from_user, to_user)
);

create index if not exists contact_requests_to_idx   on public.contact_requests (to_user);
create index if not exists contact_requests_from_idx on public.contact_requests (from_user);

alter table public.contact_requests enable row level security;

/* Читать можно только свои заявки (входящие и исходящие).
   Запись — только через SECURITY DEFINER функции ниже. */
drop policy if exists contact_requests_select on public.contact_requests;
create policy contact_requests_select on public.contact_requests
  for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

-- ── отправить заявку (или сразу принять встречную) ──
create or replace function public.send_contact_request(target_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if target_user is null or target_user = me then
    raise exception 'invalid target';
  end if;
  if not exists (select 1 from public.profiles p where p.id = target_user) then
    raise exception 'target profile not found';
  end if;

  /* уже есть принятая связь в любую сторону */
  if exists (
    select 1 from public.contact_requests r
    where r.status = 'accepted'
      and ((r.from_user = me and r.to_user = target_user)
        or (r.from_user = target_user and r.to_user = me))
  ) then
    return 'accepted';
  end if;

  /* он уже прислал мне заявку — сразу принимаем */
  update public.contact_requests r
     set status = 'accepted', responded_at = now()
   where r.from_user = target_user and r.to_user = me and r.status = 'pending';
  if found then
    return 'accepted';
  end if;

  insert into public.contact_requests (from_user, to_user, status)
  values (me, target_user, 'pending')
  on conflict (from_user, to_user) do update
     set status = 'pending', created_at = now(), responded_at = null;

  return 'pending';
end;
$$;

-- ── принять или отклонить входящую заявку ──
create or replace function public.respond_contact_request(req_id uuid, accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  update public.contact_requests r
     set status = case when accept then 'accepted' else 'declined' end,
         responded_at = now()
   where r.id = req_id and r.to_user = me and r.status = 'pending';

  if not found then
    raise exception 'request not found';
  end if;
end;
$$;

-- ── отменить свою исходящую заявку ──
create or replace function public.cancel_contact_request(req_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  delete from public.contact_requests r
   where r.id = req_id and r.from_user = me and r.status <> 'accepted';
end;
$$;

-- ── убрать из контактов (обе стороны) ──
create or replace function public.remove_contact(other_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  delete from public.contact_requests r
   where (r.from_user = me and r.to_user = other_user)
      or (r.from_user = other_user and r.to_user = me);
end;
$$;

revoke all on function public.send_contact_request(uuid) from public;
revoke all on function public.respond_contact_request(uuid, boolean) from public;
revoke all on function public.cancel_contact_request(uuid) from public;
revoke all on function public.remove_contact(uuid) from public;

grant execute on function public.send_contact_request(uuid) to authenticated;
grant execute on function public.respond_contact_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_contact_request(uuid) to authenticated;
grant execute on function public.remove_contact(uuid) to authenticated;

-- ── realtime: чтобы заявка прилетала сразу ──
do $$
begin
  alter publication supabase_realtime add table public.contact_requests;
exception
  when duplicate_object then null;
  when undefined_object then null;
  when others then null;
end;
$$;
