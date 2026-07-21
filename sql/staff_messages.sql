-- Optional: cross-device staff messaging persistence.
-- App works without this table (Realtime broadcast + localStorage).
-- Run in Supabase SQL editor if you want messages to persist across reloads/devices.

create table if not exists public.staff_messages (
  id text primary key,
  from_id uuid null,
  from_name text not null default '',
  to_id uuid null,
  to_all boolean not null default false,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists staff_messages_to_id_idx on public.staff_messages (to_id);
create index if not exists staff_messages_created_at_idx on public.staff_messages (created_at desc);

alter table public.staff_messages enable row level security;

drop policy if exists "staff_messages_select" on public.staff_messages;
create policy "staff_messages_select" on public.staff_messages
  for select to authenticated
  using (true);

drop policy if exists "staff_messages_insert" on public.staff_messages;
create policy "staff_messages_insert" on public.staff_messages
  for insert to authenticated
  with check (true);

-- Realtime (optional)
-- alter publication supabase_realtime add table public.staff_messages;
