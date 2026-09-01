// Calendar date helpers: month-grid days, week ranges, day arithmetic.
// Pure date math in GROUP_TIMEZONE - no DOM, no framework.

import { fieldsToInstant, ymd, zonedParts, zonedTimeToInstant } from "./tz.js";

const WD_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const noonOf = (dateStr) => fieldsToInstant(dateStr, "12:00");

export function addDays(dateStr, n) {
  return ymd(new Date(noonOf(dateStr).getTime() + n * 86400000));
}

// The Sunday on/before dateStr.
export function startOfWeek(dateStr) {
  const lead = WD_ORDER.indexOf(zonedParts(noonOf(dateStr)).weekday);
  return addDays(dateStr, -lead);
}

export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// { startStr, endStr, days[7] } for the Sun..Sat week containing dateStr.
export function weekOf(dateStr) {
  const startStr = startOfWeek(dateStr);
  return { startStr, endStr: addDays(startStr, 6), days: weekDays(startStr) };
}

// The visible grid always starts on the Sunday on/before the 1st and covers
// 6 weeks, so month length never shifts the layout.
export function monthGridRange(year, month /* 1-12 */) {
  const first = zonedTimeToInstant(year, month, 1, 0, 0);
  const lead = WD_ORDER.indexOf(zonedParts(first).weekday);
  const start = new Date(first.getTime() - lead * 86400000);
  const end = new Date(start.getTime() + 42 * 86400000);
  return { start, end };
}

// 42 day descriptors for the month grid.
export function monthGridDays(year, month) {
  const { start } = monthGridRange(year, month);
  const out = [];
  for (let i = 0; i < 42; i++) {
    // noon dodges any DST edge when reading the parts.
    const p = zonedParts(new Date(start.getTime() + i * 86400000 + 12 * 3600000));
    out.push({
      dateStr: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
      day: p.day,
      inMonth: p.month === month,
    });
  }
  return out;
}
