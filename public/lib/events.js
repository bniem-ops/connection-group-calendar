// Data access for categories and events.

import { supabase } from "./supabase.js";

export async function fetchCategories() {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchEvents() {
  const [events, reminders, exceptions] = await Promise.all([
    supabase.from("events").select("*"),
    supabase.from("event_reminders").select("*"),
    supabase.from("event_exceptions").select("*"),
  ]);
  if (events.error) throw events.error;
  if (reminders.error) throw reminders.error;
  if (exceptions.error) throw exceptions.error;

  const byEvent = (rows, key) => {
    const m = new Map();
    for (const r of rows || []) {
      if (!m.has(r[key])) m.set(r[key], []);
      m.get(r[key]).push(r);
    }
    return m;
  };
  const rem = byEvent(reminders.data, "event_id");
  const exc = byEvent(exceptions.data, "event_id");

  return (events.data || []).map((e) => ({
    ...e,
    reminders: rem.get(e.id) || [],
    exceptions: exc.get(e.id) || [],
  }));
}

// payload: { title, description, location, url, category_id, starts_at, ends_at,
//            all_day, rrule, recurrence_end, reminders: [minutes,...] }
export async function saveEvent(payload, existingId) {
  const { reminders = [], ...row } = payload;
  let eventId = existingId;

  if (existingId) {
    const { error } = await supabase.from("events").update(row).eq("id", existingId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase.from("events").insert(row).select("id").single();
    if (error) throw error;
    eventId = data.id;
  }

  // Replace the reminder set wholesale - simplest correct approach.
  const del = await supabase.from("event_reminders").delete().eq("event_id", eventId);
  if (del.error) throw del.error;
  if (reminders.length) {
    const rows = reminders.map((m) => ({ event_id: eventId, offset_minutes: m }));
    const ins = await supabase.from("event_reminders").insert(rows);
    if (ins.error) throw ins.error;
  }
  return eventId;
}

export async function deleteEvent(id) {
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) throw error;
}

export async function cancelOccurrence(eventId, occurrenceDate) {
  const { error } = await supabase
    .from("event_exceptions")
    .upsert(
      { event_id: eventId, occurrence_date: occurrenceDate, status: "cancelled" },
      { onConflict: "event_id,occurrence_date" }
    );
  if (error) throw error;
}

export async function createCategory(name, color) {
  const { error } = await supabase.from("categories").insert({ name, color });
  if (error) throw error;
}

export async function updateCategory(id, patch) {
  const { error } = await supabase.from("categories").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteCategory(id) {
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw error;
}
