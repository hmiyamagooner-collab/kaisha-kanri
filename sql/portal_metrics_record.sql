-- PORTAL 側：円卓/手入力から記録する指標テーブル（仕様メモ「円卓に投げると、記録してグラフになる」§3）
-- 実行先: PORTAL 自身の Supabase (gooner-portal, ref bckzazaghgomhyvdikmb)
-- 2026-09-24 に Supabase MCP (apply_migration: create_metrics_record) で適用済み。再実行は冪等。
-- 追加のみ。既存テーブル・権限には触れない。ブラウザから直接は読み書きせず /api/records（service_role）経由のみ。

create table if not exists public.metrics_record (
  id bigserial primary key,
  tenant_id text not null default 'gooner',   -- 将来の他社導入用
  category text not null,                      -- 例: 'dayservice_ranking'
  item text not null,                          -- 例: '全国順位'
  period text not null,                        -- 例: '2026-09'（月次）または 'YYYY-MM-DD'
  value numeric not null,
  unit text,                                   -- 例: '位' / '人' / '%'
  source text not null default 'manual',      -- 'email' | 'manual' | 'entaku'
  raw_text text,                               -- 貼り付けた原文（検算用）
  confirmed_by text,                           -- 確認した人（members.name）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, category, item, period)
);
create index if not exists metrics_record_lookup on public.metrics_record (tenant_id, category, period);
-- RLS 有効・ポリシー無し = anon/authenticated からは不可視。service_role（API）だけが読み書きする
alter table public.metrics_record enable row level security;
