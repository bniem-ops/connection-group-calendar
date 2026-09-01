-- Group Calendar - seed data
-- Run after 02_policies.sql. Safe to re-run.

-- This group's categories. `color` is the dot / underline; the small-caps label
-- shade is derived (darkened) in the client. Idempotent: only inserts a name
-- that isn't already present.
insert into categories (name, color, sort_order)
select v.name, v.color, v.sort_order
from (values
  ('Weekly C-Group',         '#b68235', 1),
  ('Girls night',            '#a35a6b', 2),
  ('Guys night',             '#4a6670', 3),
  ('Worship night',          '#9c4f2f', 4),
  ('Football / watch party', '#5f7042', 5),
  ('Serve day / outreach',   '#3f6b5c', 6),
  ('Birthday',               '#7b6ca8', 7),
  ('Meal train / signup',    '#7d5411', 8)
) as v(name, color, sort_order)
where not exists (select 1 from categories c where c.name = v.name);

-- Drop the original scaffold categories, but only if nothing references them.
delete from categories
 where name in ('Weekly Meeting', 'Social', 'Deadline', 'Other')
   and not exists (select 1 from events e where e.category_id = categories.id);

-- Admins. Must match the email each admin signs in with (magic link).
-- Add or remove later from the app or the SQL editor without a code change.
insert into admins (email) values
  ('brentcniemerski@gmail.com'),
  ('ebniemerski@gmail.com')
on conflict do nothing;
