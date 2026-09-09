// Data access + realtime for the daily scripture reading log (`readings`).

import { supabase } from "./supabase.js";

// Pin the members join to the user_id FK explicitly - cheap insurance against
// the "more than one relationship" ambiguity that bit the chat query.
const COLS =
  "id, user_id, reading_date, reference, note, created_at, updated_at, " +
  "members!readings_user_id_fkey(display_name)";

// Whole log, newest day first, oldest entry first within a day. Small table -
// the client buckets by reading_date, same as it does for RSVPs.
export async function fetchReadings() {
  const { data, error } = await supabase
    .from("readings")
    .select(COLS)
    .order("reading_date", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => ({
    ...r,
    display_name: r.members ? r.members.display_name : null,
  }));
}

// date: "YYYY-MM-DD". note is optional.
export async function addReading(userId, date, reference, note) {
  const row = { user_id: userId, reading_date: date, reference };
  if (note) row.note = note;
  const { data, error } = await supabase
    .from("readings")
    .insert(row)
    .select("id, user_id, reading_date, reference, note, created_at")
    .single();
  if (error) throw error;
  return data;
}

// patch: { reference?, note? }
export async function updateReading(id, patch) {
  const { error } = await supabase.from("readings").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteReading(id) {
  const { error } = await supabase.from("readings").delete().eq("id", id);
  if (error) throw error;
}

// Live INSERT/UPDATE/DELETE across the whole log. Returns an unsubscribe fn.
export function subscribeReadings(onChange) {
  const ch = supabase
    .channel("group-readings")
    .on("postgres_changes", { event: "*", schema: "public", table: "readings" },
      (p) => onChange && onChange(p))
    .subscribe();
  return () => supabase.removeChannel(ch);
}
