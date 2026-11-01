-- Relik — агрегаты клиентских замеров (Web Vitals) для публичной страницы статуса.
-- Выполнить один раз: supabase/perf_summary.sql
--
-- Зачем: приложение пишет perf_vitals/perf_nav (LCP, INP, CLS, TTFB) в
-- client_events. Читать таблицу анонимно нельзя (там user_id и контекст),
-- поэтому наружу отдаём только агрегаты за 24 часа — без идентификаторов
-- и без содержимого сообщений.
--
-- Безопасность: security definer + search_path=public, отдаёт только числа.

create index if not exists client_events_kind_created_idx
  on public.client_events (kind, created_at desc);

create or replace function public.perf_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ev as (
    select kind, data, created_at
    from public.client_events
    where created_at > now() - interval '24 hours'
      and kind in ('perf_vitals', 'perf_nav', 'perf_open_chat', 'perf_render_messages')
  ),
  v as (
    select
      count(*) as n,
      percentile_cont(0.5) within group (order by case when data->>'lcp' ~ '^[0-9]+$' then (data->>'lcp')::numeric end) as lcp_p50,
      percentile_cont(0.95) within group (order by case when data->>'lcp' ~ '^[0-9]+$' then (data->>'lcp')::numeric end) as lcp_p95,
      percentile_cont(0.5) within group (order by case when data->>'inp' ~ '^[0-9]+$' then (data->>'inp')::numeric end) as inp_p50,
      percentile_cont(0.95) within group (order by case when data->>'inp' ~ '^[0-9]+$' then (data->>'inp')::numeric end) as inp_p95,
      percentile_cont(0.5) within group (order by case when data->>'cls' ~ '^[0-9.]+$' then (data->>'cls')::numeric end) as cls_p50,
      percentile_cont(0.95) within group (order by case when data->>'cls' ~ '^[0-9.]+$' then (data->>'cls')::numeric end) as cls_p95
    from ev where kind = 'perf_vitals'
  ),
  nv as (
    select
      count(*) as n,
      percentile_cont(0.5) within group (order by case when data->>'ttfb' ~ '^[0-9]+$' then (data->>'ttfb')::numeric end) as ttfb_p50,
      percentile_cont(0.95) within group (order by case when data->>'ttfb' ~ '^[0-9]+$' then (data->>'ttfb')::numeric end) as ttfb_p95,
      percentile_cont(0.95) within group (order by case when data->>'load' ~ '^[0-9]+$' then (data->>'load')::numeric end) as load_p95
    from ev where kind = 'perf_nav'
  )
  select jsonb_build_object(
    'since', (select min(created_at) from ev),
    'vitals', (select to_jsonb(v) from v),
    'nav', (select to_jsonb(nv) from nv),
    'open_chat', (
      select jsonb_build_object(
        'n', count(*),
        'p50', percentile_cont(0.5) within group (order by case when data->>'ms' ~ '^[0-9]+$' then (data->>'ms')::numeric end),
        'p95', percentile_cont(0.95) within group (order by case when data->>'ms' ~ '^[0-9]+$' then (data->>'ms')::numeric end)
      ) from ev where kind = 'perf_open_chat'
    ),
    'render', (
      select jsonb_build_object(
        'n', count(*),
        'p50', percentile_cont(0.5) within group (order by case when data->>'ms' ~ '^[0-9]+$' then (data->>'ms')::numeric end),
        'p95', percentile_cont(0.95) within group (order by case when data->>'ms' ~ '^[0-9]+$' then (data->>'ms')::numeric end)
      ) from ev where kind = 'perf_render_messages'
    ),
    /* LCP p95 по типу сети: видно, «медленно у всех» или «медленно на 3G». */
    'by_ect', (
      select coalesce(jsonb_object_agg(ect, jsonb_build_object('n', n, 'p95', round(p95))), '{}'::jsonb)
      from (
        select coalesce(nullif(data->>'ect', ''), 'unknown') as ect,
               count(*) as n,
               percentile_cont(0.95) within group (
                 order by case when data->>'lcp' ~ '^[0-9]+$' then (data->>'lcp')::numeric end
               ) as p95
        from ev
        where kind = 'perf_vitals'
        group by 1
      ) s
    )
  );
$$;

revoke all on function public.perf_summary() from public;
grant execute on function public.perf_summary() to anon, authenticated;

comment on function public.perf_summary() is
  'Relik: агрегаты Web Vitals за 24 часа (без user_id и текстов) для tools/status.html';
