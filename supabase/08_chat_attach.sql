-- Connection Group Calendar - chat unread mark, per-person mute, event attach
-- Run after 07_reactions.sql. Safe to re-run.

-- Unread mark + mute now live on the member (per person), not per device.
alter table members add column if not exists last_read_at timestamptz;
alter table members add column if not exists chat_muted   boolean not null default false;

-- Fold the old per-device flag in, then drop it.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'push_subscriptions' and column_name = 'notify_chat'
  ) then
    update members m
       set chat_muted = true
     where chat_muted = false
       and not exists (
         select 1 from push_subscriptions p
         where p.user_id = m.user_id and p.notify_chat = true
       )
       and exists (select 1 from push_subscriptions p where p.user_id = m.user_id);
    alter table push_subscriptions drop column notify_chat;
  end if;
end $$;

-- A message can carry at most one attached event occurrence.
alter table messages add column if not exists attached_event_id        uuid references events(id) on delete set null;
alter table messages add column if not exists attached_occurrence_date date;

-- Let a member keep their own read cursor / mute up to date.
-- (members already has RLS from 04_rsvps.sql: read-all, write-own.)
