-- ============================================================
-- Relik — диагностика схемы (ТОЛЬКО ЧТЕНИЕ, ничего не меняет)
-- Supabase → SQL Editor → вставить целиком → Run.
-- Один результат: что применено, что нет. Пришлите его владельцу проекта.
-- ============================================================

with expected_tables(name, what) as (
  values
    ('profiles',            'профили'),
    ('conversations',       'чаты'),
    ('conversation_members','участники чатов'),
    ('messages',            'сообщения'),
    ('reactions',           'реакции'),
    ('read_receipts',       'старые отметки прочтения'),
    ('user_prefs',          'синхронные настройки'),
    ('contact_requests',    'заявки в контакты'),
    ('blocks',              'блокировки'),
    ('group_keys',          'ключи групп (v1.4)'),
    ('device_keys',         'устройства v2'),
    ('one_time_prekeys',    'prekeys v2'),
    ('push_subs',           'push-подписки'),
    ('push_queue',          'очередь push'),
    ('scheduled_messages',  'отложенные (сервер)'),
    ('message_expiry',      'TTL на сервере'),
    ('service_status',      'мониторинг: снимок'),
    ('service_samples',     'мониторинг: история'),
    ('client_events',       'клиентская телеметрия'),
    ('turn_config',         'секрет TURN'),
    ('app_settings',        'настройки приложения')
),
expected_funcs(name) as (
  values
    ('is_conversation_member'), ('is_conversation_creator'),
    ('check_signup_code'), ('search_people'),
    ('send_contact_request'), ('respond_contact_request'),
    ('cancel_contact_request'), ('remove_contact'),
    ('create_dm'), ('ensure_dm_member'), ('delete_my_account'),
    ('turn_creds'), ('take_one_time_prekey'),
    ('relik_expire_messages'), ('relik_flush_scheduled'), ('relik_maintenance')
),
expected_cols(tbl, col) as (
  values
    ('messages', 'crypto_version'), ('messages', 'envelope'),
    ('messages', 'sender_device'), ('messages', 'reply_to'),
    ('messages', 'edited'), ('messages', 'deleted'),
    ('conversations', 'kind'), ('profiles', 'username'),
    ('profiles', 'key_backup')
)
select 'таблица' as kind,
       e.name  as object,
       e.what  as detail,
       case when to_regclass('public.' || e.name) is not null
            then (select case when c.relrowsecurity then 'есть, RLS вкл' else 'есть, RLS ВЫКЛ' end
                    from pg_class c where c.oid = to_regclass('public.' || e.name))
            else 'НЕТ' end as status
  from expected_tables e
union all
select 'функция', f.name, '', 
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = f.name)
            then 'есть' else 'НЕТ' end
  from expected_funcs f
union all
select 'колонка', c.tbl || '.' || c.col, '',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = c.tbl and column_name = c.col)
            then 'есть' else 'НЕТ' end
  from expected_cols c
union all
select 'расширение', 'pg_trgm', 'поиск по людям',
       case when exists (select 1 from pg_extension where extname = 'pg_trgm') then 'есть' else 'НЕТ' end
union all
select 'бакет', b.id, 'Storage',
       case when exists (select 1 from storage.buckets where id = b.id) then 'есть' else 'НЕТ' end
  from (values ('files')) b(id)
order by kind desc, status, object;
