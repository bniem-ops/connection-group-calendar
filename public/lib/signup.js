// Data access + realtime for the rotation sign-up sheet (`event_signups`).
// Distinct from RSVP: a slot doesn't require answering "are you coming", and
// each occurrence is capped at events.signup_slots.

import { supabase } from "./supabase.js";

const COLS = "id, event_id, occurrence_date, user_id, display_name, note, created_at";

// Small table - fetch the whole thing, same as RSVPs and readings.
export async function fetchSignups() {
  const { data, error } = await supabase
    .from("event_signups")
    .select(COLS)
    .order("occurrence_date", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Claim a slot as yourself.
export async function claimSignup(eventId, occurrenceDate, userId, note) {
  const row = { event_id: eventId, occurrence_date: occurrenceDate, user_id: userId };
  if (note) row.note = note;
  const { data, error } = await supabase
    .from("event_signups").insert(row).select(COLS).single();
  if (error) throw error;
  return data;
}

// Admin only (RLS-enforced): assign a name directly, no member row required -
// for backfilling a schedule someone hasn't opened the app for yet.
export async function assignSignup(eventId, occurrenceDate, displayName, note) {
  const row = { event_id: eventId, occurrence_date: occurrenceDate, display_name: displayName };
  if (note) row.note = note;
  const { data, error } = await supabase
    .from("event_signups").insert(row).select(COLS).single();
  if (error) throw error;
  return data;
}

export async function updateSignup(id, patch) {
  const { error } = await supabase.from("event_signups").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteSignup(id) {
  const { error } = await supabase.from("event_signups").delete().eq("id", id);
  if (error) throw error;
}

// Live INSERT/UPDATE/DELETE across the whole sheet. Returns an unsubscribe fn.
export function subscribeSignups(onChange) {
  const ch = supabase
    .channel("group-signups")
    .on("postgres_changes", { event: "*", schema: "public", table: "event_signups" },
      (p) => onChange && onChange(p))
    .subscribe();
  return () => supabase.removeChannel(ch);
}
