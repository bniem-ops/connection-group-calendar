// Group chat data access + realtime, backed by the `messages` table.

import { supabase } from "./supabase.js";

// Recent history, oldest-first for display. The members() join pulls the
// poster's name in one round trip.
export async function fetchMessages(limit = 100) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, body, created_at, edited_at, deleted_at, user_id, members(display_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || [])
    .map((m) => ({ ...m, display_name: m.members ? m.members.display_name : null }))
    .reverse();
}

export async function sendMessage(userId, body) {
  const { data, error } = await supabase
    .from("messages")
    .insert({ user_id: userId, body })
    .select("id, body, created_at, user_id")
    .single();
  if (error) throw error;
  return data;
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
