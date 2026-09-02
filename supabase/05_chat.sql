-- Connection Group Calendar - group chat
-- Run after 04_rsvps.sql. Safe to re-run.
--
-- One shared channel for the whole group. Posters are identified by the same
-- anonymous auth uid used for RSVPs; the members FK means you must pick a
-- display name (once) before you can post.

create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references members(user_id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted_at timestamptz          -- soft delete: row stays, UI shows "removed"
);
create index if not exists messages_created_idx on messages (created_at);

alter table messages enable row level security;

-- Any signed-in caller (anonymous sessions included) can read the channel.
drop policy if exists "read messages" on messages;
create policy "read messages" on messages for select
  using (auth.uid() is not null);

-- You can only post as yourself.
drop policy if exists "post own message" on messages;
create policy "post own message" on messages for insert
  with check (auth.uid() is not null and user_id = auth.uid());

-- Edit your own text; soft-delete your own, or anyone's if you're an admin.
drop policy if exists "update own message" on messages;
create policy "update own message" on messages for update
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

drop policy if exists "delete own or admin" on messages;
create policy "delete own or admin" on messages for delete
  using (user_id = auth.uid() or is_admin());

-- Realtime delivery (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table messages';
  end if;
end $$;
