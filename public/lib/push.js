// Web Push subscribe / unsubscribe, backed by the push_subscriptions table.

import { supabase } from "./supabase.js";
import { VAPID_PUBLIC_KEY } from "../config.js";
import { ensureAnonSession, getSession } from "./auth.js";

export function pushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function getReg() {
  return navigator.serviceWorker.ready;
}

export async function getStatus() {
  if (!pushSupported()) return { supported: false, subscribed: false, permission: "unsupported" };
  const reg = await getReg();
  const sub = await reg.pushManager.getSubscription();
  return {
    supported: true,
    subscribed: !!sub,
    permission: Notification.permission,
  };
}

export async function subscribe() {
  if (!pushSupported()) throw new Error("Push is not supported on this browser.");
  if (VAPID_PUBLIC_KEY.startsWith("TODO")) {
    throw new Error("VAPID public key not set in config.js.");
  }

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was not granted.");

  await ensureAnonSession();
  const session = await getSession();
  const reg = await getReg();

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: session.user.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 300),
      active: true,
    },
    { onConflict: "endpoint" }
  );
  if (error) throw error;
}

export async function unsubscribe() {
  const reg = await getReg();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  }
}
