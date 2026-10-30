-- ============================================================
-- Relik: юзернеймы (@username) — выполнить один раз в Supabase
-- Латиница, цифры и _, 3–32 символа, уникальны без учёта регистра.
-- ============================================================

alter table public.profiles
  add column if not exists username text;

create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username))
  where username is not null;

-- Политика "read all profiles" уже позволяет искать по username,
-- "update own profile" — менять свой.
