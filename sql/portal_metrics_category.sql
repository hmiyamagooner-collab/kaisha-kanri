-- PORTAL 側：記録できる指標セットの定義（業種を問わず画面「記録とグラフ」から追加・編集できる）
-- 実行先: PORTAL 自身の Supabase (gooner-portal, ref bckzazaghgomhyvdikmb)
-- 2026-09-24 に Supabase MCP (apply_migration: create_metrics_category) で適用済み。再実行は冪等。
-- 追加のみ。ブラウザから直接は触らず /api/records（service_role）経由のみ。

create table if not exists public.metrics_category (
  tenant_id text not null default 'gooner',
  id text not null,                              -- 半角英数字と_（例 'dayservice_ranking' / 'cat_abc123'）
  label text not null,                           -- 表示名（例 'デイサービス 全国ランキング'）
  period_type text not null default 'month',     -- 'month' | 'day'
  hint text,                                     -- 円卓が判断する手がかり（例 '毎月メールで届く全国ランキング'）
  items jsonb not null default '[]'::jsonb,      -- [{key:'全国順位', unit:'位', lowerIsBetter:true}, ...]
  sort int not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
alter table public.metrics_category enable row level security;
