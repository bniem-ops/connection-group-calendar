// Admin authentication (magic link) + anonymous session for push subscribers.

import { supabase } from "./supabase.js";
import { APP_URL } from "../config.js";

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

export async function sendMagicLink(email) {
  const redirect = APP_URL && !APP_URL.startsWith("TODO") ? APP_URL : location.origin + location.pathname;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirect },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// Anonymous session so a push subscription row can be tied to (and only
// managed by) this device. No-op if already signed in (anon or admin).
export async function ensureAnonSession() {
  const session = await getSession();
  if (session) return session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

// Is this session a real (non-anonymous) email login? That plus being on the
// server admin list is what unlocks editing. The server still enforces it.
export function isEmailUser(session) {
  return !!session && !session.user.is_anonymous && !!session.user.email;
}
