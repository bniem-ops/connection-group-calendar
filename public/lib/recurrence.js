// Expand events (one-off or recurring) into concrete occurrences within a range.
// Shared shape with scripts/send-reminders.mjs (kept deliberately similar).

import { RRule, rrulestr } from "https://esm.sh/rrule@2.8.1";
import { ymd } from "./tz.js";

function toICSUTC(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// event: row from `events`, with optional `exceptions` array attached.
// Returns [{ event, start: Date, end: Date|null, date: "YYYY-MM-DD", recurring: bool }]
export function expandEvent(event, rangeStart, rangeEnd) {
  const start = new Date(event.starts_at);
  const durationMs = event.ends_at ? new Date(event.ends_at) - start : 0;
  const exceptions = new Map(
    (event.exceptions || []).map((x) => [x.occurrence_date, x])
  );

  let starts = [];
  if (!event.rrule) {
    if (start < rangeEnd && new Date(+start + durationMs) >= rangeStart) starts = [start];
  } else {
    let rule;
    try {
      rule = rrulestr(`DTSTART:${toICSUTC(start)}\nRRULE:${event.rrule}`);
    } catch (e) {
      console.warn("[recurrence] bad rrule for event", event.id, e);
      return [];
    }
    let until = rangeEnd;
    if (event.recurrence_end) {
      const re = new Date(`${event.recurrence_end}T23:59:59Z`);
      if (re < until) until = re;
    }
    starts = rule.between(rangeStart, until, true);
  }

  const out = [];
  for (const s of starts) {
    const date = ymd(s);
    const ex = exceptions.get(date);
    if (ex && ex.status === "cancelled") continue;
    let st = s;
    let en = durationMs ? new Date(+s + durationMs) : null;
    if (ex && ex.status === "modified") {
      if (ex.override_starts_at) st = new Date(ex.override_starts_at);
      if (ex.override_ends_at) en = new Date(ex.override_ends_at);
    }
    out.push({
      event,
      start: st,
      end: en,
      date,
      recurring: !!event.rrule,
      overrideTitle: ex && ex.status === "modified" ? ex.override_title : null,
      overrideLocation: ex && ex.status === "modified" ? ex.override_location : null,
    });
  }
  return out;
}

export function expandAll(events, rangeStart, rangeEnd) {
  const all = [];
  for (const ev of events) all.push(...expandEvent(ev, rangeStart, rangeEnd));
  all.sort((a, b) => a.start - b.start);
  return all;
}

// Build an RRULE body string from the simple editor fields.
export function buildRRule({ freq, interval }) {
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const n = Math.max(1, parseInt(interval, 10) || 1);
  if (n !== 1) parts.push(`INTERVAL=${n}`);
  return parts.join(";");
}

export function describeRRule(rrule, recurrenceEnd) {
  if (!rrule) return "";
  try {
    const r = RRule.fromString(`RRULE:${rrule}`);
    let s = r.toText();
    if (recurrenceEnd) s += ` (until ${recurrenceEnd})`;
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return rrule;
  }
}
