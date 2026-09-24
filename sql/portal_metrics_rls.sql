-- PORTAL 側：記録機能の RLS ポリシー（2026-09-24 に Supabase MCP で適用済み・再実行は冪等）
-- Vercel に service_role キーが無くても動くよう、ログイン中の管理者（members.role が 社長/秘書）だけに
-- metrics_record / metrics_category の読み書きを許可する。anon（未ログイン）は引き続き不可。
drop policy if exists metrics_record_admin_all on public.metrics_record;
create policy metrics_record_admin_all on public.metrics_record
  for all to authenticated
  using (exists (select 1 from public.members m where m.auth_user_id = auth.uid() and m.role in ('社長','秘書')))
  with check (exists (select 1 from public.members m where m.auth_user_id = auth.uid() and m.role in ('社長','秘書')));

drop policy if exists metrics_category_admin_all on public.metrics_category;
create policy metrics_category_admin_all on public.metrics_category
  for all to authenticated
  using (exists (select 1 from public.members m where m.auth_user_id = auth.uid() and m.role in ('社長','秘書')))
  with check (exists (select 1 from public.members m where m.auth_user_id = auth.uid() and m.role in ('社長','秘書')));
