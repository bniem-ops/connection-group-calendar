-- Connection Group Calendar - reusable rotation sign-up sheet
-- Run after 04_rsvps.sql. Safe to re-run.
--
-- A sign-up is deliberately separate from an RSVP: you can claim a week's
-- snack slot without saying whether you're coming, and each occurrence has a
-- capped number of slots (2, for the weekly snack rotation) rather than an
-- open-ended list. Turn it on per event with a custom label - "Snack",
-- "Meal train", "Drinks" - so it's reusable, not snack-only.

alter table events add column if not exists signup_label text;              -- e.g. "Snack"; null = feature off for this event
alter table events add column if not exists signup_slots int not null default 2;

create table if not exists event_signups (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events(id) on delete cascade,
  occurrence_date date not null,
  user_id         uuid references members(user_id) on delete set null,     -- null when an admin assigns a name directly
  display_name    text,                                                    -- snapshot for admin-assigned rows (no member yet)
  note            text,                                                    -- what they're bringing, optional
  created_at      timestamptz not null default now(),
  check (user_id is not null or display_name is not null)
);
create index if not exists event_signups_occ_idx on event_signups (event_id, occurrence_date);

-- Enforce events.signup_slots atomically so two people can't both claim the
-- last slot in the same instant. (Best-effort under concurrent writes - fine
-- at this group's scale; not worth a serializable transaction.)
create or replace function check_signup_capacity() returns trigger
language plpgsql as $$
declare
  cap   int;
  taken int;
begin
  select signup_slots into cap from events where id = new.event_id;
  select count(*) into taken from event_signups
    where event_id = new.event_id and occurrence_date = new.occurrence_date;
  if taken >= coalesce(cap, 2) then
    raise exception 'That week is already full.';
  end if;
  return new;
end;
$$;

drop trigger if exists event_signups_capacity on event_signups;
create trigger event_signups_capacity
  before insert on event_signups
  for each row execute function check_signup_capacity();

alter table event_signups enable row level security;

-- Any signed-in caller (anonymous included) can see who's signed up.
drop policy if exists "read event_signups" on event_signups;
create policy "read event_signups" on event_signups for select
  using (auth.uid() is not null);

-- Claim a slot as yourself, or (admin) assign anyone - including someone who
-- hasn't opened the app yet, via display_name with no user_id.
drop policy if exists "insert event_signups" on event_signups;
create policy "insert event_signups" on event_signups for insert
  with check (auth.uid() is not null and (user_id = auth.uid() or is_admin()));

-- Edit your own note; admin edits/reassigns any row.
drop policy if exists "update event_signups" on event_signups;
create policy "update event_signups" on event_signups for update
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

-- Release your own slot; admin removes any.
drop policy if exists "delete event_signups" on event_signups;
create policy "delete event_signups" on event_signups for delete
  using (user_id = auth.uid() or is_admin());

-- Realtime, so an open slot disappears for everyone the moment it's claimed.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'event_signups'
  ) then
    execute 'alter publication supabase_realtime add table event_signups';
  end if;
end $$;

-- To turn this on for the weekly C-Group and back-fill the schedule you
-- already have:
--   update events set signup_label = 'Snack', signup_slots = 2
--     where title = 'Weekly C-Group';   -- adjust to match your event's title
--
--   insert into event_signups (event_id, occurrence_date, display_name, note) values
--     ('<that event''s id>', '2026-09-16', 'Beth', null),
--     ('<that event''s id>', '2026-09-16', 'the Millers', 'chips & salsa');
-- (Find the event's id with: select id, title from events where title = 'Weekly C-Group';)
