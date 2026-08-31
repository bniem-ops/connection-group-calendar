-- Group Calendar - schema
-- Run this in the Supabase SQL editor (once), then 02_policies.sql, then 03_seed.sql.

create extension if not exists "pgcrypto";

-- Event categories (admin-editable in the app)
create table if not exists categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text not null default '#3b82f6',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

-- Events. A row is either a one-off (rrule null) or a recurring series.
create table if not exists events (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  description    text,
  location       text,
  url            text,
  category_id    uuid references categories(id) on delete set null,
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  all_day        boolean not null default false,
  -- iCal RRULE body without DTSTART, e.g. 'FREQ=WEEKLY;INTERVAL=1'. Null = one-off.
  rrule          text,
  -- Optional hard stop for a recurring series (inclusive), as a calendar date.
  recurrence_end date,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists events_starts_at_idx on events (starts_at);

-- Reminder offsets for an event, in minutes before the occurrence start.
create table if not exists event_reminders (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references events(id) on delete cascade,
  offset_minutes int  not null,
  label          text
);
create index if not exists event_reminders_event_idx on event_reminders (event_id);

-- Per-occurrence overrides for a recurring series. v1 uses 'cancelled' only;
-- 'modified' columns are here so a later version can edit a single occurrence.
create table if not exists event_exceptions (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references events(id) on delete cascade,
  occurrence_date    date not null,
  status             text not null check (status in ('cancelled','modified')),
  override_title     text,
  override_starts_at timestamptz,
  override_ends_at   timestamptz,
  override_location  text,
  unique (event_id, occurrence_date)
);

-- Web Push subscriptions. One row per browser/device that opted in.
-- user_id is the Supabase anonymous-auth uid for that device.
create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Dedupe ledger so the reminder job sends each (occurrence, offset) once.
create table if not exists notification_log (
  id                      uuid primary key default gen_random_uuid(),
  event_id                uuid not null,
  occurrence_date         date not null,
  reminder_offset_minutes int  not null,
  sent_at                 timestamptz not null default now(),
  unique (event_id, occurrence_date, reminder_offset_minutes)
);

-- Allowlist of admin emails. Editable later without a code change.
create table if not exists admins (
  email    text primary key,
  added_at timestamptz not null default now()
);

-- keep events.updated_at fresh
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists events_set_updated_at on events;
create trigger events_set_updated_at
  before update on events
  for each row execute function set_updated_at();
