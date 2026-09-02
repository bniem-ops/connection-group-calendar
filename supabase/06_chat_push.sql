-- Connection Group Calendar - push notifications for chat messages
-- Run after 05_chat.sql. Safe to re-run.
--
-- Prereqs (one-time, outside SQL):
--   1. Deploy the Edge Function:
--        npx supabase functions deploy notify-message --no-verify-jwt
--   2. Set its secrets (VAPID_* are the same values as the reminder job):
--        npx supabase secrets set \
--          VAPID_PUBLIC_KEY=...  VAPID_PRIVATE_KEY=...  VAPID_SUBJECT=mailto:you@example.com \
--          WEBHOOK_SECRET=<a long random string>  APP_URL=https://bniem-ops.github.io/connection-group-calendar
--   3. Fill in PROJECT_REF and the same WEBHOOK_SECRET below, then run this file.

-- Per-device opt-out for chat pings (event reminders keep working regardless).
alter table push_subscriptions
  add column if not exists notify_chat boolean not null default true;

-- Call the Edge Function on every new message. Uses pg_net via the
-- supabase_functions schema (enabled by default on Supabase projects).
drop trigger if exists on_message_created on messages;
create trigger on_message_created
  after insert on messages
  for each row
  execute function supabase_functions.http_request(
    'https://PROJECT_REF.supabase.co/functions/v1/notify-message',
    'POST',
    '{"Content-Type":"application/json","x-webhook-secret":"WEBHOOK_SECRET"}',
    '{}',
    '5000'
  );

-- Alternative to the trigger above: Dashboard -> Database -> Webhooks ->
-- Create a new hook on `messages`, INSERT only, type "Supabase Edge Functions",
-- function notify-message, and add the header x-webhook-secret = <WEBHOOK_SECRET>.
