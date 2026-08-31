// Reminder sender. Run on a schedule (GitHub Actions cron). Idempotent:
// notification_log dedupes, so overlapping/late runs are safe.
//
// Non-secret config comes from public/config.js. Secrets come from env:
//   SUPABASE_SERVICE_ROLE_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT

import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import rrulePkg from "rrule";
const { rrulestr } = rrulePkg;
import {
  SUPABASE_URL, GROUP_TIMEZONE, APP_URL, VAPID_PUBLIC_KEY,
} from "../public/config.js";

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const LOOKBACK_MS = 90 * 60 * 1000; // catch reminders missed by a skipped run
const SLACK_MS = 5 * 60 * 1000;     // allow firing slightly early
const WINDOW_AHEAD_DAYS = 45;

function fail(msg) { console.error("ERROR:", msg); process.exit(1); }

if (!SERVICE_KEY) fail("SUPABASE_SERVICE_ROLE_KEY is not set.");
if (!VAPID_PRIVATE_KEY) fail("VAPID_PRIVATE_KEY is not set.");
if (String(SUPABASE_URL).startsWith("TODO")) fail("public/config.js still has placeholder SUPABASE_URL.");
if (String(VAPID_PUBLIC_KEY).startsWith("TODO")) fail("public/config.js still has placeholder VAPID_PUBLIC_KEY.");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const toICSUTC = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const ymdInTz = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: GROUP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
const timeInTz = (d) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: GROUP_TIMEZONE, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(d);

function expand(event, rangeStart, rangeEnd) {
  const start = new Date(event.starts_at);
  const cancelled = new Set(
    (event.exceptions || []).filter((x) => x.status === "cancelled").map((x) => x.occurrence_date)
  );
  let starts = [];
  if (!event.rrule) {
    if (start >= rangeStart && start < rangeEnd) starts = [start];
  } else {
    let rule;
    try {
      rule = rrulestr(`DTSTART:${toICSUTC(start)}\nRRULE:${event.rrule}`);
    } catch (e) {
      console.warn("bad rrule", event.id, e.message);
      return [];
    }
    let until = rangeEnd;
    if (event.recurrence_end) {
      const re = new Date(`${event.recurrence_end}T23:59:59Z`);
      if (re < until) until = re;
    }
    starts = rule.between(rangeStart, until, true);
  }
  return starts
    .map((s) => ({ start: s, date: ymdInTz(s) }))
    .filter((o) => !cancelled.has(o.date));
}

async function main() {
  const now = new Date();
  const rangeStart = new Date(now.getTime() - 2 * 86400000);
  const rangeEnd = new Date(now.getTime() + WINDOW_AHEAD_DAYS * 86400000);

  const [evRes, remRes, excRes, subRes, logRes] = await Promise.all([
    db.from("events").select("*"),
    db.from("event_reminders").select("*"),
    db.from("event_exceptions").select("*"),
    db.from("push_subscriptions").select("*").eq("active", true),
    db.from("notification_log").select("event_id, occurrence_date, reminder_offset_minutes")
      .gte("occurrence_date", ymdInTz(rangeStart)),
  ]);
  for (const r of [evRes, remRes, excRes, subRes, logRes]) if (r.error) fail(r.error.message);

  const remByEvent = new Map();
  for (const r of remRes.data) {
    if (!remByEvent.has(r.event_id)) remByEvent.set(r.event_id, []);
    remByEvent.get(r.event_id).push(r);
  }
  const excByEvent = new Map();
  for (const x of excRes.data) {
    if (!excByEvent.has(x.event_id)) excByEvent.set(x.event_id, []);
    excByEvent.get(x.event_id).push(x);
  }
  const already = new Set(
    logRes.data.map((l) => `${l.event_id}|${l.occurrence_date}|${l.reminder_offset_minutes}`)
  );

  const subs = subRes.data;
  console.log(`${subs.length} active subscription(s); ${evRes.data.length} event(s).`);
  if (!subs.length) { console.log("Nothing to send to. Done."); return; }

  const due = [];
  for (const ev of evRes.data) {
    const reminders = remByEvent.get(ev.id) || [];
    if (!reminders.length) continue;
    ev.exceptions = excByEvent.get(ev.id) || [];
    const occ = expand(ev, rangeStart, rangeEnd);
    for (const o of occ) {
      for (const r of reminders) {
        const fireAt = new Date(o.start.getTime() - r.offset_minutes * 60000);
        if (fireAt.getTime() > now.getTime() + SLACK_MS) continue;
        if (fireAt.getTime() < now.getTime() - LOOKBACK_MS) continue;
        const key = `${ev.id}|${o.date}|${r.offset_minutes}`;
        if (already.has(key)) continue;
        due.push({ ev, occ: o, offset: r.offset_minutes, key });
      }
    }
  }

  if (!due.length) { console.log("No reminders due this run."); return; }
  console.log(`${due.length} reminder(s) due.`);

  const deadEndpoints = new Set();
  for (const item of due) {
    const { ev, occ, offset, key } = item;
    const body = ev.all_day
      ? `${ymdInTz(occ.start)}${ev.location ? " · " + ev.location : ""}`
      : `${timeInTz(occ.start)}${ev.location ? " · " + ev.location : ""}`;
    const payload = JSON.stringify({
      title: ev.title,
      body,
      url: `${String(APP_URL).replace(/\/$/, "")}/?event=${ev.id}`,
      tag: key,
    });

    let ok = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload
          );
          ok++;
        } catch (err) {
          const code = err.statusCode || err.status;
          if (code === 404 || code === 410) deadEndpoints.add(s.endpoint);
          else console.warn(`send failed (${code}) for ${s.endpoint.slice(0, 40)}...`);
        }
      })
    );

    const ins = await db.from("notification_log").insert({
      event_id: ev.id,
      occurrence_date: occ.date,
      reminder_offset_minutes: offset,
    });
    if (ins.error && ins.error.code !== "23505") {
      console.warn("log insert failed:", ins.error.message);
    }
    console.log(`sent "${ev.title}" (${occ.date}, ${offset}m) to ${ok}/${subs.length}`);
  }

  if (deadEndpoints.size) {
    await db.from("push_subscriptions").delete().in("endpoint", [...deadEndpoints]);
    console.log(`pruned ${deadEndpoints.size} dead subscription(s).`);
  }
  console.log("Done.");
}

main().catch((e) => fail(e.stack || e.message));
