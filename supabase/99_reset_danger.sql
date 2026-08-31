-- DANGER: drops every Group Calendar table and all its data.
-- Only use this if you want to start the schema over from scratch.

drop table if exists notification_log   cascade;
drop table if exists push_subscriptions cascade;
drop table if exists event_exceptions   cascade;
drop table if exists event_reminders    cascade;
drop table if exists events             cascade;
drop table if exists categories         cascade;
drop table if exists admins             cascade;
drop function if exists is_admin()      cascade;
drop function if exists set_updated_at() cascade;
