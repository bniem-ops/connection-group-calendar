// Group chat data access + realtime, backed by the `messages` table.

import { supabase } from "./supabase.js";

const MSG_COLS =
  "id, body, created_at, edited_at, deleted_at, user_id, " +
  "attached_event_id, attached_occurrence_date, members(display_name)";

// Recent history, oldest-first for display. The members() join pulls the
// poster's name in one round trip.
export async function fetchMessages(limit = 100) {
  const { data, error } = await supabase
    .from("messages")
    .select(MSG_COLS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || [])
    .map((m) => ({ ...m, display_name: m.members ? m.members.display_name : null }))
    .reverse();
}

// attach: { eventId, occurrenceDate } | null
export async function sendMessage(userId, body, attach) {
  const row = { user_id: userId, body };
  if (attach && attach.eventId) {
    row.attached_event_id = attach.eventId;
    row.attached_occurrence_date = attach.occurrenceDate || null;
  }
  const { data, error } = await supabase
    .from("messages")
    .insert(row)
    .select("id, body, created_at, user_id, attached_event_id, attached_occurrence_date")
    .single();
  if (error) throw error;
  return data;
}

// ---- member read-cursor + mute (per person) ----
export async function fetchMe(userId) {
  const { data } = await supabase
    .from("members").select("display_name, last_read_at, chat_muted")
    .eq("user_id", userId).maybeSingle();
  return data || null;
}

export async function markRead(userId) {
  await supabase.from("members").update({ last_read_at: new Date().toISOString() }).eq("user_id", userId);
}

export async function setMuted(userId, muted) {
  await supabase.from("members").update({ chat_muted: !!muted }).eq("user_id", userId);
}

export async function editMessage(id, body) {
  const { error } = await supabase
    .from("messages")
    .update({ body, edited_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function removeMessage(id) {
  const { error } = await supabase
    .from("messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

// ---- reactions ----
export async function fetchReactions(messageIds) {
  if (!messageIds.length) return [];
  const { data, error } = await supabase
    .from("message_reactions")
    .select("message_id, user_id, emoji")
    .in("message_id", messageIds);
  if (error) throw error;
  return data || [];
}

export async function addReaction(userId, messageId, emoji) {
  const { error } = await supabase
    .from("message_reactions")
    .insert({ message_id: messageId, user_id: userId, emoji });
  if (error && error.code !== "23505") throw error; // ignore "already reacted"
}

export async function removeReaction(userId, messageId, emoji) {
  const { error } = await supabase
    .from("message_reactions")
    .delete()
    .match({ message_id: messageId, user_id: userId, emoji });
  if (error) throw error;
}

// Live message INSERT/UPDATE + reaction INSERT/DELETE. Realtime respects RLS.
// Returns an unsubscribe function.
export function subscribeMessages({ onInsert, onUpdate, onReactionAdd, onReactionDel }) {
  const ch = supabase
    .channel("group-chat")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" },
      (p) => onInsert && onInsert(p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" },
      (p) => onUpdate && onUpdate(p.new))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "message_reactions" },
      (p) => onReactionAdd && onReactionAdd(p.new))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "message_reactions" },
      (p) => onReactionDel && onReactionDel(p.old))
    .subscribe();
  return () => supabase.removeChannel(ch);
}
