-- ============================================================================
-- RELA 本番 Supabase（ref: xmuvgobfompdwhgxnpis）で実行する集計ビュー
--   GOONER PORTAL の「プロダクト ダッシュボード」が service_role で読む。
--   既存テーブル・RLS・認証・課金・app_events の insert には一切触れない。
--   読み取り専用。anon / authenticated からは読めないようにする。
-- 実行場所: RELA Supabase → SQL Editor（postgres 権限で実行される）
-- ============================================================================

create schema if not exists analytics;

-- 1) 日別ファネル ---------------------------------------------------------------
create or replace view analytics.v_daily_funnel as
with days as (
  select generate_series(date '2026-08-25', (now() at time zone 'Asia/Tokyo')::date, interval '1 day')::date as d
),
u as (
  select (created_at at time zone 'Asia/Tokyo')::date as d, count(*) as new_users
  from auth.users group by 1
),
e as (
  select (created_at at time zone 'Asia/Tokyo')::date as d,
    count(distinct user_id) filter (where event='open')      as open_users,
    count(distinct user_id) filter (where event='wake')      as wake_users,
    count(distinct user_id) filter (where event='analysis')  as analysis_users,
    count(*)                filter (where event='analysis')  as analyses,
    count(distinct user_id) filter (where event='purchase')  as purchase_users,
    count(distinct user_id) filter (where event='wake' and platform='android') as wake_android,
    count(distinct user_id) filter (where event='wake' and platform='web')     as wake_web
  from public.app_events
  where coalesce(meta->'utm'->>'campaign','') <> 'utm_check'
  group by 1
)
select days.d as day,
  coalesce(u.new_users,0) as new_users,
  coalesce(e.open_users,0) as open_users,
  coalesce(e.wake_users,0) as wake_users,
  coalesce(e.wake_android,0) as wake_android,
  coalesce(e.wake_web,0) as wake_web,
  coalesce(e.analysis_users,0) as analysis_users,
  coalesce(e.analyses,0) as analyses,
  coalesce(e.purchase_users,0) as purchase_users
from days left join u on u.d=days.d left join e on e.d=days.d
order by 1;

-- 2) 流入元別ファネル（初回 open の UTM で first-touch 判定） -----------------------
create or replace view analytics.v_utm_funnel as
with first_touch as (
  select distinct on (user_id) user_id,
    coalesce(meta->'utm'->>'source', case when platform='android' then 'google_ads' else 'direct' end) as source,
    coalesce(meta->'utm'->>'medium','')  as medium,
    coalesce(meta->'utm'->>'content','') as content,
    (created_at at time zone 'Asia/Tokyo')::date as first_day
  from public.app_events
  where event='open' and coalesce(meta->'utm'->>'campaign','') <> 'utm_check'
  order by user_id, created_at
)
select f.source, f.medium, f.content, f.first_day,
  count(distinct f.user_id) as users,
  count(distinct case when e.event='wake' then e.user_id end)     as wake_users,
  count(distinct case when e.event='analysis' then e.user_id end) as analysis_users,
  count(distinct case when e.event='purchase' then e.user_id end) as purchase_users
from first_touch f
left join public.app_events e on e.user_id=f.user_id
group by 1,2,3,4
order by f.first_day desc, users desc;

-- 3) 継続（D1 / D7）：wake した日を起点に、その後戻ってきたか -----------------------
create or replace view analytics.v_retention as
with first_wake as (
  select user_id, min((created_at at time zone 'Asia/Tokyo')::date) as d0
  from public.app_events where event='wake' group by 1
)
select fw.d0 as cohort_day,
  count(*) as cohort_users,
  count(distinct case when (e.created_at at time zone 'Asia/Tokyo')::date = fw.d0 + 1 then e.user_id end) as d1_users,
  count(distinct case when (e.created_at at time zone 'Asia/Tokyo')::date = fw.d0 + 7 then e.user_id end) as d7_users
from first_wake fw
left join public.app_events e on e.user_id=fw.user_id and e.event='open'
group by 1 order by 1;

-- アクセス制御：サービスロール以外は読めない ---------------------------------------
revoke all on schema analytics from anon, authenticated;
revoke all on all tables in schema analytics from anon, authenticated;
grant usage on schema analytics to service_role;
grant select on all tables in schema analytics to service_role;

-- PostgREST に analytics スキーマを公開（PORTAL の API が service_role で読むため）。
-- 既定の公開スキーマ(public, storage, graphql_public)に analytics を足す。
-- ※プロジェクトで公開スキーマを独自変更している場合は下記の一覧を実態に合わせて調整すること。
alter role authenticator set pgrst.db_schemas = 'public, storage, graphql_public, analytics';
notify pgrst, 'reload config';

-- 確認:
--   select * from analytics.v_daily_funnel order by day desc limit 5;
