-- Group Calendar - seed data
-- Run after 02_policies.sql. Safe to re-run.

insert into categories (name, color, sort_order) values
  ('Weekly Meeting', '#2563eb', 1),
  ('Social',         '#16a34a', 2),
  ('Deadline',       '#dc2626', 3),
  ('Other',          '#6b7280', 4)
on conflict do nothing;

-- >>> EDIT THESE before running (or add real emails later from the app / SQL editor).
-- These must match the email each admin signs in with (magic link).
insert into admins (email) values
  ('admin1@example.com'),
  ('admin2@example.com'),
  ('admin3@example.com'),
  ('admin4@example.com')
on conflict do nothing;
