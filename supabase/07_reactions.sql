-- Connection Group Calendar - message reactions
-- Run after 05_chat.sql. Safe to re-run.

create table if not exists message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references members(user_id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists message_reactions_msg_idx on message_reactions (message_id);

alter table message_reactions enable row level security;

drop policy if exists "read reactions" on message_reactions;
create policy "read reactions" on message_reactions for select
  using (auth.uid() is not null);

drop policy if exists "add own reaction" on message_reactions;
create policy "add own reaction" on message_reactions for insert
  with check (auth.uid() is not null and user_id = auth.uid());

drop policy if exists "remove own reaction" on message_reactions;
create policy "remove own reaction" on message_reactions for delete
  using (user_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    execute 'alter publication supabase_realtime add table message_reactions';
  end if;
end $$;
