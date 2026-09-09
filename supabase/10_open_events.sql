-- Connection Group Calendar - open the calendar for everyone
-- Run after 04_rsvps.sql (which creates `members`). Safe to re-run.
--
-- Before: only admins could write events.
-- After:  any device with a session can add events and edit / delete only its
--         own; admins can still edit / delete anything. The calendar stays
--         publicly readable (the "read events" policy is untouched).

-- events.created_by already exists (01_schema.sql). Tie it to a member so every
-- event has an attributable name and survives that member being removed.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_created_by_fkey') then
    alter table events
      add constraint events_created_by_fkey
      foreign key (created_by) references members(user_id) on delete set null;
  end if;
end $$;

-- ---- events: per-operation writes ----
drop policy if exists "write events" on events;

-- Any signed-in caller (anonymous device sessions included) can add, but only
-- as themselves.
drop policy if exists "insert own event" on events;
create policy "insert own event" on events for insert
  with check (auth.uid() is not null and created_by = auth.uid());

-- Edit your own; admins edit anything. The WITH CHECK also stops a non-admin
-- from reassigning created_by to someone else.
drop policy if exists "update own or admin event" on events;
create policy "update own or admin event" on events for update
  using (created_by = auth.uid() or is_admin())
  with check (created_by = auth.uid() or is_admin());

-- Delete your own; admins delete anything.
drop policy if exists "delete own or admin event" on events;
create policy "delete own or admin event" on events for delete
  using (created_by = auth.uid() or is_admin());

-- ---- child tables: authorize through the parent event's owner ----
drop policy if exists "write reminders" on event_reminders;
create policy "write reminders" on event_reminders for all
  using (exists (
    select 1 from events e
    where e.id = event_reminders.event_id and (e.created_by = auth.uid() or is_admin())
  ))
  with check (exists (
    select 1 from events e
    where e.id = event_reminders.event_id and (e.created_by = auth.uid() or is_admin())
  ));

drop policy if exists "write exceptions" on event_exceptions;
create policy "write exceptions" on event_exceptions for all
  using (exists (
    select 1 from events e
    where e.id = event_exceptions.event_id and (e.created_by = auth.uid() or is_admin())
  ))
  with check (exists (
    select 1 from events e
    where e.id = event_exceptions.event_id and (e.created_by = auth.uid() or is_admin())
  ));

-- categories stay admin-only - regular users pick an existing label or leave it
-- blank. Open "write categories" the same way if you want that too.

-- Existing events have created_by = null, so only admins can edit / delete them.
-- To hand them to a specific admin instead, find that admin's auth uid and:
--   update events set created_by = '<that-admin-auth-uid>' where created_by is null;
