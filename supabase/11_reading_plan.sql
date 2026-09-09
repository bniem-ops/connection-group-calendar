-- Connection Group Calendar - reading plan + "Amen" reactions
-- Run after 09_scripture.sql. Safe to re-run.
--
-- The `readings` log itself needs nothing. This adds an optional group plan
-- (a suggestion shown in a strip you can ignore) and a single reaction kind
-- on other people's readings. No plan is seeded - the plan strip and the
-- "The plan" tab stay empty until you insert one:
--
--   insert into reading_plans (name, subtitle, starts_on)
--   values ('John in 30 days', 'a chapter or so a morning', '2026-09-01')
--   returning id;
--   insert into reading_plan_days (plan_id, day_index, reference) values
--     ('<that-id>', 1, 'John 1:1-28'), ('<that-id>', 2, 'John 1:29-51'), ... ;

create table if not exists reading_plans (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  subtitle   text,
  starts_on  date not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists reading_plan_days (
  plan_id   uuid not null references reading_plans(id) on delete cascade,
  day_index int  not null check (day_index >= 1),
  reference text not null,
  primary key (plan_id, day_index)
);
-- The date for a plan day is starts_on + (day_index - 1); derived, never stored,
-- so shifting starts_on reschedules the whole plan.

create table if not exists reading_reactions (
  reading_id uuid not null references readings(id) on delete cascade,
  user_id    uuid not null references members(user_id) on delete cascade,
  kind       text not null default 'amen' check (kind = 'amen'),
  created_at timestamptz not null default now(),
  primary key (reading_id, user_id, kind)
);

alter table reading_plans      enable row level security;
alter table reading_plan_days  enable row level security;
alter table reading_reactions  enable row level security;

-- Anyone signed in (anonymous included) can read the plan and the reactions.
drop policy if exists "read reading_plans" on reading_plans;
create policy "read reading_plans" on reading_plans for select using (auth.uid() is not null);

drop policy if exists "read reading_plan_days" on reading_plan_days;
create policy "read reading_plan_days" on reading_plan_days for select using (auth.uid() is not null);

drop policy if exists "read reading_reactions" on reading_reactions;
create policy "read reading_reactions" on reading_reactions for select using (auth.uid() is not null);

-- The plan is admin-managed.
drop policy if exists "write reading_plans" on reading_plans;
create policy "write reading_plans" on reading_plans for all
  using (is_admin()) with check (is_admin());

drop policy if exists "write reading_plan_days" on reading_plan_days;
create policy "write reading_plan_days" on reading_plan_days for all
  using (is_admin()) with check (is_admin());

-- You add / remove only your own "Amen".
drop policy if exists "insert own reaction" on reading_reactions;
create policy "insert own reaction" on reading_reactions for insert
  with check (auth.uid() is not null and user_id = auth.uid());

drop policy if exists "delete own reaction" on reading_reactions;
create policy "delete own reaction" on reading_reactions for delete
  using (user_id = auth.uid());

-- Realtime for the reaction row (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reading_reactions'
  ) then
    execute 'alter publication supabase_realtime add table reading_reactions';
  end if;
end $$;
