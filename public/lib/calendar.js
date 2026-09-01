// Rolling-weeks rendering. Pure DOM, no framework.
// A week block = a 7-column date strip followed by that week's event entries.

import { GROUP_TIMEZONE } from "../config.js";
import { fieldsToInstant, ymd, zonedParts } from "./tz.js";

const WD_INITIAL = ["S", "M", "T", "W", "T", "F", "S"];
const WD_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WD_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// noon instant for a YYYY-MM-DD, safe against DST when reading date parts.
const noonOf = (dateStr) => fieldsToInstant(dateStr, "12:00");

export function addDays(dateStr, n) {
  return ymd(new Date(noonOf(dateStr).getTime() + n * 86400000));
}

// The Sunday on/before dateStr, as YYYY-MM-DD (in GROUP_TIMEZONE).
export function startOfWeek(dateStr) {
  const lead = WD_ORDER.indexOf(zonedParts(noonOf(dateStr)).weekday);
  return addDays(dateStr, -lead);
}

export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

const dayNum = (dateStr) => Number(dateStr.slice(8, 10));
const monthNum = (dateStr) => Number(dateStr.slice(5, 7));

// "AUG 30 – SEP 5"
export function weekSpanLabel(weekStart) {
  const end = addDays(weekStart, 6);
  return `${MON_ABBR[monthNum(weekStart) - 1]} ${dayNum(weekStart)} – ${MON_ABBR[monthNum(end) - 1]} ${dayNum(end)}`;
}

// The month a week "belongs to" for the sticky bar: the month of its Wednesday.
export function weekMonthKey(weekStart) {
  return addDays(weekStart, 3).slice(0, 7); // YYYY-MM
}
export function weekMonthLabel(weekStart) {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: GROUP_TIMEZONE })
    .format(noonOf(addDays(weekStart, 3)));
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// ctx: {
//   todayStr, curWeekStart, nextWeekStart,
//   occByDate: Map<dateStr, occ[]>,     // already category-filtered
//   catColor(id), catTextColor(id), catName(id),
//   shortTime(date),
//   renderRsvpControls(container, occ, 'strip'),   // fills RSVP row
//   canRsvp(occ),
//   onEntryClick(occ), onDateClick(dateStr),
// }
export function buildWeekBlock(weekStart, ctx) {
  const days = weekDays(weekStart);
  const repMonth = monthNum(addDays(weekStart, 3));

  const sec = el("section", "week");
  sec.dataset.weekStart = weekStart;
  sec.dataset.monthKey = weekMonthKey(weekStart);
  sec.dataset.monthLabel = weekMonthLabel(weekStart);

  // a. heading row
  const head = el("div", "week__head");
  let label = "";
  if (weekStart === ctx.curWeekStart) label = "THIS WEEK";
  else if (weekStart === ctx.nextWeekStart) label = "NEXT WEEK";
  const isCur = weekStart === ctx.curWeekStart;
  const labelEl = el("span", "week__label" + (isCur ? " week__label--cur" : ""), label);
  const rule = el("span", "week__rule" + (isCur ? " week__rule--cur" : ""));
  const span = el("span", "week__span", weekSpanLabel(weekStart));
  head.append(labelEl, rule, span);
  sec.appendChild(head);

  // b. date strip
  const strip = el("div", "week__strip");
  days.forEach((dstr, i) => {
    const list = (ctx.occByDate.get(dstr) || []).slice().sort((a, b) => a.start - b.start);
    const isToday = dstr === ctx.todayStr;
    const outside = monthNum(dstr) !== repMonth;
    const hasEv = list.length > 0;

    const col = el("button", "day");
    col.type = "button";
    col.dataset.date = dstr;
    if (isToday) col.classList.add("day--today");
    if (outside) col.classList.add("day--outside");
    if (hasEv) col.classList.add("day--events");

    col.appendChild(el("span", "day__wd", WD_INITIAL[i]));
    col.appendChild(el("span", "day__num", String(dayNum(dstr))));

    const bar = el("span", "day__bar" + (hasEv ? "" : " day__bar--empty"));
    if (hasEv) {
      list.slice(0, 4).forEach((o) => {
        const seg = el("i");
        seg.style.background = ctx.catColor(o.event.category_id);
        bar.appendChild(seg);
      });
    }
    col.appendChild(bar);
    col.addEventListener("click", () => ctx.onDateClick(dstr));
    strip.appendChild(col);
  });
  sec.appendChild(strip);

  // c. event entries for the week
  const weekOcc = [];
  for (const d of days) weekOcc.push(...(ctx.occByDate.get(d) || []));
  weekOcc.sort((a, b) => a.start - b.start || a.date.localeCompare(b.date));

  if (weekOcc.length) {
    const entries = el("div", "week__entries");
    let lastDate = null;
    for (const occ of weekOcc) {
      entries.appendChild(buildEntry(occ, occ.date !== lastDate, ctx));
      lastDate = occ.date;
    }
    sec.appendChild(entries);
  }
  return sec;
}

function buildEntry(occ, showGutter, ctx) {
  const ev = occ.event;
  const art = el("article", "entry");
  art.dataset.occ = `${ev.id}:${occ.date}`;

  const gutter = el("div", "entry__gutter");
  if (showGutter) {
    const wdIdx = WD_ORDER.indexOf(zonedParts(noonOf(occ.date)).weekday);
    gutter.appendChild(el("span", "entry__num", String(dayNum(occ.date))));
    gutter.appendChild(el("span", "entry__wd", WD_ABBR[wdIdx]));
  }
  art.appendChild(gutter);

  const body = el("div", "entry__body");

  const catRow = el("div", "entry__cat");
  const dot = el("span", "dot");
  dot.style.background = ctx.catColor(ev.category_id);
  const cname = el("span", "entry__catname", ctx.catName(ev.category_id).toUpperCase());
  cname.style.color = ctx.catTextColor(ev.category_id);
  const time = el("span", "entry__time", ev.all_day ? "All day" : ctx.shortTime(occ.start));
  catRow.append(dot, cname, time);
  body.appendChild(catRow);

  body.appendChild(el("h3", "entry__title", occ.overrideTitle || ev.title));

  const metaBits = [];
  if (occ.overrideLocation || ev.location) metaBits.push(occ.overrideLocation || ev.location);
  const note = (ev.description || "").split("\n")[0].trim();
  if (note) metaBits.push(note);
  if (metaBits.length) body.appendChild(el("p", "entry__meta", metaBits.join(" · ")));

  if (ev.rsvp_enabled && ctx.canRsvp(occ)) {
    const rsvp = el("div", "rsvp rsvp--strip");
    rsvp.dataset.occ = `${ev.id}:${occ.date}`;
    ctx.renderRsvpControls(rsvp, occ, "strip");
    body.appendChild(rsvp);
  }

  art.appendChild(body);
  art.addEventListener("click", (e) => {
    if (e.target.closest(".rsvp")) return;
    ctx.onEntryClick(occ);
  });
  return art;
}
