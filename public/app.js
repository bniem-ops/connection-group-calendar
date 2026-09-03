// Connection Group Calendar - app entry / wiring.
// Mobile: month grid + swappable day section (design 1a). >=1100px: three-column
// admin layout (2c) with a slide-in composer (2d).

import { supabase } from "./lib/supabase.js";
import { GROUP_TIMEZONE } from "./config.js";
import {
  fetchCategories, fetchEvents, saveEvent, deleteEvent, cancelOccurrence,
  updateEventTiming, createCategory, updateCategory, deleteCategory,
  fetchRsvps, fetchMembers, setDisplayName, setRsvp, clearRsvp,
} from "./lib/events.js";
import { expandAll, buildRRule } from "./lib/recurrence.js";
import {
  fetchMessages, sendMessage, removeMessage, subscribeMessages,
  fetchReactions, addReaction, removeReaction,
  fetchMe, markRead, setMuted,
} from "./lib/chat.js";
import { monthGridDays, weekOf, addDays, startOfWeek } from "./lib/calendar.js";
import {
  getSession, onAuthChange, sendMagicLink, signOut, isEmailUser, ensureAnonSession,
} from "./lib/auth.js";
import {
  pushSupported, getStatus as pushStatus, subscribe as pushSubscribe,
  unsubscribe as pushUnsubscribe,
} from "./lib/push.js";
import { fieldsToInstant, ymd, zonedParts, formatTime } from "./lib/tz.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const HIDDEN_KEY = "gc.hiddenCategories";
const TAB_KEY = "gc.tab";
const SMOOTH = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
const isDesktop = () => matchMedia("(min-width: 1100px)").matches;

const state = {
  todayStr: "",
  visible: { year: 0, month: 0 },   // 1-12
  selectedDate: "",

  categories: [],
  events: [],
  occByDate: new Map(),

  rsvps: [],
  members: new Map(),
  rsvpMine: new Map(),
  rsvpCounts: new Map(),
  myUserId: null,

  focusedKey: null,                 // desktop right-rail focused occurrence

  session: null,
  isAdmin: false,
  hidden: new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")),

  composer: { open: false, mode: "new", eventId: null },
  activeTab: "calendar",
  chat: {
    loaded: false, msgs: [], reax: [], unsub: null,
    muted: false, lastReadAt: null,
    attach: null,            // draft: { eventId, occurrenceDate }
    attachExpanded: false,
  },
};

// ---------- helpers ----------
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const pad = (n) => String(n).padStart(2, "0");
const catById = (id) => state.categories.find((c) => c.id === id);
const catColor = (id) => (catById(id) ? catById(id).color : "#7d5411");
const catName = (id) => (catById(id) ? catById(id).name : "Uncategorized");
// Exact small-caps label shades from the handoff, keyed by the dot color.
// Anything not in the table falls back to a darkened step.
const LABEL_SHADE = {
  "#b68235": "#7d5411", "#a35a6b": "#8a4a59", "#4a6670": "#3d5560",
  "#9c4f2f": "#8a4526", "#5f7042": "#4a5a33", "#3f6b5c": "#33574a",
  "#7b6ca8": "#655691", "#7d5411": "#7d5411",
};
const catTextColor = (id) => {
  const c = catById(id);
  if (!c) return "#7d5411";
  return LABEL_SHADE[String(c.color).toLowerCase()] || darken(c.color, 0.62);
};
const occKey = (o) => `${o.event.id}:${o.date}`;
const splitKey = (k) => { const i = k.lastIndexOf(":"); return [k.slice(0, i), k.slice(i + 1)]; };
const dayNum = (dstr) => Number(dstr.slice(8, 10));

function darken(hex, f) {
  const n = String(hex).replace("#", "");
  if (n.length !== 6) return hex;
  const p = (i) => parseInt(n.slice(i, i + 2), 16);
  const h = (x) => Math.max(0, Math.min(255, Math.round(x * f))).toString(16).padStart(2, "0");
  return `#${h(p(0))}${h(p(2))}${h(p(4))}`;
}
function hexToRgba(hex, a) {
  const n = String(hex).replace("#", "");
  if (n.length !== 6) return `rgba(182,130,53,${a})`;
  const p = (i) => parseInt(n.slice(i, i + 2), 16);
  return `rgba(${p(0)},${p(2)},${p(4)},${a})`;
}
function shortTime(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: GROUP_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(date);
  const g = (t) => (parts.find((z) => z.type === t) || {}).value || "";
  return `${g("hour")}:${g("minute")}${g("dayPeriod").toLowerCase().startsWith("p") ? "p" : "a"}`;
}
function timeLabel(occ) {
  const ev = occ.event;
  if (ev.all_day) return "All day";
  return occ.end ? `${shortTime(occ.start)} – ${shortTime(occ.end)}` : shortTime(occ.start);
}
function longDate(date) {
  return new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, weekday: "short", month: "short", day: "numeric" }).format(date);
}
// Return a short timezone label (e.g. "EST") for the configured zone.
function tzAbbrev(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, timeZoneName: "short" }).formatToParts(date);
    const tzn = parts.find((p) => p.type === "timeZoneName");
    return (tzn && tzn.value) || GROUP_TIMEZONE;
  } catch (e) {
    return GROUP_TIMEZONE;
  }
}
function monthLabelParts(y, m) {
  const d = fieldsToInstant(`${y}-${pad(m)}-15`, "12:00");
  return {
    month: new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "long" }).format(d),
    year: String(y),
  };
}
function minutesToText(m) {
  let n, unit;
  if (m % 1440 === 0) { n = m / 1440; unit = "day"; }
  else if (m % 60 === 0) { n = m / 60; unit = "hour"; }
  else { n = m; unit = "minute"; }
  return `${n} ${unit}${n === 1 ? "" : "s"} before`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function friendly(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/row-level security|permission denied|violates/i.test(m)) return "The server rejected that - your account isn't allowed to make this change.";
  return m;
}
function setStatus(msg) { $("#status-line").textContent = msg || `Times shown in ${tzAbbrev()}`; }

// ---------- data ----------
async function loadData() {
  try {
    const [cats, evs] = await Promise.all([fetchCategories(), fetchEvents()]);
    state.categories = cats;
    state.events = evs;
    await loadRsvpData();
    renderAll();
    setStatus();
  } catch (e) {
    console.error(e);
    setStatus("Could not load data. Check public/config.js and that the SQL was run.");
  }
}
async function loadRsvpData() {
  if (!state.myUserId) return;
  try {
    const [rsvps, members] = await Promise.all([fetchRsvps(), fetchMembers()]);
    state.rsvps = rsvps;
    state.members = members;
    recomputeRsvp();
  } catch (e) { console.warn("RSVP load failed", e); }
}
function recomputeRsvp() {
  state.rsvpMine = new Map();
  state.rsvpCounts = new Map();
  for (const r of state.rsvps) {
    const key = `${r.event_id}:${r.occurrence_date}`;
    let c = state.rsvpCounts.get(key);
    if (!c) { c = { yes: 0, no: 0, yesNames: [], noNames: [], noteBits: [] }; state.rsvpCounts.set(key, c); }
    const nm = state.members.get(r.user_id) || "Someone";
    if (r.status === "yes") { c.yes++; c.yesNames.push(nm); } else { c.no++; c.noNames.push(nm); }
    if (r.note) { const t = r.note.trim(); c.noteBits.push(`${t.charAt(0).toUpperCase()}${t.slice(1)} — ${nm}`); }
    if (r.user_id === state.myUserId) state.rsvpMine.set(key, r.status);
  }
}
function applyRsvpLocal(eventId, date, uid, status, note) {
  const i = state.rsvps.findIndex((r) => r.event_id === eventId && r.occurrence_date === date && r.user_id === uid);
  const oldNote = i >= 0 ? state.rsvps[i].note : null;
  if (i >= 0) state.rsvps.splice(i, 1);
  if (status) state.rsvps.push({ event_id: eventId, occurrence_date: date, user_id: uid, status, note: note !== undefined ? note : oldNote });
  recomputeRsvp();
}

// ---------- occurrence bucketing ----------
function occurrencesForGrid() {
  const { year, month } = state.visible;
  const days = monthGridDays(year, month);
  const rangeStart = fieldsToInstant(days[0].dateStr, "00:00");
  const rangeEnd = fieldsToInstant(addDays(days[41].dateStr, 1), "00:00");
  const occ = expandAll(state.events, rangeStart, rangeEnd)
    .filter((o) => !state.hidden.has(o.event.category_id || "__none__"));
  const map = new Map();
  for (const o of occ) {
    if (!map.has(o.date)) map.set(o.date, []);
    map.get(o.date).push(o);
  }
  for (const list of map.values()) list.sort((a, b) => a.start - b.start);
  return { days, map };
}

// ---------- render orchestration ----------
function renderAll() {
  const { days, map } = occurrencesForGrid();
  state.occByDate = map;
  renderMonthBar();
  renderWeekhead();
  renderGrid(days);
  renderDaySection();
  renderNextUp();
  renderLeftRail();
  renderWeekRail();
}

function renderMonthBar() {
  const { month, year } = monthLabelParts(state.visible.year, state.visible.month);
  $("#month-label").innerHTML = `${escapeHtml(month)} <span class="yr">${year}</span>`;
  const t = state.todayStr.split("-").map(Number);
  const isCurrent = t[0] === state.visible.year && t[1] === state.visible.month;
  $("#btn-today").hidden = isCurrent;
}

const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WD_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
function renderWeekhead() {
  const host = $("#weekhead");
  if (host.childElementCount) return;
  for (let i = 0; i < 7; i++) {
    const c = el("div", "weekhead__cell");
    c.innerHTML = `<span class="wh-long">${WD_LONG[i]}</span><span class="wh-short">${WD_SHORT[i]}</span>`;
    host.appendChild(c);
  }
}

function renderGrid(days) {
  const host = $("#grid");
  host.innerHTML = "";
  const desktop = isDesktop();
  const selWeek = weekOf(state.selectedDate).days;
  const { month } = state.visible;

  for (const d of days) {
    const list = state.occByDate.get(d.dateStr) || [];
    const inMonth = Number(d.dateStr.slice(5, 7)) === month;
    const isToday = d.dateStr === state.todayStr;
    const isSel = d.dateStr === state.selectedDate;

    const cell = el("div", "cell");
    cell.dataset.date = d.dateStr;
    cell.setAttribute("role", "gridcell");
    cell.tabIndex = -1;
    if (!inMonth) cell.classList.add("cell--out");
    if (isToday) cell.classList.add("cell--today");
    if (isSel && !isToday) cell.classList.add("cell--sel");
    if (isSel && isToday) cell.classList.add("cell--sel");
    if (desktop && selWeek.includes(d.dateStr)) cell.classList.add("cell--selweek");

    cell.appendChild(el("span", "cell__num", String(d.day)));
    if (desktop && isToday) cell.appendChild(el("span", "cell__todaytag", "Today"));

    // mobile: up to 3 category dots
    const dots = el("span", "cell__dots");
    list.slice(0, 3).forEach((o) => {
      const i = el("i"); i.style.background = catColor(o.event.category_id); dots.appendChild(i);
    });
    cell.appendChild(dots);

    // desktop: up to 2 chips + "+N more"
    if (desktop) {
      const chips = el("span", "cell__chips");
      list.slice(0, 2).forEach((o) => chips.appendChild(buildChip(o)));
      cell.appendChild(chips);
      if (list.length > 2) cell.appendChild(el("span", "cell__more", `+${list.length - 2} more`));
      const plus = el("span", "cell__plus", "+");
      cell.appendChild(plus);
      if (state.isAdmin) {
        cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.classList.add("cell--drop"); });
        cell.addEventListener("dragleave", () => cell.classList.remove("cell--drop"));
        cell.addEventListener("drop", (e) => onChipDrop(e, cell));
      }
    }

    cell.addEventListener("click", (e) => {
      if (e.target.closest(".chip")) return;
      selectDate(d.dateStr);
      if (state.isAdmin && desktop) openComposer("new", null, d.dateStr);
    });
    host.appendChild(cell);
  }
}

function buildChip(occ) {
  const ev = occ.event;
  const chip = el("div", "chip");
  chip.dataset.key = occKey(occ);
  chip.style.borderLeftColor = catColor(ev.category_id);
  if (!ev.all_day) chip.appendChild(el("span", "chip__time", shortTime(occ.start)));
  chip.appendChild(el("span", "chip__title", occ.overrideTitle || ev.title));
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    selectDate(occ.date);
    state.focusedKey = occKey(occ);
    renderWeekRail();
  });
  if (state.isAdmin && isDesktop() && !ev.rrule) {
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", occKey(occ)));
  }
  return chip;
}

async function onChipDrop(e, cell) {
  e.preventDefault();
  cell.classList.remove("cell--drop");
  const [evId, oldDate] = splitKey(e.dataTransfer.getData("text/plain"));
  const newDate = cell.dataset.date;
  if (!newDate || newDate === oldDate) return;
  const ev = state.events.find((x) => x.id === evId);
  if (!ev || ev.rrule) return;
  const s = new Date(ev.starts_at);
  const p = zonedParts(s);
  const newStart = fieldsToInstant(newDate, `${pad(p.hour)}:${pad(p.minute)}`);
  const durMs = ev.ends_at ? new Date(ev.ends_at) - s : 0;
  try {
    await updateEventTiming(evId, {
      starts_at: newStart.toISOString(),
      ends_at: durMs ? new Date(newStart.getTime() + durMs).toISOString() : null,
    });
    await loadData();
  } catch (err) { alert(friendly(err)); }
}

function selectDate(dateStr) {
  if (state.selectedDate === dateStr) return;
  state.selectedDate = dateStr;
  const [y, m] = dateStr.split("-").map(Number);
  if (y !== state.visible.year || m !== state.visible.month) state.visible = { year: y, month: m };
  state.focusedKey = null;
  renderAll();
  if (!isDesktop()) {
    const sec = $("#daysection");
    sec.classList.remove("fade");
    void sec.offsetWidth;
    sec.classList.add("fade");
  }
}

function goMonth(delta) {
  let m = state.visible.month + delta, y = state.visible.year;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  state.visible = { year: y, month: m };
  const t = state.todayStr.split("-").map(Number);
  state.selectedDate = (y === t[0] && m === t[1]) ? state.todayStr : `${y}-${pad(m)}-01`;
  state.focusedKey = null;
  renderAll();
}

// ---------- mobile day section ----------
function renderDaySection() {
  const host = $("#daysection");
  host.innerHTML = "";
  const sel = state.selectedDate;
  const noon = fieldsToInstant(sel, "12:00");
  const p = zonedParts(noon);
  const labelBits = [
    WD_LONG[WD_SHORT_INDEX(p.weekday)].toUpperCase(),
    new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "long", day: "numeric" }).format(noon).toUpperCase(),
  ];
  if (sel === state.todayStr) labelBits.push("TODAY");

  const head = el("div", "dayhead");
  head.appendChild(el("span", "dayhead__label", labelBits.join(" · ")));
  if (state.isAdmin) {
    const add = el("button", "dayhead__add", "Add");
    add.type = "button";
    add.onclick = () => openComposer("new", null, sel);
    head.appendChild(add);
  }
  host.appendChild(head);

  const list = state.occByDate.get(sel) || [];
  if (!list.length) {
    const empty = el("div", "dayempty");
    empty.appendChild(el("p", null, "Nothing on this day"));
    if (state.isAdmin) {
      const b = el("button", "btn", "Add an event");
      b.type = "button";
      b.onclick = () => openComposer("new", null, sel);
      empty.appendChild(b);
    }
    host.appendChild(empty);
    return;
  }
  const cards = el("div", "daycards");
  for (const occ of list) cards.appendChild(buildDayCard(occ));
  host.appendChild(cards);
}
const WD_SHORT_INDEX = (wd) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);

function buildDayCard(occ) {
  const ev = occ.event;
  const card = el("div", "daycard");
  const cat = el("div", "daycard__cat");
  const dot = el("span", "dot"); dot.style.background = catColor(ev.category_id);
  const cn = el("span", "daycard__catname", catName(ev.category_id).toUpperCase());
  cn.style.color = catTextColor(ev.category_id);
  cat.append(dot, cn, el("span", "daycard__time", timeLabel(occ)));
  card.appendChild(cat);
  card.appendChild(el("div", "daycard__title", occ.overrideTitle || ev.title));
  const loc = occ.overrideLocation || ev.location;
  if (loc) card.appendChild(el("div", "daycard__loc", loc));
  const note = (ev.description || "").split("\n")[0].trim();
  if (note) card.appendChild(el("div", "daycard__note", note));
  if (ev.asks_rsvp && occ.date >= state.todayStr) {
    const rc = el("div", "rsvp");
    renderRsvpControls(rc, occ, "strip");
    card.appendChild(rc);
  }
  card.addEventListener("click", (e) => { if (e.target.closest(".rsvp")) return; openEvent(occ); });
  return card;
}

function renderNextUp() {
  const host = $("#nextup");
  host.textContent = "";
  host.onclick = null;
  const all = [];
  for (const [date, list] of state.occByDate) if (date > state.todayStr) for (const o of list) all.push(o);
  all.sort((a, b) => a.start - b.start);
  const nx = all[0];
  if (!nx) return;
  const wd = new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, weekday: "short" }).format(nx.start);
  const loc = nx.overrideLocation || nx.event.location;
  host.textContent = `Next up — ${wd} ${dayNum(nx.date)}, ${nx.overrideTitle || nx.event.title}` + (loc ? ` at ${loc}` : "");
  host.onclick = () => selectDate(nx.date);
}

// ---------- desktop left rail ----------
function renderLeftRail() {
  const rail = $("#cat-rail");
  rail.innerHTML = "";
  const counts = new Map();
  for (const list of state.occByDate.values()) for (const o of list) {
    const id = o.event.category_id || "__none__";
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const rows = [...state.categories.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    { id: "__none__", name: "Uncategorized", color: "#7d5411" }];
  for (const r of rows) {
    const row = el("button", "cat-row");
    row.type = "button";
    row.setAttribute("aria-pressed", state.hidden.has(r.id) ? "false" : "true");
    row.innerHTML = `<span class="dot" style="background:${r.color}"></span><span>${escapeHtml(r.name)}</span><span class="cnt">${counts.get(r.id) || 0}</span>`;
    row.onclick = () => {
      if (state.hidden.has(r.id)) state.hidden.delete(r.id); else state.hidden.add(r.id);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden]));
      renderAll();
    };
    rail.appendChild(row);
  }

  const needEls = [];
  let unanswered = 0;
  for (const [date, list] of state.occByDate) {
    if (date < state.todayStr) continue;
    for (const o of list) if (o.event.asks_rsvp && !state.rsvpMine.get(occKey(o))) { unanswered++; needEls.push(o); }
  }
  const needs = $("#needs-you");
  if (unanswered) {
    needs.innerHTML = `${unanswered} event${unanswered === 1 ? "" : "s"} have no RSVP from you. `;
    const a = el("button", null, "Answer them all →");
    a.type = "button";
    a.onclick = () => { needEls.sort((x, y) => x.start - y.start); selectDate(needEls[0].date); };
    needs.appendChild(a);
  } else {
    needs.textContent = "You're all caught up.";
  }
  $("#group-count").textContent = `Group (${state.members.size})`;
}

// ---------- desktop right rail (selected week) ----------
function renderWeekRail() {
  const rail = $("#weekrail");
  rail.innerHTML = "";
  if (!isDesktop()) return;
  const wk = weekOf(state.selectedDate);
  const weekOcc = [];
  for (const d of wk.days) for (const o of (state.occByDate.get(d) || [])) weekOcc.push(o);
  weekOcc.sort((a, b) => a.start - b.start);

  const head = el("div", "weekrail__head");
  const startNoon = fieldsToInstant(wk.startStr, "12:00");
  head.appendChild(el("span", "weekrail__title",
    "Week of " + new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "short", day: "numeric" }).format(startNoon)));
  const a = new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "short", day: "numeric" }).formatToParts(startNoon);
  const b = new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "short", day: "numeric" }).formatToParts(fieldsToInstant(wk.endStr, "12:00"));
  const mon = (parts) => (parts.find((x) => x.type === "month") || {}).value || "";
  const dnum = (parts) => (parts.find((x) => x.type === "day") || {}).value || "";
  head.appendChild(el("span", "weekrail__span", `${mon(a).toUpperCase()} ${dnum(a)} – ${mon(b).toUpperCase()} ${dnum(b)}`));
  rail.appendChild(head);
  rail.appendChild(el("div", "weekrail__rule"));

  if (!weekOcc.length) {
    rail.appendChild(el("p", "muted", "No events this week."));
    return;
  }
  let focused = weekOcc.find((o) => occKey(o) === state.focusedKey) || weekOcc[0];

  const fx = el("div", "weekrail__focus");
  const cat = el("div", "ev2__cat");
  const dot = el("span", "dot"); dot.style.background = catColor(focused.event.category_id);
  const cn = el("span", "ev2__catname", catName(focused.event.category_id).toUpperCase());
  cn.style.color = catTextColor(focused.event.category_id);
  const wd = new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, weekday: "short" }).format(focused.start);
  cat.append(dot, cn, el("span", "fx-when", `${wd} ${dayNum(focused.date)} · ${focused.event.all_day ? "All day" : shortTime(focused.start)}`));
  fx.appendChild(cat);
  fx.appendChild(el("div", "fx-title", focused.overrideTitle || focused.event.title));
  const fnote = (focused.event.description || "").split("\n")[0].trim();
  if (fnote) fx.appendChild(el("div", "fx-note", fnote));

  if (focused.event.asks_rsvp) {
    const rc = el("div", "rsvp");
    renderRsvpControls(rc, focused, "strip");
    fx.appendChild(rc);
    const names = el("div", "ev2__names");
    names.dataset.occ = occKey(focused);
    fx.appendChild(names);
  }

  const actions = el("div", "weekrail__actions");
  const openBtn = el("button", null, "Open");
  openBtn.type = "button";
  openBtn.onclick = () => openEvent(focused);
  actions.appendChild(openBtn);
  if (state.isAdmin) {
    const edit = el("button", null, "Edit");
    edit.type = "button";
    edit.onclick = () => openComposer("edit", focused.event, null);
    const dup = el("button", null, "Duplicate");
    dup.type = "button";
    dup.onclick = () => openComposer("new", { ...focused.event, id: null, title: `${focused.event.title} (copy)` }, focused.date);
    actions.append(edit, dup);
  }
  fx.appendChild(actions);
  rail.appendChild(fx);
  if (focused.event.asks_rsvp) updateNames(occKey(focused));

  const rest = weekOcc.filter((o) => o !== focused);
  if (rest.length) {
    const box = el("div", "weekrail__rest");
    box.appendChild(el("p", "kicker", "Rest of the week"));
    for (const o of rest) {
      const row = el("div", "wr-row");
      row.appendChild(el("span", "wr-date", String(dayNum(o.date))));
      const mid = el("span");
      mid.innerHTML = `<span class="wr-title">${escapeHtml(o.overrideTitle || o.event.title)}</span>` +
        `<div class="wr-sub">${o.event.all_day ? "All day" : escapeHtml(shortTime(o.start))}${o.event.location ? " · " + escapeHtml(o.event.location) : ""}</div>`;
      row.appendChild(mid);
      row.onclick = () => { state.focusedKey = occKey(o); renderWeekRail(); };
      box.appendChild(row);
    }
    rail.appendChild(box);
  }
}

// ---------- RSVP controls (shared strip + band) ----------
function renderRsvpControls(container, occ, variant) {
  container.innerHTML = "";
  container.classList.add("rsvp");
  container.dataset.occ = occKey(occ);
  const key = occKey(occ);
  const mine = state.rsvpMine.get(key) || null;
  const c = state.rsvpCounts.get(key) || { yes: 0 };

  const yes = el("button", "rsvp-btn rsvp-btn--yes", mine === "yes" ? "I'm in ✓" : "I'm in");
  yes.type = "button";
  yes.setAttribute("aria-pressed", mine === "yes" ? "true" : "false");
  yes.onclick = (e) => { e.stopPropagation(); handleRsvp(occ, "yes", container); };

  const no = el("button", "rsvp-btn rsvp-btn--no", variant === "band" ? "Can't make it" : "Can't");
  no.type = "button";
  no.setAttribute("aria-pressed", mine === "no" ? "true" : "false");
  no.onclick = (e) => { e.stopPropagation(); handleRsvp(occ, "no", container); };

  container.append(yes, no);
  if (variant !== "band") container.appendChild(el("span", "rsvp-count", `${c.yes || 0} going`));
}

function rsvpMsg(container, text) {
  let m = container.querySelector(".rsvp-msg");
  if (!m) { m = el("span", "rsvp-msg"); container.appendChild(m); }
  m.textContent = text;
}

async function ensureMember() {
  if (!state.myUserId) {
    try { const s = await ensureAnonSession(); state.myUserId = s.user.id; } catch { return false; }
    await loadRsvpData();
  }
  if (!state.members.has(state.myUserId)) {
    const name = await promptName();
    if (!name) return false;
    try { await setDisplayName(state.myUserId, name); state.members.set(state.myUserId, name); }
    catch (e) { console.warn(e); return false; }
  }
  return true;
}

async function handleRsvp(occ, status, container) {
  if (!(await ensureMember())) { if (container) rsvpMsg(container, "Couldn't save - try again."); return; }
  const key = occKey(occ);
  const prev = state.rsvpMine.get(key) || null;
  const target = prev === status ? null : status;
  applyRsvpLocal(occ.event.id, occ.date, state.myUserId, target);
  refreshRsvpUI(key);
  try {
    if (target === null) await clearRsvp(state.myUserId, occ.event.id, occ.date);
    else await setRsvp(state.myUserId, occ.event.id, occ.date, target);
  } catch (e) {
    applyRsvpLocal(occ.event.id, occ.date, state.myUserId, prev);
    refreshRsvpUI(key);
    document.querySelectorAll(`.rsvp[data-occ="${key}"]`).forEach((n) => rsvpMsg(n, friendly(e)));
  }
}

async function setBringing(occ, text) {
  if (!(await ensureMember())) return;
  const key = occKey(occ);
  const status = state.rsvpMine.get(key) || "yes";
  applyRsvpLocal(occ.event.id, occ.date, state.myUserId, status, text);
  refreshRsvpUI(key);
  try { await setRsvp(state.myUserId, occ.event.id, occ.date, status, text); }
  catch (e) { console.warn(e); await loadRsvpData(); refreshRsvpUI(key); }
}

function refreshRsvpUI(key) {
  const [eventId, date] = splitKey(key);
  const occ = { event: state.events.find((e) => e.id === eventId) || { id: eventId }, date };
  document.querySelectorAll(`.rsvp[data-occ="${key}"]`).forEach((n) => {
    renderRsvpControls(n, occ, n.closest(".ev2__rsvp") ? "band" : "strip");
  });
  updateNames(key);
  document.querySelectorAll(`.ev2__bring[data-occ="${key}"]`).forEach((n) => renderBringing(n, occ));
}

function updateNames(key) {
  const node = document.querySelector(`.ev2__names[data-occ="${key}"]`);
  if (!node) return;
  const c = state.rsvpCounts.get(key) || { yes: 0, no: 0, yesNames: [] };
  const havent = Math.max(0, state.members.size - c.yes - c.no);
  if (!c.yes && !c.no) { node.innerHTML = `<span class="sub">No one's answered yet.</span>`; return; }
  const line1 = c.yes ? `<b>${c.yes} going</b> — ${escapeHtml(c.yesNames.join(", "))}` : `<b>0 going</b>`;
  node.innerHTML = `${line1}<span class="sub">${c.no} can't · ${havent} haven't said</span>`;
}

function renderBringing(container, occ) {
  container.innerHTML = "";
  container.classList.add("ev2__bring");
  container.dataset.occ = occKey(occ);
  const c = state.rsvpCounts.get(occKey(occ)) || { noteBits: [] };
  for (const b of c.noteBits || []) container.appendChild(el("span", "chip-pill", b));
  const add = el("button", "chip-pill chip-pill--add", "+ Add what you're bringing");
  add.type = "button";
  add.onclick = () => { const t = prompt("What are you bringing?"); if (t && t.trim()) setBringing(occ, t.trim()); };
  container.appendChild(add);
}

// ---------- event detail sheet (Screen 2) ----------
function openEvent(occ) {
  const ev = occ.event;
  const wrap = $("#event-scroll");
  wrap.innerHTML = "";
  const key = occKey(occ);

  const nav = el("div", "ev2__nav");
  const back = el("button", "ev2__back", `‹ ${new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "long" }).format(occ.start)}`);
  back.type = "button";
  back.onclick = () => $("#dialog-event").close();
  const share = el("button", "ev2__share", "Share");
  share.type = "button";
  share.onclick = () => shareEvent(occ);
  nav.append(back, share);
  wrap.appendChild(nav);

  if (ev.photo_url) {
    const img = document.createElement("img");
    img.className = "plate"; img.alt = "";
    img.onerror = () => img.remove();
    img.src = ev.photo_url;
    wrap.appendChild(img);
  }

  const cat = el("div", "ev2__cat");
  const dot = el("span", "dot"); dot.style.background = catColor(ev.category_id);
  const cn = el("span", "ev2__catname", catName(ev.category_id).toUpperCase());
  cn.style.color = catTextColor(ev.category_id);
  cat.append(dot, cn);
  wrap.appendChild(cat);

  wrap.appendChild(el("h2", "ev2__title", occ.overrideTitle || ev.title));

  const when = el("div", "ev2__when");
  when.appendChild(el("span", "ev2__date", longDate(occ.start)));
  when.appendChild(el("span", "ev2__time", ev.all_day ? "All day" : timeLabel(occ)));
  wrap.appendChild(when);

  const note = (ev.description || "").trim();
  if (note) { wrap.appendChild(el("div", "ev2__rule")); wrap.appendChild(el("p", "ev2__desc", note)); }
  wrap.appendChild(el("div", "ev2__rule"));

  const meta = el("div", "ev2__meta");
  const where = el("div");
  where.appendChild(el("div", "lbl", "Where"));
  const loc = occ.overrideLocation || ev.location;
  if (loc) {
    where.appendChild(el("div", null, loc));
    const a = document.createElement("a");
    a.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
    a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open in Maps";
    where.appendChild(a);
  } else where.appendChild(el("div", "sub", "—"));
  const rem = el("div");
  rem.appendChild(el("div", "lbl", "Reminder"));
  rem.appendChild(el("div", null, ev.reminders && ev.reminders.length
    ? ev.reminders.map((r) => minutesToText(r.offset_minutes)).join(", ") : "None"));
  meta.append(where, rem);
  wrap.appendChild(meta);

  if (ev.asks_rsvp) {
    const band = el("div", "ev2__rsvp");
    band.appendChild(el("p", "kicker", "CAN YOU MAKE IT?"));
    const rc = el("div", "rsvp");
    rc.dataset.occ = key;
    renderRsvpControls(rc, occ, "band");
    band.appendChild(rc);
    const names = el("div", "ev2__names");
    names.dataset.occ = key;
    band.appendChild(names);
    wrap.appendChild(band);
    updateNames(key);

    if (ev.collects_bring_list) {
      wrap.appendChild(el("p", "kicker ev2__bringlbl", "BRINGING"));
      const bring = el("div", "ev2__bring");
      renderBringing(bring, occ);
      wrap.appendChild(bring);
    }
  }

  if (state.isAdmin) {
    const foot = el("div", "composer__foot");
    const edit = el("button", "btn", "Edit");
    edit.type = "button";
    edit.onclick = () => { $("#dialog-event").close(); openComposer("edit", ev, null); };
    foot.appendChild(edit);
    if (occ.recurring) {
      const skip = el("button", "btn", "Skip this date");
      skip.type = "button";
      skip.onclick = async () => {
        if (!confirm(`Skip the ${occ.date} occurrence of "${ev.title}"?`)) return;
        try { await cancelOccurrence(ev.id, occ.date); $("#dialog-event").close(); await loadData(); }
        catch (e) { alert(friendly(e)); }
      };
      foot.appendChild(skip);
    }
    wrap.appendChild(foot);
  }

  $("#dialog-event").showModal();
}

function shareEvent(occ) {
  const ev = occ.event;
  const dt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const end = occ.end || new Date(occ.start.getTime() + 3600000);
  const esc = (s) => String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const title = occ.overrideTitle || ev.title;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Connection Group Calendar//EN", "BEGIN:VEVENT",
    `UID:${ev.id}-${occ.date}@connection-group`, `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(occ.start)}`, `DTEND:${dt(end)}`, `SUMMARY:${esc(title)}`,
    ev.location ? `LOCATION:${esc(ev.location)}` : null,
    ev.description ? `DESCRIPTION:${esc(ev.description)}` : null,
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
  const blurb = `${title} — ${longDate(occ.start)}${ev.all_day ? "" : " " + shortTime(occ.start)}${ev.location ? " · " + ev.location : ""}`;
  if (navigator.share) { navigator.share({ title, text: blurb }).catch(() => {}); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `${title.replace(/[^\w]+/g, "-").toLowerCase().replace(/^-|-$/g, "")}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- display-name prompt ----------
let nameResolver = null;
function promptName() {
  return new Promise((resolve) => { nameResolver = resolve; $("#name-input").value = ""; $("#dialog-name").showModal(); });
}

// ---------- group chat ----------
function chatDayLabel(dstr, d) {
  if (dstr === state.todayStr) return "Today";
  if (dstr === addDays(state.todayStr, -1)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, weekday: "short", month: "short", day: "numeric" }).format(d);
}

function mergeMsg(row) {
  let i = state.chat.msgs.findIndex((m) => m.id === row.id);
  if (i < 0) i = state.chat.msgs.findIndex((m) => m._pending && m.user_id === row.user_id && m.body === row.body);
  if (i >= 0) state.chat.msgs[i] = { ...state.chat.msgs[i], ...row, _pending: false };
  else state.chat.msgs.push(row);
  state.chat.msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function renderChatLog() {
  const log = $("#chat-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const prevTop = log.scrollTop;
  log.innerHTML = "";
  if (!state.chat.msgs.length) {
    log.appendChild(el("p", "chat-empty", "No messages yet. Say hi."));
    return;
  }
  let lastDay = "";
  for (const m of state.chat.msgs) {
    const dt = new Date(m.created_at);
    const day = ymd(dt);
    if (day !== lastDay) { log.appendChild(el("div", "chatlog__day", chatDayLabel(day, dt))); lastDay = day; }
    log.appendChild(renderMsg(m));
  }
  log.scrollTop = atBottom ? log.scrollHeight : prevTop;
}

const IMG_URL_RE = /^https:\/\/\S+\.(?:gif|png|jpe?g|webp)(?:\?\S*)?$/i;
const GIF_HOST_RE = /^https:\/\/(?:media\d*\.giphy\.com|[a-z-]+\.tenor\.com)\/\S+$/i;
const isMediaUrl = (t) => IMG_URL_RE.test(t) || GIF_HOST_RE.test(t);

function renderBody(container, text) {
  const t = text.trim();
  if (isMediaUrl(t)) {
    container.classList.add("msg__body--media");
    const img = el("img", "msg__media");
    img.alt = "shared image"; img.loading = "lazy";
    img.onerror = () => { container.classList.remove("msg__body--media"); container.textContent = t; };
    img.src = t;
    container.appendChild(img);
    return;
  }
  const parts = text.split(/(https?:\/\/\S+)/g);
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const a = el("a", null, p);
      a.href = p; a.target = "_blank"; a.rel = "noopener";
      container.appendChild(a);
    } else if (p) {
      container.appendChild(document.createTextNode(p));
    }
  });
}

function reaxFor(id) {
  const by = new Map();
  for (const r of state.chat.reax) {
    if (r.message_id !== id) continue;
    if (!by.has(r.emoji)) by.set(r.emoji, []);
    by.get(r.emoji).push(r.user_id);
  }
  return [...by.entries()].map(([emoji, users]) => ({
    emoji, count: users.length,
    mine: users.includes(state.myUserId),
    names: users.map((u) => state.members.get(u) || "Someone").join(", "),
  }));
}

const QUICK_REAX = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];

async function toggleReax(id, emoji) {
  if (!(await ensureMember())) return;
  const has = state.chat.reax.some((r) => r.message_id === id && r.user_id === state.myUserId && r.emoji === emoji);
  if (has) state.chat.reax = state.chat.reax.filter((r) => !(r.message_id === id && r.user_id === state.myUserId && r.emoji === emoji));
  else state.chat.reax.push({ message_id: id, user_id: state.myUserId, emoji });
  renderChatLog();
  try {
    if (has) await removeReaction(state.myUserId, id, emoji);
    else await addReaction(state.myUserId, id, emoji);
  } catch (e) {
    console.warn(e);
    await reloadReax();
    renderChatLog();
  }
}

async function reloadReax() {
  const ids = state.chat.msgs.map((m) => m.id).filter((x) => !String(x).startsWith("temp-"));
  try { state.chat.reax = await fetchReactions(ids); } catch { /* ignore */ }
}

function renderMsg(m) {
  const mine = m.user_id === state.myUserId;
  const wrap = el("div", "msg" + (mine ? " msg--mine" : ""));
  wrap.dataset.id = m.id;
  const name = mine ? "You" : (m.display_name || state.members.get(m.user_id) || "Someone");

  const meta = el("div", "msg__meta");
  meta.appendChild(el("b", null, name));
  const time = el("span", "msg__time",
    formatTime(new Date(m.created_at)) + (m.edited_at ? " · edited" : ""));
  meta.appendChild(time);
  wrap.appendChild(meta);

  if (m.deleted_at) {
    wrap.appendChild(el("div", "msg__body msg__body--gone", "message removed"));
    return wrap;
  }

  const body = el("div", "msg__body" + (m._pending ? " msg__body--pending" : ""));
  renderBody(body, m.body);
  wrap.appendChild(body);

  if (m.attached_event_id) {
    const card = attachedEventCard(m.attached_event_id, m.attached_occurrence_date);
    if (card) wrap.appendChild(card);
  }

  if (m._failed) {
    const retry = el("button", "msg__retry", "Didn't send — tap to retry");
    retry.type = "button";
    retry.onclick = () => retrySend(m);
    wrap.appendChild(retry);
  }

  if ((mine || state.isAdmin) && !m._pending && !m._failed) {
    const del = el("button", "msg__del", "delete");
    del.type = "button";
    del.onclick = async () => {
      if (!confirm("Delete this message?")) return;
      try { await removeMessage(m.id); m.deleted_at = new Date().toISOString(); renderChatLog(); }
      catch (e) { alert(friendly(e)); }
    };
    meta.appendChild(del);
  }

  if (!m._pending && !m._failed) {
    const rr = el("div", "msg__reax");
    for (const r of reaxFor(m.id)) {
      const pill = el("button", "reax", `${r.emoji} ${r.count}`);
      pill.type = "button";
      pill.title = r.names;
      pill.setAttribute("aria-pressed", r.mine ? "true" : "false");
      pill.onclick = () => toggleReax(m.id, r.emoji);
      rr.appendChild(pill);
    }
    const add = el("button", "reax reax--add", "＋");
    add.type = "button";
    add.title = "Add a reaction";
    add.onclick = () => {
      if (rr.querySelector(".reax-quick")) { rr.querySelector(".reax-quick").remove(); return; }
      const q = el("span", "reax-quick");
      for (const e of QUICK_REAX) {
        const b = el("button", null, e);
        b.type = "button";
        b.onclick = () => { q.remove(); toggleReax(m.id, e); };
        q.appendChild(b);
      }
      rr.appendChild(q);
    };
    rr.appendChild(add);
    wrap.appendChild(rr);
  }
  return wrap;
}

const onChatTab = () => state.activeTab === "chat" && !$("#view-chat").hidden;

function unreadCount() {
  const cut = state.chat.lastReadAt ? new Date(state.chat.lastReadAt).getTime() : 0;
  return state.chat.msgs.filter(
    (m) => m.user_id !== state.myUserId && !String(m.id).startsWith("temp-") &&
      new Date(m.created_at).getTime() > cut
  ).length;
}

function updateUnread() {
  const n = unreadCount();
  $("#tab-chat-dot").hidden = n === 0;
  const badge = $("#chat-count");
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? "99+" : String(n);
}

async function markReadNow() {
  const last = state.chat.msgs.filter((m) => !String(m.id).startsWith("temp-")).slice(-1)[0];
  state.chat.lastReadAt = last ? last.created_at : new Date().toISOString();
  updateUnread();
  if (state.myUserId) { try { await markRead(state.myUserId); } catch { /* ignore */ } }
}

async function loadChat() {
  try {
    const [msgs, me] = await Promise.all([fetchMessages(150), fetchMe(state.myUserId)]);
    state.chat.msgs = msgs;
    state.chat.loaded = true;
    if (me) { state.chat.muted = !!me.chat_muted; state.chat.lastReadAt = me.last_read_at; }
    await reloadReax();
  } catch (e) { console.warn("chat load failed", e); }
  renderChatLog();
  updateUnread();
}

function startChatRealtime() {
  if (state.chat.unsub || !state.myUserId) return;
  state.chat.unsub = subscribeMessages({
    onInsert: async (row) => {
      if (!state.members.has(row.user_id)) {
        try { state.members = await fetchMembers(); } catch { /* ignore */ }
      }
      row.display_name = state.members.get(row.user_id) || null;
      mergeMsg(row);
      if (onChatTab()) { renderChatLog(); markReadNow(); }
      else { updateUnread(); }
    },
    onUpdate: (row) => {
      const m = state.chat.msgs.find((x) => x.id === row.id);
      if (!m) return;
      m.body = row.body; m.edited_at = row.edited_at; m.deleted_at = row.deleted_at;
      if (onChatTab()) renderChatLog();
    },
    onReactionAdd: async (r) => {
      if (state.chat.reax.some((x) => x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji)) return;
      if (!state.members.has(r.user_id)) { try { state.members = await fetchMembers(); } catch { /* ignore */ } }
      state.chat.reax.push({ message_id: r.message_id, user_id: r.user_id, emoji: r.emoji });
      if (onChatTab()) renderChatLog();
    },
    onReactionDel: (r) => {
      state.chat.reax = state.chat.reax.filter((x) => !(x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji));
      if (onChatTab()) renderChatLog();
    },
  });
}

// Cheap unread probe for first paint, before the full history loads.
async function probeUnread() {
  if (!state.myUserId) return;
  try {
    const [{ data: newest }, me] = await Promise.all([
      supabase.from("messages").select("created_at, user_id").order("created_at", { ascending: false }).limit(1),
      fetchMe(state.myUserId),
    ]);
    if (me) { state.chat.muted = !!me.chat_muted; state.chat.lastReadAt = me.last_read_at; }
    const n = newest && newest[0];
    if (n && n.user_id !== state.myUserId && (!state.chat.lastReadAt || n.created_at > state.chat.lastReadAt)) {
      $("#tab-chat-dot").hidden = false;
      $("#chat-count").hidden = false;
      $("#chat-count").textContent = "•";
    }
  } catch { /* ignore */ }
}

function enterChat() {
  if (!state.chat.loaded) loadChat();
  else { renderChatLog(); markReadNow(); }
  startChatRealtime();
  refreshMuteBtn();
  $("#chat-incount").textContent = `${state.members.size} in`;
  setTimeout(() => { renderChatLog(); markReadNow(); $("#chat-input").focus(); }, 60);
}

function refreshMuteBtn() {
  const btn = $("#chat-mute");
  btn.textContent = state.chat.muted ? "Unmute" : "Mute";
  btn.setAttribute("aria-pressed", state.chat.muted ? "true" : "false");
  btn.onclick = async () => {
    const next = !state.chat.muted;
    state.chat.muted = next;
    refreshMuteBtn();
    if (state.myUserId && state.members.has(state.myUserId)) {
      try { await setMuted(state.myUserId, next); } catch (e) { console.warn(e); }
    }
  };
}

// ---- send ----
async function sendChat() {
  const input = $("#chat-input");
  const body = input.value.trim();
  if (!body) return;
  if (!(await ensureMember())) { alert("Set a display name first so the group knows who's talking."); return; }
  const attach = state.chat.attach;
  input.value = "";
  input.style.height = "auto";
  clearAttach();
  const temp = {
    id: `temp-${Date.now()}`, body, created_at: new Date().toISOString(),
    user_id: state.myUserId, display_name: state.members.get(state.myUserId) || "You",
    attached_event_id: attach ? attach.eventId : null,
    attached_occurrence_date: attach ? attach.occurrenceDate : null,
    _pending: true, _attach: attach,
  };
  state.chat.msgs.push(temp);
  renderChatLog();
  setSendReady();
  try {
    const saved = await sendMessage(state.myUserId, body, attach);
    mergeMsg({ ...saved, display_name: state.members.get(state.myUserId) || null });
    renderChatLog();
    markReadNow();
  } catch (e) {
    temp._pending = false; temp._failed = true;
    renderChatLog();
    console.warn(e);
  }
}

async function retrySend(m) {
  m._failed = false; m._pending = true;
  renderChatLog();
  try {
    const saved = await sendMessage(state.myUserId, m.body, m._attach);
    Object.assign(m, saved, { _pending: false, _failed: false });
    mergeMsg({ ...m, display_name: state.members.get(state.myUserId) || null });
    renderChatLog();
    markReadNow();
  } catch (e) {
    m._pending = false; m._failed = true;
    renderChatLog();
    console.warn(e);
  }
}

function setSendReady() {
  $("#chat-send").classList.toggle("is-ready", $("#chat-input").value.trim().length > 0);
}

// ---- attached-event card ----
function occForAttach(eventId, occDate) {
  const ev = state.events.find((e) => e.id === eventId);
  if (!ev) return null;
  const d = occDate || ymd(new Date(ev.starts_at));
  const start = occDate
    ? fieldsToInstant(occDate, ev.all_day ? "00:00" : hhmm(new Date(ev.starts_at)))
    : new Date(ev.starts_at);
  const durMs = ev.ends_at ? new Date(ev.ends_at) - new Date(ev.starts_at) : 0;
  return { event: ev, start, end: durMs ? new Date(start.getTime() + durMs) : null, date: d, recurring: !!ev.rrule };
}

function attachedEventCard(eventId, occDate) {
  const occ = occForAttach(eventId, occDate);
  const card = el("button", "evcard");
  card.type = "button";
  if (!occ) { card.appendChild(el("span", "evcard__mid", "Event no longer available")); card.disabled = true; return card; }
  const ev = occ.event;
  card.style.borderLeftColor = catColor(ev.category_id);
  const g = el("span", "evcard__gutter");
  const mon = new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "short" }).format(occ.start).toUpperCase();
  const gm = el("span", "evcard__mon", mon); gm.style.color = catTextColor(ev.category_id);
  g.append(gm, el("span", "evcard__day", String(dayNum(occ.date))));
  const mid = el("span", "evcard__mid");
  const cn = el("span", "evcard__cat", catName(ev.category_id).toUpperCase()); cn.style.color = catTextColor(ev.category_id);
  mid.append(cn, el("span", "evcard__title", occ.overrideTitle || ev.title));
  const sub = ev.all_day ? "All day" : shortTime(occ.start);
  mid.appendChild(el("span", "evcard__sub", ev.location ? `${sub} · ${ev.location}` : sub));
  card.append(g, mid, el("span", "evcard__chev", "›"));
  card.onclick = (e) => { e.stopPropagation(); openEvent(occ); };
  return card;
}

// ---- attach picker ----
function upcomingOccurrences(limit) {
  const from = fieldsToInstant(state.todayStr, "00:00");
  const to = new Date(from.getTime() + 120 * 86400000);
  const list = expandAll(state.events, from, to)
    .filter((o) => o.date >= state.todayStr)
    .sort((a, b) => a.start - b.start);
  return limit ? list.slice(0, limit) : list;
}

function openAttachPicker() {
  state.chat.attachExpanded = false;
  renderAttachList();
  $("#attach-sheet").hidden = false;
  $("#chat-log").style.opacity = "0.4";
}
function closeAttachPicker() {
  $("#attach-sheet").hidden = true;
  $("#chat-log").style.opacity = "";
}

function renderAttachList() {
  const host = $("#attach-list");
  host.innerHTML = "";
  const all = upcomingOccurrences(0);
  const shown = state.chat.attachExpanded ? all.slice(0, 40) : all.slice(0, 6);
  for (const occ of shown) {
    const row = el("button", "attach-row");
    row.type = "button";
    const picked = state.chat.attach && state.chat.attach.eventId === occ.event.id && state.chat.attach.occurrenceDate === occ.date;
    if (picked) row.classList.add("attach-row--pick");
    const g = el("span", "attach-row__gutter");
    g.append(
      el("span", "attach-row__mon", new Intl.DateTimeFormat(undefined, { timeZone: GROUP_TIMEZONE, month: "short" }).format(occ.start).toUpperCase()),
      el("span", "attach-row__day", String(dayNum(occ.date))),
    );
    const b = el("span", "attach-row__body");
    b.style.borderLeftColor = catColor(occ.event.category_id);
    const cat = el("span", "attach-row__cat",
      `${catName(occ.event.category_id).toUpperCase()} · ${occ.event.all_day ? "ALL DAY" : shortTime(occ.start).toUpperCase()}`);
    cat.style.color = catTextColor(occ.event.category_id);
    b.append(cat, el("span", "attach-row__title", occ.overrideTitle || occ.event.title));
    row.append(g, b);
    if (picked) row.appendChild(el("span", "attach-row__check", "✓"));
    row.onclick = () => pickAttach(occ);
    host.appendChild(row);
  }
  if (!state.chat.attachExpanded && all.length > 6) {
    const more = el("button", "linkbtn", "Show more upcoming");
    more.type = "button";
    more.style.margin = "8px 0 0";
    more.onclick = () => { state.chat.attachExpanded = true; renderAttachList(); };
    host.appendChild(more);
  }
  if (!all.length) host.appendChild(el("p", "muted", "No upcoming events to attach."));
}

function pickAttach(occ) {
  state.chat.attach = { eventId: occ.event.id, occurrenceDate: occ.date };
  closeAttachPicker();
  renderDraftCard();
}
function clearAttach() {
  state.chat.attach = null;
  renderDraftCard();
}
function renderDraftCard() {
  const host = $("#draft-card");
  host.innerHTML = "";
  if (!state.chat.attach) { host.hidden = true; return; }
  const card = attachedEventCard(state.chat.attach.eventId, state.chat.attach.occurrenceDate);
  card.classList.remove("evcard");
  // reuse the inner nodes of the built card
  while (card.firstChild) host.appendChild(card.firstChild);
  const x = el("button", "draftcard__x", "×");
  x.type = "button";
  x.onclick = clearAttach;
  host.appendChild(x);
  host.hidden = false;
}

// ---------- tab routing (mobile) / chat panel (desktop) ----------
function setTab(name) {
  state.activeTab = name;
  try { localStorage.setItem(TAB_KEY, name); } catch { /* ignore */ }

  $("#tab-calendar").setAttribute("aria-current", name === "calendar" ? "page" : "false");
  $("#tab-chat").setAttribute("aria-current", name === "chat" ? "page" : "false");

  if (isDesktop()) {
    $("#view-calendar").hidden = false;
    const cv = $("#view-chat");
    if (name === "chat") {
      cv.hidden = false;
      requestAnimationFrame(() => cv.classList.add("is-open"));
      enterChat();
    } else {
      cv.classList.remove("is-open");
      setTimeout(() => { if (state.activeTab !== "chat") cv.hidden = true; }, 240);
    }
    return;
  }

  $("#view-calendar").hidden = name !== "calendar";
  $("#view-chat").hidden = name !== "chat";
  if (name === "chat") enterChat();
}

const EMOJI_LIST = "😀 😁 😂 🤣 🙂 😊 😍 😘 😎 🤔 😴 😇 🙃 😅 😭 😢 😮 😡 😳 🥳 🥺 👍 👎 👏 🙌 🙏 💪 🤝 👀 🔥 ✨ ⭐ 💯 ✅ ❌ ❤️ 🧡 💛 💚 💙 💜 🖤 🎉 🎂 ☕ 🍕 🍺 🏈 📅 ⏰".split(" ");

function insertAtCursor(input, text) {
  const s = input.selectionStart ?? input.value.length;
  const e = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  input.focus();
  input.dispatchEvent(new Event("input"));
}

function toggleEmojiPop() {
  const pop = $("#emoji-pop");
  if (!pop.hidden) { pop.hidden = true; return; }
  if (!pop.childElementCount) {
    for (const e of EMOJI_LIST) {
      const b = el("button", null, e);
      b.type = "button";
      b.onclick = () => { insertAtCursor($("#chat-input"), e); pop.hidden = true; };
      pop.appendChild(b);
    }
  }
  pop.hidden = false;
}

// ---------- composer (Screen 4 / mobile Add) ----------
function parseRRule(rrule) {
  const out = { freq: "", interval: 1 };
  if (!rrule) return out;
  for (const part of rrule.split(";")) {
    const [k, v] = part.split("=");
    if (k === "FREQ") out.freq = v;
    if (k === "INTERVAL") out.interval = parseInt(v, 10) || 1;
  }
  return out;
}

function renderCategoryPills(selectedId) {
  const wrap = $("#f-category-pills");
  wrap.innerHTML = "";
  const entries = [{ id: "", name: "Uncategorized", color: "#7d5411" },
    ...state.categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))];
  for (const e of entries) {
    const b = el("button", "pill");
    b.type = "button";
    const on = (selectedId || "") === e.id;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.innerHTML = `<span class="dot" style="background:${e.color}"></span>${escapeHtml(e.name)}`;
    if (on) { b.style.borderColor = e.color; b.style.color = darken(e.color, 0.62); b.style.background = hexToRgba(e.color, 0.12); }
    b.onclick = () => { $("#f-category").value = e.id; renderCategoryPills(e.id); };
    wrap.appendChild(b);
  }
}

function remindValue(reminders) {
  const first = reminders && reminders[0];
  const m = first && (first.offset_minutes ?? first);
  return ["15", "60", "1440", "2880"].includes(String(m)) ? String(m) : (m ? "1440" : "");
}

function openComposer(mode, ev, prefillDate) {
  state.composer = { open: true, mode, eventId: ev && ev.id ? ev.id : null };
  $("#composer-kicker").textContent = mode === "edit" ? "Edit event" : "New event";
  $("#form-msg").textContent = "";
  $("#btn-delete-event").hidden = mode !== "edit";

  const start = ev && ev.starts_at ? new Date(ev.starts_at) : null;
  $("#f-title").value = ev ? ev.title || "" : "";
  $("#f-category").value = ev && ev.category_id ? ev.category_id : "";
  renderCategoryPills($("#f-category").value);
  $("#f-allday").checked = ev ? !!ev.all_day : false;
  $("#f-date").value = start ? ymd(start) : (prefillDate || state.selectedDate || ymd(new Date()));
  $("#f-start").value = start && !ev.all_day ? hhmm(start) : "18:00";
  $("#f-end").value = ev && ev.ends_at && !ev.all_day ? hhmm(new Date(ev.ends_at)) : "";
  $("#f-location").value = ev ? ev.location || "" : "";
  $("#f-desc").value = ev ? ev.description || "" : "";
  $("#f-photo").value = ev ? ev.photo_url || "" : "";
  const rr = parseRRule(ev ? ev.rrule : null);
  $("#f-freq").value = rr.freq;
  $("#f-interval").value = rr.interval;
  $("#f-until").value = ev && ev.recurrence_end ? ev.recurrence_end : "";
  $("#f-remind").value = ev ? remindValue(ev.reminders) : "1440";
  $("#f-rsvp").checked = ev ? ev.asks_rsvp !== false : true;
  $("#f-bring").checked = ev ? !!ev.collects_bring_list : false;
  syncComposerDisabled();

  $("#composer").hidden = false;
  requestAnimationFrame(() => $("#composer").classList.add("composer--in"));
  setTimeout(() => $("#f-title").focus(), 60);
}

function composerDirty() {
  // "confirm only if something was typed" - only meaningful for a new event.
  return state.composer.mode === "new" && $("#f-title").value.trim().length > 0;
}
function closeComposer(force) {
  if (!force && composerDirty() && !confirm("Discard this event?")) return;
  $("#composer").classList.remove("composer--in");
  setTimeout(() => { $("#composer").hidden = true; }, 240);
  state.composer.open = false;
}
function syncComposerDisabled() {
  const allday = $("#f-allday").checked;
  document.querySelectorAll(".time-only input").forEach((i) => (i.disabled = allday));
  const repeats = !!$("#f-freq").value;
  document.querySelectorAll(".repeat-only input").forEach((i) => (i.disabled = !repeats));
}

async function saveComposer() {
  const msg = $("#form-msg");
  const fail = (t) => { msg.textContent = t; msg.scrollIntoView({ block: "center", behavior: SMOOTH }); };
  const title = $("#f-title").value.trim();
  const date = $("#f-date").value;
  if (!title || !date) { fail("Give it a title and a date."); return; }
  const allday = $("#f-allday").checked;

  let starts_at, ends_at = null;
  if (allday) {
    starts_at = fieldsToInstant(date, "00:00").toISOString();
  } else {
    const st = $("#f-start").value || "18:00";
    starts_at = fieldsToInstant(date, st).toISOString();
    const en = $("#f-end").value;
    if (en) {
      let end = fieldsToInstant(date, en);
      if (end <= new Date(starts_at)) end = new Date(end.getTime() + 86400000);
      ends_at = end.toISOString();
    }
  }
  const remind = $("#f-remind").value;
  const payload = {
    title,
    description: $("#f-desc").value.trim() || null,
    location: $("#f-location").value.trim() || null,
    photo_url: $("#f-photo").value.trim() || null,
    category_id: $("#f-category").value || null,
    starts_at, ends_at, all_day: allday,
    asks_rsvp: $("#f-rsvp").checked,
    collects_bring_list: $("#f-bring").checked,
    rrule: buildRRule({ freq: $("#f-freq").value, interval: $("#f-interval").value }),
    recurrence_end: $("#f-freq").value && $("#f-until").value ? $("#f-until").value : null,
    reminders: remind ? [Number(remind)] : [],
  };

  $("#btn-save-event").disabled = true;
  try {
    await saveEvent(payload, state.composer.eventId);
    closeComposer(true);
    await loadData();
  } catch (e) { fail(friendly(e)); }
  finally { $("#btn-save-event").disabled = false; }
}

// ---------- categories ----------
function openCategories() {
  const wrap = $("#category-list");
  const draw = () => {
    wrap.innerHTML = "";
    for (const c of state.categories) {
      const row = el("div", "category-row");
      row.innerHTML =
        `<span class="swatch" style="background:${c.color}"></span>` +
        `<input class="name" type="text" value="${escapeHtml(c.name)}" />` +
        `<input type="color" value="${c.color}" />`;
      const [nameInput, colorInput] = row.querySelectorAll("input");
      const save = el("button", "btn", "Save");
      save.type = "button";
      save.onclick = async () => {
        try { await updateCategory(c.id, { name: nameInput.value.trim(), color: colorInput.value }); await loadData(); draw(); }
        catch (e) { alert(friendly(e)); }
      };
      const del = el("button", "btn btn--danger", "Delete");
      del.type = "button";
      del.onclick = async () => {
        if (!confirm(`Delete category "${c.name}"? Events keep their date but lose the label.`)) return;
        try { await deleteCategory(c.id); await loadData(); draw(); }
        catch (e) { alert(friendly(e)); }
      };
      row.append(save, del);
      wrap.appendChild(row);
    }
  };
  draw();
  $("#btn-add-category").onclick = async () => {
    const name = $("#c-name").value.trim();
    if (!name) return;
    try { await createCategory(name, $("#c-color").value); $("#c-name").value = ""; await loadData(); draw(); }
    catch (e) { alert(friendly(e)); }
  };
  $("#dialog-categories").showModal();
}

function exportIcs() {
  const dt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const esc = (s) => String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const now = new Date();
  const from = new Date(now.getTime() - 90 * 86400000);
  const to = new Date(now.getTime() + 365 * 86400000);
  const occ = expandAll(state.events, from, to);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Connection Group Calendar//EN"];
  for (const o of occ) {
    const end = o.end || new Date(o.start.getTime() + 3600000);
    lines.push("BEGIN:VEVENT",
      `UID:${o.event.id}-${o.date}@connection-group`, `DTSTAMP:${dt(now)}`,
      `DTSTART:${dt(o.start)}`, `DTEND:${dt(end)}`, `SUMMARY:${esc(o.overrideTitle || o.event.title)}`);
    if (o.event.location) lines.push(`LOCATION:${esc(o.event.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
  a.download = "connection-group-calendar.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- auth ----------
async function refreshAuthUI() {
  const s = state.session;
  const signedIn = isEmailUser(s);
  $("#auth-signed-out").hidden = signedIn;
  $("#auth-signed-in").hidden = !signedIn;
  if (signedIn) {
    $("#auth-who").textContent = s.user.email;
    $("#auth-admin-note").textContent = state.isAdmin
      ? "You can create and edit events."
      : "This email is not on the admin list, so editing will be blocked. Ask an admin to add it.";
  }
  $$(".js-admin").forEach((b) => { b.textContent = state.isAdmin ? "Admin ✓" : "Admin"; });
  document.body.classList.toggle("admin", state.isAdmin);
}
async function computeIsAdmin() {
  if (!isEmailUser(state.session)) { state.isAdmin = false; return; }
  try {
    const { data, error } = await supabase.from("admins").select("email");
    if (error) { state.isAdmin = false; return; }
    const mine = state.session.user.email.toLowerCase();
    state.isAdmin = (data || []).some((r) => r.email.toLowerCase() === mine);
  } catch { state.isAdmin = false; }
}

// ---------- reminders (push) ----------
async function toggleReminders() {
  if (!pushSupported()) {
    alert("This browser can't do push notifications. On iPhone, add the app to your Home Screen first, then try again.");
    return;
  }
  try {
    const st = await pushStatus();
    if (st.subscribed) { await pushUnsubscribe(); setStatus("Reminders turned off on this device."); }
    else { await pushSubscribe(); setStatus("Reminders are on for this device."); }
    await refreshRemindersButton();
  } catch (e) { alert(friendly(e)); }
}
async function refreshRemindersButton() {
  if (!pushSupported()) return;
  const st = await pushStatus();
  $$(".js-reminders").forEach((btn) => {
    btn.textContent = st.subscribed ? "Reminders on" : "Reminders";
    btn.setAttribute("aria-pressed", st.subscribed ? "true" : "false");
  });
}

// ---------- misc ----------
function hhmm(d) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: GROUP_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}
function openDeepLinkedEvent() {
  const id = new URLSearchParams(location.search).get("event");
  if (!id) return;
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  const start = new Date(ev.starts_at);
  openEvent({ event: ev, start, end: ev.ends_at ? new Date(ev.ends_at) : null, date: ymd(start), recurring: !!ev.rrule });
}

// ---------- init ----------
async function init() {
  state.todayStr = ymd(new Date());
  state.selectedDate = state.todayStr;
  const [ty, tm] = state.todayStr.split("-").map(Number);
  state.visible = { year: ty, month: tm };
  setStatus("");

  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch (e) { console.warn("SW failed", e); }
  }

  state.session = await getSession();
  if (!isEmailUser(state.session)) {
    try { state.session = await ensureAnonSession(); } catch (e) { console.warn("anon session failed", e); }
  }
  state.myUserId = state.session && state.session.user ? state.session.user.id : null;
  await computeIsAdmin();
  await refreshAuthUI();

  onAuthChange(async (session) => {
    state.session = session;
    state.myUserId = (session && session.user ? session.user.id : null) || state.myUserId;
    await computeIsAdmin();
    await refreshAuthUI();
    await loadRsvpData();
    renderAll();
    if (location.hash.includes("access_token")) history.replaceState(null, "", location.pathname + location.search);
  });

  // month nav
  $("#btn-prev").onclick = () => goMonth(-1);
  $("#btn-next").onclick = () => goMonth(1);
  $("#btn-today").onclick = () => { state.visible = { year: ty, month: tm }; state.selectedDate = state.todayStr; state.focusedKey = null; renderAll(); };

  // grid swipe (mobile) -> month change
  let tx = 0, ty0 = 0;
  const grid = $("#grid");
  grid.addEventListener("touchstart", (e) => { tx = e.changedTouches[0].clientX; ty0 = e.changedTouches[0].clientY; }, { passive: true });
  grid.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty0;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) goMonth(dx < 0 ? 1 : -1);
  }, { passive: true });

  // re-render on breakpoint cross
  let wasDesktop = isDesktop();
  window.addEventListener("resize", () => {
    const now = isDesktop();
    if (now !== wasDesktop) { wasDesktop = now; renderAll(); }
  });

  // composer
  $("#btn-new-event").onclick = () => openComposer("new", null, state.selectedDate);
  $("#composer-close").onclick = () => closeComposer(false);
  $("#btn-cancel-event").onclick = () => closeComposer(false);
  $("#btn-save-event").onclick = saveComposer;
  $("#btn-delete-event").onclick = async () => {
    if (!state.composer.eventId) return;
    if (!confirm("Delete this event and all its occurrences?")) return;
    try { await deleteEvent(state.composer.eventId); closeComposer(true); await loadData(); }
    catch (e) { $("#form-msg").textContent = friendly(e); }
  };
  $("#f-allday").onchange = syncComposerDisabled;
  $("#f-freq").onchange = syncComposerDisabled;
  $("#form-event").addEventListener("submit", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if (state.activeTab === "chat" && e.key === "Escape") {
      if (!$("#attach-sheet").hidden) { e.preventDefault(); closeAttachPicker(); return; }
      if (isDesktop()) { e.preventDefault(); setTab("calendar"); return; }
    }
    if (!state.composer.open) return;
    if (e.key === "Escape") { e.preventDefault(); closeComposer(false); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveComposer(); }
  });

  // tabs / chat
  $("#tab-calendar").onclick = () => setTab("calendar");
  $("#tab-chat").onclick = () => setTab("chat");
  $("#btn-chat").onclick = () => setTab(state.activeTab === "chat" ? "calendar" : "chat");
  $("#chat-close").onclick = () => setTab("calendar");
  $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $("#chat-input").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(120, e.target.scrollHeight) + "px";
    setSendReady();
  });
  $("#chat-emoji").onclick = toggleEmojiPop;
  $("#attach-open").onclick = () => ($("#attach-sheet").hidden ? openAttachPicker() : closeAttachPicker());
  $("#attach-cancel").onclick = closeAttachPicker;
  document.addEventListener("click", (e) => {
    const pop = $("#emoji-pop");
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $("#chat-emoji")) pop.hidden = true;
  });

  // rails / links
  $("#lnk-categories").onclick = openCategories;
  $("#lnk-admins").onclick = () => $("#dialog-auth").showModal();
  $("#lnk-export").onclick = exportIcs;

  // admin dialog
  $$(".js-admin").forEach((b) => (b.onclick = () => $("#dialog-auth").showModal()));
  $("#form-auth").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "close") return;
    e.preventDefault();
    $("#btn-send-link").click();
  });
  $("#btn-send-link").onclick = async () => {
    const email = $("#auth-email").value.trim();
    if (!email) return;
    $("#auth-msg").textContent = "Sending...";
    try { await sendMagicLink(email); $("#auth-msg").textContent = "Check your email for the sign-in link."; }
    catch (e) { $("#auth-msg").textContent = friendly(e); }
  };
  $("#btn-sign-out").onclick = async () => { await signOut(); $("#dialog-auth").close(); };
  $("#btn-manage-categories").onclick = () => { $("#dialog-auth").close(); openCategories(); };

  // name dialog
  $("#form-name").addEventListener("submit", (e) => {
    const ok = e.submitter && e.submitter.value === "ok";
    const val = $("#name-input").value.trim();
    if (ok && !val) { e.preventDefault(); return; }
    const r = nameResolver; nameResolver = null;
    if (r) r(ok && val ? val : null);
  });
  $("#dialog-name").addEventListener("close", () => {
    if (nameResolver) { const r = nameResolver; nameResolver = null; r(null); }
  });

  // reminders
  $$(".js-reminders").forEach((b) => (b.onclick = toggleReminders));
  refreshRemindersButton();

  // re-run tab layout when crossing the desktop breakpoint
  const mq = matchMedia("(min-width: 1100px)");
  mq.addEventListener("change", () => setTab(state.activeTab));

  await loadData();
  openDeepLinkedEvent();

  // chat: passive unread badge + live subscription for the session
  probeUnread();
  startChatRealtime();

  const wantChat = new URLSearchParams(location.search).get("chat");
  if (wantChat) history.replaceState(null, "", location.pathname);
  let startTab = wantChat ? "chat" : "calendar";
  try { startTab = wantChat ? "chat" : (localStorage.getItem(TAB_KEY) || "calendar"); } catch { /* ignore */ }
  setTab(startTab === "chat" ? "chat" : "calendar");
}

window.__gc = state;
init();
