-- Connection Group Calendar - push notifications for chat messages
-- Run after 05_chat.sql. Safe to re-run.
--
-- Prereqs (one-time, in the dashboard):
--   1. Deploy the Edge Function `notify-message` (Edge Functions -> Via Editor,
--      paste supabase/functions/notify-message/index.ts) and turn OFF
--      "Enforce JWT verification".
--   2. Set its secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
--      VAPID_SUBJECT (mailto:), WEBHOOK_SECRET (a long random string),
--      APP_URL (https://bniem-ops.github.io/connection-group-calendar).
--      SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
--   3. Database -> Extensions -> enable `pg_net`.
--   4. Fill PROJECT_REF and the same WEBHOOK_SECRET below, then run this file.
--
-- This uses pg_net directly rather than the Database Webhooks UI, which needs
-- the `supabase_functions` schema that isn't provisioned on every project.

-- Per-device opt-out is gone; mute lives on members.chat_muted (see 08).

create extension if not exists pg_net;

create or replace function notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url     := 'https://PROJECT_REF.supabase.co/functions/v1/notify-message',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', 'WEBHOOK_SECRET'
    ),
    body    := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
end;
$$;

drop trigger if exists on_message_created on messages;
create trigger on_message_created
  after insert on messages
  for each row execute function notify_new_message();
