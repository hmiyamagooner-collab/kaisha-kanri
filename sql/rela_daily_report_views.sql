-- RELA 側：日次データ報告ビュー（analytics スキーマ・読み取り専用）
-- 実行先: RELA 本番 Supabase (ref xmuvgobfompdwhgxnpis) の SQL Editor
-- 触ってはいけない: 既存テーブル・RLS・認証・課金・app_events の insert 処理
-- 参照: Cursor指示書_追補_日次データ報告_20260907.md §1

-- 4) 日次レポート（表 A の自動取得分）
create or replace view analytics.v_daily_report as
with days as (
  select generate_series(date '2026-09-01', (now() at time zone 'Asia/Tokyo')::date, interval '1 day')::date as d
),
u as (
  select (created_at at time zone 'Asia/Tokyo')::date as d, count(*) as new_anon
  from auth.users where is_anonymous group by 1
),
ev as (
  select *, (created_at at time zone 'Asia/Tokyo')::date as d
  from public.app_events
  where coalesce(meta->'utm'->>'campaign','') <> 'utm_check'
),
wk as (
  select d, user_id from ev where event='wake' group by 1,2
),
ret as (
  select w.d, count(distinct w.user_id) as returned_2d
  from wk w
  join ev o on o.user_id=w.user_id and o.event='open' and o.d between w.d+1 and w.d+2
  group by 1
)
select days.d as day,
  coalesce(u.new_anon,0) as new_anon_users,
  (select count(distinct user_id) from ev where event='wake' and ev.d=days.d) as wake,
  (select count(distinct user_id) from ev where event='wake' and platform='android' and ev.d=days.d) as wake_android,
  (select count(distinct user_id) from ev where event='analysis' and ev.d=days.d) as analysis_users,
  (select count(distinct user_id) from ev where event='purchase' and ev.d=days.d) as purchase_users,
  coalesce(ret.returned_2d,0) as returned_2d,
  (select string_agg(distinct meta->'utm'->>'source', ',') from ev where meta->'utm'->>'source' is not null and ev.d=days.d) as utm_sources
from days left join u on u.d=days.d left join ret on ret.d=days.d
order by 1;

-- 5) 分析の内訳（表 B）
create or replace view analytics.v_analysis_breakdown as
select (created_at at time zone 'Asia/Tokyo')::date as day,
  coalesce(meta->>'type','unknown') as type,
  count(*) as analyses,
  count(distinct user_id) as users
from public.app_events
where event='analysis' and coalesce(meta->'utm'->>'campaign','') <> 'utm_check'
group by 1,2 order by 1,2;

grant select on all tables in schema analytics to service_role;
