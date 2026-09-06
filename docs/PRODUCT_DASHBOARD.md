# プロダクト ダッシュボード（GOONER PORTAL）

日別の open → wake → analysis → purchase、流入元（UTM）別の到達率、新規ユーザー数、継続(D1/D7)を
ヒロさん・さやかさんが**読み取り専用**で見られる画面。プロダクトを跨いで同じ形で読む設計（将来レオ追加が容易）。

- 画面: `/products`（ポータル左ナビの「プロダクト」タイル）
- 閲覧権限: 管理者ロール（**社長・秘書**）のみ。未ログイン=案内、権限なし=拒否
- サーバー: `/api/metrics`（service_role キーはVercel環境変数のみ。ブラウザには出さない）
- データ元: 各プロダクトの Supabase に置いた `analytics` スキーマの3ビューを読むだけ（集計はビュー側で完結）

## 追加/変更したファイル
- `products.html` … ダッシュボード画面（自己完結・新規ライブラリなし）
- `api/metrics.js` … API Route（GET / 認証 + ロール判定 + プロダクト別 service_role 読み取り）
- `gooner-portal.html` … 左ナビに「プロダクト」タイル（`products.html` へ遷移）を1つ追加
- `sql/rela_analytics_views.sql` … RELA 側に作る集計ビュー3つ（要 SQL Editor 実行）
- `.env.example` … 環境変数サンプルを追記

## デプロイ後に必要な手動作業（3つ）
1. **RELA の Supabase → SQL Editor** で `sql/rela_analytics_views.sql` を実行
   （既存テーブル/RLS/認証/課金には触れない。ビュー3つ作成＋analyticsをPostgRESTに公開）
   - 確認: `select * from analytics.v_daily_funnel order by day desc limit 5;` が返ること
2. **Vercel（kaisha-kanri）→ Settings → Environment Variables**（Production / Preview 両方）に追加:
   - `METRICS_RELA_URL = https://xmuvgobfompdwhgxnpis.supabase.co`
   - `METRICS_RELA_SERVICE_KEY = <RELA の service_role キー>`
   - （PORTAL の `SUPABASE_URL` / `SUPABASE_ANON_KEY`(publishable) / `SUPABASE_SERVICE_ROLE_KEY` は既存の設定を利用）
   - 追加後に再デプロイ（環境変数反映のため）
3. 管理者（社長/秘書）でポータルにログイン →「プロダクト」タイル →`/products` を開く

## ゆうしゃレオを追加するとき（将来・3行）
1. レオの Supabase に `sql/rela_analytics_views.sql` と**同名・同列**のビュー3つを作る（`wake` は「レオを起こした」相当イベントに読み替え）
2. Vercel に `METRICS_LEO_URL` / `METRICS_LEO_SERVICE_KEY` を追加
3. `api/metrics.js` の対応表はすでに `leo` を用意済み。画面の「ゆうしゃレオ」ボタンの `disabled` を外すだけ

## 2026-09-07 拡張（RELA全開示・コイン・3プロダクト）
- プロダクト構成を **RELA（稼働）／ゆうしゃレオ（準備中）／お茶の販売（準備中）** に。レオ/お茶は各Supabaseに同名ビュー＋環境変数(`METRICS_LEO_*`/`METRICS_TEA_*`)を入れ、`products.html`のボタン`disabled`を外せば有効化。
- チャネルバナー：**WEB（Stripe）＋Google Play／Apple非対応／集客=LP・Instagram・TikTok**、wakeのandroid(Google Play)/web内訳。
- RELA COIN（トークン）活動：付与(welcome180+gift)・購入(¥300/180)・利用(analysis回数)・推定消費(analysis×90)。
  **残高の正はRevenueCat**・課金ゲート(COINS_ENABLED)は現状オフのため消費は概算。
- 追加ビュー：`analytics.v_purchase_breakdown`（プラン/コイン購入の発生ベース）、`analytics.v_coin_activity`（コイン近似）。
  → 反映には RELA で `sql/rela_analytics_views.sql` を **再実行**（`create or replace` なので既存は上書き、新ビュー追加）。
- API view：`daily / utm / retention / purchases / coins` の5種。

## 触っていないもの
RELA の既存テーブル・RLS・認証・課金・`app_events` の insert / PORTAL の既存権限ロジック（追加のみ）。
service_role キーはコード・Git に一切入れていない（Vercel 環境変数のみ）。
