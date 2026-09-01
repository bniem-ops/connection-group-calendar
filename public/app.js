// Connection Group Calendar - app entry / wiring. Rolling weeks + RSVP.

import { supabase } from "./lib/supabase.js";
import { DEFAULT_REMINDER_OFFSETS, GROUP_TIMEZONE } from "./config.js";
import {
  fetchCategories, fetchEvents, saveEvent, deleteEvent, cancelOccurrence,
  createCategory, updateCategory, deleteCategory,
  fetchRsvps, fetchMembers, setDisplayName, setRsvp, clearRsvp,
} from "./lib/events.js";
import { expandAll, buildRRule } from "./lib/recurrence.js";
import {
  startOfWeek, addDays, weekDays, weekMonthKey, buildWeekBlock,
} from "./lib/calendar.js";
import {
  getSession, onAuthChange, sendMagicLink, signOut, isEmailUser, ensureAnonSession,
} from "./lib/auth.js";
import {
  pushSupported, getStatus as pushStatus, subscribe as pushSubscribe,
  unsubscribe as pushUnsubscribe,
} from "./lib/push.js";
import { fieldsToInstant, ymd } from "./lib/tz.js";

const $ = (sel) => document.querySelector(sel);
const HIDDEN_KEY = "gc.hiddenCategories";
const SMOOTH = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

const state = {
  todayStr: "",
  curWeekStart: "",
  nextWeekStart: "",
  weeks: [],
  expandedQuiet: new Set(),
  appending: false,

  categories: [],
  events: [],

  rsvps: [],
  members: new Map(),
  rsvpMine: new Map(),
  rsvpCounts: new Map(),
  myUserId: null,

  session: null,
  isAdmin: false,
  hidden: new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")),
  editingId: null,
  formReminders: [],
};

// ---------- small helpers ----------
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const catById = (id) => state.categories.find((c) => c.id === id);
const catColor = (id) => (catById(id) ? catById(id).color : "#7d5411");
const catName = (id) => (catById(id) ? catById(id).name : "Uncategorized");
const catTextColor = (id) => (catById(id) ? darken(catById(id).color, 0.62) : "#7d5411");
const occKey = (o) => `${o.event.id}:${o.date}`;
const splitKey = (k) => { const i = k.lastIndexOf(":"); return [k.slice(0, i), k.slice(i + 1)]; };

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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: GROUP_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(date);
  const g = (t) => (parts.find((z) => z.type === t) || {}).value || "";
  const ap = g("dayPeriod").toLowerCase().startsWith("p") ? "p" : "a";
  return `${g("hour")}:${g("minute")}${ap}`;
}
function longDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: GROUP_TIMEZONE, weekday: "short", month: "short", day: "numeric",
  }).format(date);
}
function timeRange(occ) {
  return occ.end ? `${shortTime(occ.start)} – ${shortTime(occ.end)}` : shortTime(occ.start);
}
function monthName(key, withYear) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: GROUP_TIMEZONE, month: "long", ...(withYear ? { year: "numeric" } : {}),
  }).format(fieldsToInstant(`${key}-15`, "12:00"));
}
function minutesToText(m) {
  let n, unit;
  if (m % 1440 === 0) { n = m / 1440; unit = "day"; }
  else if (m % 60 === 0) { n = m / 60; unit = "hour"; }
  else { n = m; unit = "minute"; }
  return `${n} ${unit}${n === 1 ? "" : "s"} before`;
}
function setStatus(msg) {
  $("#status-line").textContent = msg || `Times shown in ${GROUP_TIMEZONE}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function friendly(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/row-level security|permission denied|violates/i.test(m)) {
    return "The server rejected that - your account isn't allowed to make this change.";
  }
  return m;
}

// ---------- data ----------
async function loadData() {
  try {
    const [cats, evs] = await Promise.all([fetchCategories(), fetchEvents()]);
    state.categories = cats;
    state.events = evs;
    await loadRsvpData();
    renderWeeks();
    setStatus(`Times shown in ${GROUP_TIMEZONE}`);
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
  } catch (e) {
    console.warn("RSVP data load failed", e);
  }
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
    if (r.note) {
      const t = r.note.trim();
      c.noteBits.push(`${t.charAt(0).toUpperCase()}${t.slice(1)} — ${nm}`);
    }
    if (r.user_id === state.myUserId) state.rsvpMine.set(key, r.status);
  }
}

function applyRsvpLocal(eventId, date, uid, status, note) {
  const i = state.rsvps.findIndex(
    (r) => r.event_id === eventId && r.occurrence_date === date && r.user_id === uid
  );
  const oldNote = i >= 0 ? state.rsvps[i].note : null;
  if (i >= 0) state.rsvps.splice(i, 1);
  if (status) {
    state.rsvps.push({
      event_id: eventId, occurrence_date: date, user_id: uid, status,
      note: note !== undefined ? note : oldNote,
    });
  }
  recomputeRsvp();
}

// ---------- render: rolling weeks ----------
function renderWeeks() {
  const host = $("#weeks");
  const rangeStart = fieldsToInstant(state.weeks[0], "00:00");
  const rangeEnd = fieldsToInstant(addDays(state.weeks[state.weeks.length - 1], 7), "00:00");
  const occ = expandAll(state.events, rangeStart, rangeEnd)
    .filter((o) => !state.hidden.has(o.event.category_id || "__none__"));

  const byDate = new Map();
  for (const o of occ) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }

  const ctx = {
    todayStr: state.todayStr,
    curWeekStart: state.curWeekStart,
    nextWeekStart: state.nextWeekStart,
    occByDate: byDate,
    catColor, catTextColor, catName, shortTime,
    canRsvp: (o) => o.date >= state.todayStr,
    renderRsvpControls,
    onEntryClick: openEvent,
    onDateClick: scrollToDate,
  };

  const weekHasEv = (ws) => weekDays(ws).some((d) => byDate.has(d));
  host.innerHTML = "";
  let i = 0;
  while (i < state.weeks.length) {
    const ws = state.weeks[i];
    if (!weekHasEv(ws)) {
      let j = i;
      while (j < state.weeks.length && !weekHasEv(state.weeks[j])) j++;
      const runLen = j - i;
      const runKey = ws;
      const run = state.weeks.slice(i, j);
      const hasAnchor = run.includes(state.curWeekStart) || run.includes(state.nextWeekStart);
      if (runLen >= 3 && !hasAnchor && !state.expandedQuiet.has(runKey)) {
        const q = el("button", "quiet");
        q.type = "button";
        q.appendChild(el("span", null, `${runLen} quiet weeks`));
        q.onclick = () => { state.expandedQuiet.add(runKey); renderWeeks(); };
        host.appendChild(q);
        i = j;
        continue;
      }
    }
    host.appendChild(buildWeekBlock(ws, ctx));
    i++;
  }
  updateMonthBar();
}

function updateMonthBar() {
  const bar = $("#monthbar");
  if (!bar) return;
  const y = bar.getBoundingClientRect().bottom + 1;
  const weeks = document.querySelectorAll("#weeks .week");
  let key = weeks.length ? weeks[0].dataset.monthKey : null;
  for (const w of weeks) {
    if (w.getBoundingClientRect().bottom > y) { key = w.dataset.monthKey; break; }
  }
  if (key) $("#month-name").textContent = monthName(key).toUpperCase();
}

function scrollElIntoView(node, behavior) {
  const barH = $("#monthbar").getBoundingClientRect().height;
  const top = node.getBoundingClientRect().top + window.scrollY - barH - 6;
  window.scrollTo({ top: Math.max(0, top), behavior: behavior || SMOOTH });
}
function scrollToWeek(ws, behavior) {
  const node = document.querySelector(`#weeks .week[data-week-start="${ws}"]`);
  if (node) scrollElIntoView(node, behavior);
}
function scrollToDate(dateStr) {
  let node = document.querySelector(`#weeks .entry[data-occ$=":${dateStr}"]`);
  if (!node) node = document.querySelector(`#weeks .week[data-week-start="${startOfWeek(dateStr)}"]`);
  if (node) scrollElIntoView(node);
}

function appendWeeks() {
  if (state.appending || state.weeks.length >= 90) return;
  state.appending = true;
  const last = state.weeks[state.weeks.length - 1];
  for (let k = 1; k <= 8; k++) state.weeks.push(addDays(last, k * 7));
  renderWeeks();
  state.appending = false;
}
function loadEarlier() {
  const se = document.scrollingElement || document.documentElement;
  const h0 = se.scrollHeight;
  const first = state.weeks[0];
  for (let k = 4; k >= 1; k--) state.weeks.unshift(addDays(first, -k * 7));
  renderWeeks();
  se.scrollTop += se.scrollHeight - h0;
}

// ---------- RSVP controls (shared by strip + detail band) ----------
function renderRsvpControls(container, occ, variant) {
  container.innerHTML = "";
  container.classList.add("rsvp");
  if (variant === "strip") container.classList.add("rsvp--strip");
  container.dataset.occ = occKey(occ);

  const key = occKey(occ);
  const mine = state.rsvpMine.get(key) || null;
  const c = state.rsvpCounts.get(key) || { yes: 0 };

  const yes = el("button", "rsvp-btn rsvp-btn--yes", mine === "yes" ? "I'm in ✓" : "I'm in");
  yes.type = "button";
  yes.setAttribute("aria-pressed", mine === "yes" ? "true" : "false");
  yes.onclick = (e) => { e.stopPropagation(); handleRsvp(occ, "yes", container, variant); };

  const no = el("button", "rsvp-btn rsvp-btn--no", variant === "band" ? "Can't make it" : "Can't");
  no.type = "button";
  no.setAttribute("aria-pressed", mine === "no" ? "true" : "false");
  no.onclick = (e) => { e.stopPropagation(); handleRsvp(occ, "no", container, variant); };

  container.append(yes, no);

  if (variant === "strip") {
    container.appendChild(el("span", "rsvp-count", `${c.yes || 0} going`));
  }
}

function rsvpMsg(container, text) {
  let m = container.querySelector(".rsvp-msg");
  if (!m) { m = el("span", "rsvp-msg"); container.appendChild(m); }
  m.textContent = text;
}

async function ensureMember() {
  if (!state.myUserId) {
    try { const s = await ensureAnonSession(); state.myUserId = s.user.id; }
    catch { return false; }
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

async function handleRsvp(occ, status, container, variant) {
  if (!(await ensureMember())) {
    if (container) rsvpMsg(container, "Couldn't save - try again.");
    return;
  }
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
  try {
    await setRsvp(state.myUserId, occ.event.id, occ.date, status, text);
  } catch (e) {
    console.warn(e);
    await loadRsvpData();
    refreshRsvpUI(key);
  }
}

function refreshRsvpUI(key) {
  const [eventId, date] = splitKey(key);
  const occ = { event: state.events.find((e) => e.id === eventId) || { id: eventId }, date };
  document.querySelectorAll(`.rsvp[data-occ="${key}"]`).forEach((n) => {
    renderRsvpControls(n, occ, n.closest(".ev2__rsvp") ? "band" : "strip");
  });
  document.querySelectorAll(`.ev2__names[data-occ="${key}"]`).forEach(() => updateNames(key));
  document.querySelectorAll(`.ev2__bring[data-occ="${key}"]`).forEach((n) => renderBringing(n, occ));
}

function updateNames(key) {
  const node = document.querySelector(`.ev2__names[data-occ="${key}"]`);
  if (!node) return;
  const c = state.rsvpCounts.get(key) || { yes: 0, no: 0, yesNames: [] };
  const total = state.members.size;
  const havent = Math.max(0, total - c.yes - c.no);
  if (!c.yes && !c.no) {
    node.innerHTML = `<span class="sub">No one's answered yet.</span>`;
    return;
  }
  const line1 = c.yes
    ? `<b>${c.yes} going</b> — ${escapeHtml(c.yesNames.join(", "))}`
    : `<b>0 going</b>`;
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
  add.onclick = () => {
    const t = prompt("What are you bringing?");
    if (t && t.trim()) setBringing(occ, t.trim());
  };
  container.appendChild(add);
}

// ---------- event detail (Screen 2) ----------
function openEvent(occ) {
  const ev = occ.event;
  const wrap = $("#event-scroll");
  wrap.innerHTML = "";
  const key = occKey(occ);

  const nav = el("div", "ev2__nav");
  const back = el("button", "ev2__back", `‹ ${monthName(occ.date.slice(0, 7))}`);
  back.type = "button";
  back.onclick = () => $("#dialog-event").close();
  const share = el("button", "ev2__share", "Share");
  share.type = "button";
  share.onclick = () => shareEvent(occ);
  nav.append(back, share);
  wrap.appendChild(nav);

  if (ev.photo_url) {
    const img = document.createElement("img");
    img.className = "plate";
    img.alt = "";
    img.onerror = () => img.remove();
    img.src = ev.photo_url;
    wrap.appendChild(img);
  }

  const cat = el("div", "ev2__cat");
  const dot = el("span", "dot");
  dot.style.background = catColor(ev.category_id);
  const cn = el("span", "ev2__catname", catName(ev.category_id).toUpperCase());
  cn.style.color = catTextColor(ev.category_id);
  cat.append(dot, cn);
  wrap.appendChild(cat);

  wrap.appendChild(el("h2", "ev2__title", occ.overrideTitle || ev.title));

  const when = el("div", "ev2__when");
  when.appendChild(el("span", "ev2__date", longDate(occ.start)));
  when.appendChild(el("span", "ev2__time", ev.all_day ? "All day" : timeRange(occ)));
  wrap.appendChild(when);

  const note = (ev.description || "").trim();
  if (note) {
    wrap.appendChild(el("div", "ev2__rule"));
    wrap.appendChild(el("p", "ev2__desc", note));
  }
  wrap.appendChild(el("div", "ev2__rule"));

  const meta = el("div", "ev2__meta");
  const where = el("div");
  where.appendChild(el("div", "lbl", "Where"));
  const loc = occ.overrideLocation || ev.location;
  if (loc) {
    where.appendChild(el("div", null, loc));
    const a = document.createElement("a");
    a.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open in Maps";
    where.appendChild(a);
  } else {
    where.appendChild(el("div", "sub", "—"));
  }
  const rem = el("div");
  rem.appendChild(el("div", "lbl", "Reminder"));
  rem.appendChild(el("div", null,
    ev.reminders && ev.reminders.length
      ? ev.reminders.map((r) => minutesToText(r.offset_minutes)).join(", ")
      : "None"));
  meta.append(where, rem);
  wrap.appendChild(meta);

  if (ev.rsvp_enabled) {
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

    const bring = el("div", "ev2__bring");
    renderBringing(bring, occ);
    wrap.appendChild(bring);
  }

  if (state.isAdmin) {
    const foot = el("div", "sheet__foot");
    const edit = el("button", "btn", "Edit");
    edit.type = "button";
    edit.onclick = () => { $("#dialog-event").close(); openForm(ev, null); };
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
    const del = el("button", "btn btn--danger", "Delete");
    del.type = "button";
    del.onclick = async () => {
      if (!confirm(`Delete "${ev.title}"${occ.recurring ? " and all its occurrences" : ""}?`)) return;
      try { await deleteEvent(ev.id); $("#dialog-event").close(); await loadData(); }
      catch (e) { alert(friendly(e)); }
    };
    foot.appendChild(del);
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
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Connection Group Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${ev.id}-${occ.date}@connection-group`,
    `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(occ.start)}`,
    `DTEND:${dt(end)}`,
    `SUMMARY:${esc(title)}`,
    ev.location ? `LOCATION:${esc(ev.location)}` : null,
    ev.description ? `DESCRIPTION:${esc(ev.description)}` : null,
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
  const blurb = `${title} — ${longDate(occ.start)}${ev.all_day ? "" : " " + shortTime(occ.start)}${ev.location ? " · " + ev.location : ""}`;

  if (navigator.share) {
    navigator.share({ title, text: blurb }).catch(() => {});
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `${title.replace(/[^\w]+/g, "-").toLowerCase().replace(/^-|-$/g, "")}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- display-name prompt ----------
let nameResolver = null;
function promptName() {
  return new Promise((resolve) => {
    nameResolver = resolve;
    $("#name-input").value = "";
    $("#dialog-name").showModal();
  });
}

// ---------- event form (Screen 3) ----------
function renderReminderList() {
  const wrap = $("#reminder-list");
  wrap.innerHTML = "";
  if (!state.formReminders.length) wrap.innerHTML = '<p class="muted">No reminders.</p>';
  state.formReminders.slice().sort((a, b) => b - a).forEach((m) => {
    const row = el("div", "reminder-row");
    row.appendChild(el("span", null, minutesToText(m)));
    const rm = el("button", "btn", "Remove");
    rm.type = "button";
    rm.onclick = () => { state.formReminders = state.formReminders.filter((x) => x !== m); renderReminderList(); };
    row.appendChild(rm);
    wrap.appendChild(row);
  });
}

function renderCategoryPills(selectedId) {
  const wrap = $("#f-category-pills");
  wrap.innerHTML = "";
  const entries = [{ id: "", name: "Uncategorized", color: "#7d5411" },
    ...state.categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))];
  for (const e of entries) {
    const b = el("button", "pill");
    b.type = "button";
    b.dataset.id = e.id;
    const on = (selectedId || "") === e.id;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.innerHTML = `<span class="dot" style="background:${e.color}"></span>${escapeHtml(e.name)}`;
    if (on) { b.style.borderColor = e.color; b.style.background = hexToRgba(e.color, 0.12); }
    b.onclick = () => { $("#f-category").value = e.id; renderCategoryPills(e.id); };
    wrap.appendChild(b);
  }
}

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

function openForm(ev, presetDate) {
  state.editingId = ev ? ev.id : null;
  $("#form-title").textContent = ev ? "Edit event" : "New event";
  $("#form-msg").textContent = "";

  const start = ev ? new Date(ev.starts_at) : null;
  $("#f-title").value = ev ? ev.title : "";
  $("#f-category").value = ev && ev.category_id ? ev.category_id : "";
  renderCategoryPills($("#f-category").value);
  $("#f-allday").checked = ev ? ev.all_day : false;
  $("#f-date").value = ev ? ymd(start) : (presetDate || ymd(new Date()));
  $("#f-start").value = ev && !ev.all_day ? hhmm(start) : "18:00";
  $("#f-end").value = ev && ev.ends_at && !ev.all_day ? hhmm(new Date(ev.ends_at)) : "";
  $("#f-location").value = ev ? ev.location || "" : "";
  $("#f-url").value = ev ? ev.url || "" : "";
  $("#f-photo").value = ev ? ev.photo_url || "" : "";
  $("#f-desc").value = ev ? ev.description || "" : "";
  $("#f-rsvp").checked = ev ? ev.rsvp_enabled !== false : true;

  const rr = parseRRule(ev ? ev.rrule : null);
  $("#f-freq").value = rr.freq;
  $("#f-interval").value = rr.interval;
  $("#f-until").value = ev && ev.recurrence_end ? ev.recurrence_end : "";

  state.formReminders = ev
    ? (ev.reminders || []).map((r) => r.offset_minutes)
    : DEFAULT_REMINDER_OFFSETS.slice();
  renderReminderList();
  syncFormDisabled();
  $("#dialog-form").showModal();
}

function syncFormDisabled() {
  const allday = $("#f-allday").checked;
  document.querySelectorAll(".time-only input").forEach((i) => (i.disabled = allday));
  const repeats = !!$("#f-freq").value;
  document.querySelectorAll(".repeat-only input").forEach((i) => (i.disabled = !repeats));
}

async function saveFromForm() {
  const msg = $("#form-msg");
  const title = $("#f-title").value.trim();
  const date = $("#f-date").value;
  if (!title || !date) { msg.textContent = "Title and date are required."; return; }
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

  const payload = {
    title,
    description: $("#f-desc").value.trim() || null,
    location: $("#f-location").value.trim() || null,
    url: $("#f-url").value.trim() || null,
    photo_url: $("#f-photo").value.trim() || null,
    category_id: $("#f-category").value || null,
    starts_at,
    ends_at,
    all_day: allday,
    rsvp_enabled: $("#f-rsvp").checked,
    rrule: buildRRule({ freq: $("#f-freq").value, interval: $("#f-interval").value }),
    recurrence_end: $("#f-freq").value && $("#f-until").value ? $("#f-until").value : null,
    reminders: state.formReminders,
  };

  $("#btn-save-event").disabled = true;
  try {
    await saveEvent(payload, state.editingId);
    $("#dialog-form").close();
    await loadData();
  } catch (e) {
    msg.textContent = friendly(e);
  } finally {
    $("#btn-save-event").disabled = false;
  }
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

// ---------- jump / filter ----------
function openJump() {
  const list = $("#jump-list");
  list.innerHTML = "";
  const seen = new Set();
  for (const ws of state.weeks) {
    const key = weekMonthKey(ws);
    if (seen.has(key)) continue;
    seen.add(key);
    const b = el("button", null, monthName(key, true));
    b.type = "button";
    b.onclick = () => {
      $("#dialog-jump").close();
      const node = document.querySelector(`#weeks .week[data-month-key="${key}"]`);
      if (node) scrollElIntoView(node);
    };
    list.appendChild(b);
  }
  $("#dialog-jump").showModal();
}

function openFilter() {
  const list = $("#filter-list");
  list.innerHTML = "";
  const entries = [...state.categories.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    { id: "__none__", name: "Uncategorized", color: "#7d5411" }];
  for (const e of entries) {
    const row = el("button", "filter-row");
    row.type = "button";
    const on = !state.hidden.has(e.id);
    row.setAttribute("aria-pressed", on ? "true" : "false");
    row.innerHTML =
      `<span class="dot" style="background:${e.color}"></span>` +
      `<span>${escapeHtml(e.name)}</span>` +
      `<span class="state">${on ? "shown" : "hidden"}</span>`;
    row.onclick = () => {
      if (state.hidden.has(e.id)) state.hidden.delete(e.id);
      else state.hidden.add(e.id);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden]));
      const nowOn = !state.hidden.has(e.id);
      row.setAttribute("aria-pressed", nowOn ? "true" : "false");
      row.querySelector(".state").textContent = nowOn ? "shown" : "hidden";
      renderWeeks();
    };
    list.appendChild(row);
  }
  $("#dialog-filter").showModal();
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
  $("#btn-admin").textContent = state.isAdmin ? "Admin ✓" : "Admin";
}

async function computeIsAdmin() {
  if (!isEmailUser(state.session)) { state.isAdmin = false; return; }
  try {
    const { data, error } = await supabase.from("admins").select("email");
    if (error) { state.isAdmin = false; return; }
    const mine = state.session.user.email.toLowerCase();
    state.isAdmin = (data || []).some((r) => r.email.toLowerCase() === mine);
  } catch {
    state.isAdmin = false;
  }
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
  } catch (e) {
    alert(friendly(e));
  }
}
async function refreshRemindersButton() {
  const btn = $("#btn-reminders");
  if (!pushSupported()) return;
  const st = await pushStatus();
  btn.textContent = st.subscribed ? "Reminders on" : "Reminders";
  btn.setAttribute("aria-pressed", st.subscribed ? "true" : "false");
}

// ---------- misc ----------
function hhmm(d) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: GROUP_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(d);
}

function openDeepLinkedEvent() {
  const id = new URLSearchParams(location.search).get("event");
  if (!id) return;
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  const start = new Date(ev.starts_at);
  openEvent({
    event: ev, start, end: ev.ends_at ? new Date(ev.ends_at) : null,
    date: ymd(start), recurring: !!ev.rrule,
  });
}

// ---------- init ----------
async function init() {
  state.todayStr = ymd(new Date());
  state.curWeekStart = startOfWeek(state.todayStr);
  state.nextWeekStart = addDays(state.curWeekStart, 7);
  state.weeks = Array.from({ length: 8 }, (_, i) => addDays(state.curWeekStart, i * 7));
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
    renderWeeks();
    if (location.hash.includes("access_token")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  });

  // rolling-weeks nav
  $("#btn-earlier").onclick = loadEarlier;
  $("#btn-jump").onclick = openJump;
  $("#btn-filter").onclick = openFilter;

  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; updateMonthBar(); });
  }, { passive: true });

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) appendWeeks();
  }, { rootMargin: "800px 0px" }).observe($("#sentinel"));

  // dialogs: keep Enter inside a field from submitting-and-closing
  $("#form-event").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "close") return;
    e.preventDefault();
  });
  $("#form-auth").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "close") return;
    e.preventDefault();
    $("#btn-send-link").click();
  });
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

  // admin dialog
  $("#btn-admin").onclick = () => $("#dialog-auth").showModal();
  $("#btn-send-link").onclick = async () => {
    const email = $("#auth-email").value.trim();
    if (!email) return;
    $("#auth-msg").textContent = "Sending...";
    try { await sendMagicLink(email); $("#auth-msg").textContent = "Check your email for the sign-in link."; }
    catch (e) { $("#auth-msg").textContent = friendly(e); }
  };
  $("#btn-sign-out").onclick = async () => { await signOut(); $("#dialog-auth").close(); };
  $("#btn-new-event").onclick = () => { $("#dialog-auth").close(); openForm(null, null); };
  $("#btn-manage-categories").onclick = () => { $("#dialog-auth").close(); openCategories(); };

  // event form
  $("#f-allday").onchange = syncFormDisabled;
  $("#f-freq").onchange = syncFormDisabled;
  $("#btn-add-reminder").onclick = () => {
    const amt = parseInt($("#r-amount").value, 10);
    const unit = parseInt($("#r-unit").value, 10);
    if (!amt || amt < 1) return;
    const mins = amt * unit;
    if (!state.formReminders.includes(mins)) state.formReminders.push(mins);
    renderReminderList();
  };
  $("#btn-save-event").onclick = saveFromForm;

  // reminders
  $("#btn-reminders").onclick = toggleReminders;
  refreshRemindersButton();

  await loadData();
  scrollToWeek(state.curWeekStart, "auto");
  updateMonthBar();
  openDeepLinkedEvent();
}

window.__gc = state;
init();
