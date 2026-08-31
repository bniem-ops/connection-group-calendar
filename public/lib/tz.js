// Timezone helpers built on Intl - no dependencies.
// The whole app treats event times as wall-clock time in GROUP_TIMEZONE.

import { GROUP_TIMEZONE } from "../config.js";

// Milliseconds to add to a UTC instant to get the given zone's wall clock.
function zoneOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = dtf.formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Wall-clock (y, m, d, h, min) in GROUP_TIMEZONE -> real Date (UTC instant).
export function zonedTimeToInstant(y, m, d, h = 0, min = 0, tz = GROUP_TIMEZONE) {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  // One correction pass is exact except inside a DST transition hour.
  return new Date(guess.getTime() - zoneOffsetMs(guess, tz));
}

// "YYYY-MM-DD" + "HH:MM" (either may be empty) -> Date, interpreted in the zone.
export function fieldsToInstant(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  let h = 0, min = 0;
  if (timeStr) [h, min] = timeStr.split(":").map(Number);
  return zonedTimeToInstant(y, m, d, h, min);
}

// Date -> "YYYY-MM-DD" as seen in GROUP_TIMEZONE.
export function ymd(date, tz = GROUP_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// Date -> "HH:MM" (24h) as seen in GROUP_TIMEZONE.
export function hm(date, tz = GROUP_TIMEZONE) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

export function formatTime(date, tz = GROUP_TIMEZONE) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz, hour: "numeric", minute: "2-digit",
  }).format(date);
}

export function formatDateTime(date, tz = GROUP_TIMEZONE) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(date);
}

export function formatDateLong(date, tz = GROUP_TIMEZONE) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(date);
}

// Parts of a Date as seen in the zone (for building calendar grids).
export function zonedParts(date, tz = GROUP_TIMEZONE) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, weekday: p.weekday,
  };
}
