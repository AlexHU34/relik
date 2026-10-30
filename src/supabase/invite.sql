-- ============================================================
-- Relik: код приглашения для регистрации
-- Выполнить в SQL Editor. Код по умолчанию: LAREK1999
-- ============================================================

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- RLS включён, политик нет: читать/писать напрямую через API нельзя
alter table public.app_settings enable row level security;

insert into public.app_settings (key, value)
values ('signup_code', 'LAREK1999')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Проверка кода на сервере (клиент не видит сам код)
create or replace function public.check_signup_code(code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_settings
    where key = 'signup_code'
      and upper(value) = upper(trim(code))
  );
$$;

grant execute on function public.check_signup_code(text) to anon, authenticated;

-- Поменять код позже:
-- update public.app_settings set value = 'НОВЫЙ-КОД', updated_at = now()
-- where key = 'signup_code';
