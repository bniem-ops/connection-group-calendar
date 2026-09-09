-- Connection Group Calendar - daily scripture reading log
-- Run after 08_chat_attach.sql. Safe to re-run.
--
-- People open a day on the calendar and log what they read. Multiple entries
-- per person per day are allowed (Genesis 1 *and* Psalm 1), so there is no
-- unique constraint - the client buckets rows by reading_date.

create table if not exists readings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references members(user_id) on delete cascade,
  reading_date date not null,
  reference    text not null check (char_length(reference) between 1 and 200),  -- "John 3:16-21"
  note         text check (note is null or char_length(note) <= 2000),          -- optional reflection
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
create index if not exists readings_date_idx      on readings (reading_date);
create index if not exists readings_user_date_idx on readings (user_id, reading_date);

-- keep updated_at fresh on edit (reuses set_updated_at from 01_schema.sql)
drop trigger if exists readings_set_updated_at on readings;
create trigger readings_set_updated_at
  before update on readings
  for each row execute function set_updated_at();

alter table readings enable row level security;

-- Any signed-in caller (anonymous sessions included) can read the whole log -
-- the point is to see what the group is reading.
drop policy if exists "read readings" on readings;
create policy "read readings" on readings for select
  using (auth.uid() is not null);

-- You can only log as yourself.
drop policy if exists "insert own reading" on readings;
create policy "insert own reading" on readings for insert
  with check (auth.uid() is not null and user_id = auth.uid());

-- Edit / delete your own; an admin can tidy anyone's.
drop policy if exists "update own reading" on readings;
create policy "update own reading" on readings for update
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

drop policy if exists "delete own or admin reading" on readings;
create policy "delete own or admin reading" on readings for delete
  using (user_id = auth.uid() or is_admin());

-- Realtime delivery, so a "who's read today" view can update live (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'readings'
  ) then
    execute 'alter publication supabase_realtime add table readings';
  end if;
end $$;
