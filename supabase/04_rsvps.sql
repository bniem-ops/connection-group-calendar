-- Group Calendar - RSVP tables + policies
-- Run after 03_seed.sql. Safe to re-run.
--
-- Members already get a Supabase *anonymous* auth uid the first time they open
-- the app (same uid used for push_subscriptions). RSVPs and the one-time display
-- name reuse that uid - there is no separate login.

-- One row per person, created the first time they RSVP and give a name.
create table if not exists members (
  user_id      uuid primary key,          -- anonymous auth uid (auth.uid())
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- One RSVP per person per *occurrence*. Recurring events need a per-occurrence
-- answer, not one answer for the whole series - hence (event_id, occurrence_date).
create table if not exists rsvps (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references events(id) on delete cascade,
  occurrence_date date not null,
  user_id         uuid not null,
  status          text not null check (status in ('yes','no')),
  note            text,                    -- e.g. "bringing chili"
  updated_at      timestamptz not null default now(),
  unique (event_id, occurrence_date, user_id)
);
create index if not exists rsvps_event_idx on rsvps (event_id, occurrence_date);

-- Plate image for the event-detail screen. Optional; layout is correct without it.
alter table events add column if not exists photo_url text;

-- Whether the calendar shows an RSVP prompt for this event. Default on; an admin
-- can turn it off per event in the editor.
alter table events add column if not exists rsvp_enabled boolean not null default true;

-- keep rsvps.updated_at fresh on re-answer (reuses set_updated_at from 01_schema.sql)
drop trigger if exists rsvps_set_updated_at on rsvps;
create trigger rsvps_set_updated_at
  before update on rsvps
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table members enable row level security;
alter table rsvps   enable row level security;

-- Any signed-in caller (anonymous sessions included) can read every row - the
-- calendar shows who is coming by name, and the group is small.
drop policy if exists "read members" on members;
create policy "read members" on members for select
  using (auth.uid() is not null);

drop policy if exists "read rsvps" on rsvps;
create policy "read rsvps" on rsvps for select
  using (auth.uid() is not null);

-- ...but each person may only write their own row.
drop policy if exists "insert own member" on members;
create policy "insert own member" on members for insert
  with check (auth.uid() is not null and user_id = auth.uid());

drop policy if exists "update own member" on members;
create policy "update own member" on members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "delete own member" on members;
create policy "delete own member" on members for delete
  using (user_id = auth.uid());

drop policy if exists "insert own rsvp" on rsvps;
create policy "insert own rsvp" on rsvps for insert
  with check (auth.uid() is not null and user_id = auth.uid());

drop policy if exists "update own rsvp" on rsvps;
create policy "update own rsvp" on rsvps for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "delete own rsvp" on rsvps;
create policy "delete own rsvp" on rsvps for delete
  using (user_id = auth.uid());
