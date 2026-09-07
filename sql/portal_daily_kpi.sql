-- PORTAL 側：外部の数字（広告インストール/費用・IG/TikTok・Playインストール等）の手入力テーブル
-- 実行先: PORTAL 自身の Supabase (gooner-portal, ref bckzazaghgomhyvdikmb) の SQL Editor
-- ※ RELA の DB には作らない。daily_kpi 以外のテーブルは追加しない。
-- 参照: Cursor指示書_追補_日次データ報告_20260907.md §2

create table if not exists public.daily_kpi (
  id bigserial primary key,
  product text not null,          -- 'rela' | 'leo' ...
  day date not null,
  metric text not null,           -- 'google_installs' | 'google_cost' | 'ig_reach' | 'ig_profile_visits' | 'tiktok_views' | 'play_installs'
  value numeric not null,
  note text,
  updated_by uuid,
  updated_at timestamptz default now(),
  unique (product, day, metric)
);

-- RLS：PORTAL の管理者ロール（社長・秘書）のみ read/write
alter table public.daily_kpi enable row level security;

drop policy if exists daily_kpi_admin_all on public.daily_kpi;
create policy daily_kpi_admin_all on public.daily_kpi
  for all
  to authenticated
  using (
    exists (
      select 1 from public.members m
      where m.auth_user_id = auth.uid() and m.role in ('社長','秘書')
    )
  )
  with check (
    exists (
      select 1 from public.members m
      where m.auth_user_id = auth.uid() and m.role in ('社長','秘書')
    )
  );
