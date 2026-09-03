// Edge Function: fan out a Web Push for each new chat message.
//
// Fired by a Database Webhook on INSERT into `messages` (see 06_chat_push.sql).
// Reuses the same VAPID keys as the reminder job.
//
// Deploy:  npx supabase functions deploy notify-message --no-verify-jwt
// Secrets: npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
//            VAPID_SUBJECT=mailto:you@example.com WEBHOOK_SECRET=... APP_URL=https://...
//          (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // Supabase webhook body: { type, table, schema, record, old_record }
  const payload = await req.json().catch(() => ({}));
  const msg = payload.record ?? payload;
  if (!msg?.id || !msg?.user_id || !msg?.body || msg.deleted_at) {
    return new Response(JSON.stringify({ skipped: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: sender } = await admin
    .from("members").select("display_name").eq("user_id", msg.user_id).single();
  const senderName = sender?.display_name ?? "Someone";

  // Mute is per person now (members.chat_muted), not per device.
  const { data: muted } = await admin.from("members").select("user_id").eq("chat_muted", true);
  const mutedSet = new Set((muted ?? []).map((m) => m.user_id));

  const { data: allSubs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, user_id")
    .eq("active", true)
    .neq("user_id", msg.user_id);
  const subs = (allSubs ?? []).filter((s) => !mutedSet.has(s.user_id));

  const text = String(msg.body).trim();
  const singleUrl = /^https:\/\/\S+$/.test(text) && !/\s/.test(text);
  const preview = singleUrl
    ? (/\.(gif|png|jpe?g|webp)(\?|$)/i.test(text) || /giphy\.com|tenor\.com/i.test(text) ? "sent a GIF" : "sent a link")
    : (text.length > 140 ? text.slice(0, 139) + "…" : text);
  const notification = JSON.stringify({
    title: senderName,
    body: preview,
    url: (APP_URL || ".") + "/?chat=1",
    tag: `chat-${msg.id}`,
  });

  let sent = 0;
  let pruned = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        notification,
      );
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").update({ active: false }).eq("id", s.id);
        pruned++;
      } else {
        console.error("push failed", code, (err as Error)?.message);
      }
    }
  }));

  return new Response(JSON.stringify({ sent, pruned }), {
    headers: { "Content-Type": "application/json" },
  });
});
