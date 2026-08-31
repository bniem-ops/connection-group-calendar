-- Group Calendar - Row Level Security
-- Run after 01_schema.sql.

alter table categories        enable row level security;
alter table events            enable row level security;
alter table event_reminders   enable row level security;
alter table event_exceptions  enable row level security;
alter table push_subscriptions enable row level security;
alter table notification_log  enable row level security;
alter table admins            enable row level security;

-- Is the caller an admin? SECURITY DEFINER so it can read `admins` regardless of
-- that table's own policies (avoids recursion).
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---- Public read of calendar content (no login needed to view) ----
drop policy if exists "read categories" on categories;
create policy "read categories" on categories for select using (true);

drop policy if exists "read events" on events;
create policy "read events" on events for select using (true);

drop policy if exists "read reminders" on event_reminders;
create policy "read reminders" on event_reminders for select using (true);

drop policy if exists "read exceptions" on event_exceptions;
create policy "read exceptions" on event_exceptions for select using (true);

-- ---- Admin-only writes ----
drop policy if exists "write categories" on categories;
create policy "write categories" on categories for all
  using (is_admin()) with check (is_admin());

drop policy if exists "write events" on events;
create policy "write events" on events for all
  using (is_admin()) with check (is_admin());

drop policy if exists "write reminders" on event_reminders;
create policy "write reminders" on event_reminders for all
  using (is_admin()) with check (is_admin());

drop policy if exists "write exceptions" on event_exceptions;
create policy "write exceptions" on event_exceptions for all
  using (is_admin()) with check (is_admin());

-- ---- admins table: only admins can see or change it ----
drop policy if exists "read admins" on admins;
create policy "read admins" on admins for select using (is_admin());

drop policy if exists "manage admins" on admins;
create policy "manage admins" on admins for all
  using (is_admin()) with check (is_admin());

-- ---- push_subscriptions: each device manages only its own rows ----
drop policy if exists "insert own subscription" on push_subscriptions;
create policy "insert own subscription" on push_subscriptions for insert
  with check (auth.uid() is not null and user_id = auth.uid());

drop policy if exists "read own subscription" on push_subscriptions;
create policy "read own subscription" on push_subscriptions for select
  using (user_id = auth.uid());

drop policy if exists "update own subscription" on push_subscriptions;
create policy "update own subscription" on push_subscriptions for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "delete own subscription" on push_subscriptions;
create policy "delete own subscription" on push_subscriptions for delete
  using (user_id = auth.uid());

-- notification_log: no policies => no client access at all.
-- The reminder job uses the service role key, which bypasses RLS.
