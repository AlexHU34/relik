-- ============================================================
-- Relik: ПОЛНОЕ удаление валюты Relics и коллекций (NFT)
-- Выполнять один раз в Supabase → SQL Editor.
--
-- ВНИМАНИЕ: операция необратима. Удаляются балансы, история
-- транзакций, подарки, выпуски и предметы. Клиент после этой
-- миграции валюту не использует вообще (файлы wallet.js/nft.js
-- удалены из проекта).
-- ============================================================

-- 1. Триггеры и функции
drop trigger if exists nft_mint_guard on public.nft_items;

drop function if exists public.nft_share(uuid, uuid);
drop function if exists public.nft_showcase_set(uuid, int);
drop function if exists public.nft_transfer(uuid, uuid);
drop function if exists public.nft_buy(uuid);
drop function if exists public.nft_mint_guard();
drop function if exists public.relik_send_gift(uuid, uuid, uuid, int);
drop function if exists public.relik_daily_bonus();
drop function if exists public.relik_wallet_init();

-- 2. Таблицы (порядок важен из-за внешних ключей)
drop table if exists public.nft_shares;
drop table if exists public.nft_showcase;
drop table if exists public.nft_transfers;
drop table if exists public.nft_items;
drop table if exists public.nft_drops;
drop table if exists public.gifts;
drop table if exists public.wallet_tx;
drop table if exists public.wallets;
drop sequence if exists public.nft_serial_seq;

-- 3. Проверка: должно вернуть 0 строк
-- select table_name from information_schema.tables
-- where table_schema = 'public'
--   and table_name in ('wallets','wallet_tx','gifts','nft_drops','nft_items','nft_transfers','nft_showcase','nft_shares');
