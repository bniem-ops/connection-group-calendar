// Group Calendar - app entry / wiring.

import { supabase } from "./lib/supabase.js";
import { DEFAULT_REMINDER_OFFSETS, GROUP_TIMEZONE } from "./config.js";
import {
  fetchCategories, fetchEvents, saveEvent, deleteEvent, cancelOccurrence,
  createCategory, updateCategory, deleteCategory,
} from "./lib/events.js";
import { expandAll, buildRRule, describeRRule } from "./lib/recurrence.js";
import { renderMonth, monthGridRange } from "./lib/calendar.js";
import {
  getSession, onAuthChange, sendMagicLink, signOut, isEmailUser,
} from "./lib/auth.js";
import {
  pushSupported, getStatus as pushStatus, subscribe as pushSubscribe,
  unsubscribe as pushUnsubscribe,
} from "./lib/push.js";
import {
  fieldsToInstant, ymd, formatTime, formatDateLong, formatDateTime,
} from "./lib/tz.js";

const $ = (sel) => document.querySelector(sel);
const HIDDEN_KEY = "gc.hiddenCategories";

const state = {
  year: 0,
  month: 0,          // 1-12
  categories: [],
  events: [],
  occByDate: new Map(),
  session: null,
  isAdmin: false,
  hidden: new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")),
  editingId: null,
  formReminders: [],
};

// ---------- helpers ----------
const catById = (id) => state.categories.find((c) => c.id === id);
const catColor = (id) => (catById(id) ? catById(id).color : "#6b7280");
const catName = (id) => (catById(id) ? catById(id).name : "Uncategorized");

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

// ---------- data + render ----------
async function loadData() {
  try {
    const [cats, evs] = await Promise.all([fetchCategories(), fetchEvents()]);
    state.categories = cats;
    state.events = evs;
    renderFilterBar();
    render();
    setStatus(`${evs.length} event${evs.length === 1 ? "" : "s"} loaded. Times in ${GROUP_TIMEZONE}.`);
  } catch (e) {
    console.error(e);
    setStatus("Could not load data. Check public/config.js and that the SQL was run.");
  }
}

function render() {
  const { year, month } = state;
  $("#month-label").textContent = new Intl.DateTimeFormat(undefined, {
    month: "long", year: "numeric", timeZone: GROUP_TIMEZONE,
  }).format(fieldsToInstant(`${year}-${String(month).padStart(2, "0")}-15`, "12:00"));

  const { start, end } = monthGridRange(year, month);
  const occ = expandAll(state.events, start, end)
    .filter((o) => !state.hidden.has(o.event.category_id || "__none__"));

  const map = new Map();
  for (const o of occ) {
    if (!map.has(o.date)) map.set(o.date, []);
    map.get(o.date).push(o);
  }
  state.occByDate = map;

  renderMonth($("#grid"), {
    year, month,
    occurrencesByDate: map,
    catColor,
    onDayClick: openDay,
    onEventClick: openEvent,
  });
}

function renderFilterBar() {
  const bar = $("#filter-bar");
  bar.innerHTML = "";
  const entries = state.categories.map((c) => ({ id: c.id, name: c.name, color: c.color }));
  entries.push({ id: "__none__", name: "Uncategorized", color: "#6b7280" });
  for (const e of entries) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.setAttribute("aria-pressed", state.hidden.has(e.id) ? "false" : "true");
    btn.innerHTML = `<span class="chip__dot" style="background:${e.color}"></span>${e.name}`;
    btn.addEventListener("click", () => {
      if (state.hidden.has(e.id)) state.hidden.delete(e.id);
      else state.hidden.add(e.id);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.hidden]));
      btn.setAttribute("aria-pressed", state.hidden.has(e.id) ? "false" : "true");
      render();
    });
    bar.appendChild(btn);
  }
}

// ---------- day / event dialogs ----------
function openDay(dateStr, list) {
  const d = fieldsToInstant(dateStr, "12:00");
  $("#day-title").textContent = formatDateLong(d);
  const wrap = $("#day-events");
  wrap.innerHTML = "";
  if (!list.length) {
    wrap.innerHTML = '<p class="empty">No events.</p>';
  } else {
    for (const occ of list) {
      const row = document.createElement("div");
      row.className = "day-ev";
      const time = occ.event.all_day ? "All day" : formatTime(occ.start);
      row.innerHTML =
        `<span class="swatch" style="background:${catColor(occ.event.category_id)}"></span>` +
        `<span class="time">${time}</span>` +
        `<span class="title">${escapeHtml(occ.overrideTitle || occ.event.title)}</span>`;
      row.addEventListener("click", () => { $("#dialog-day").close(); openEvent(occ); });
      wrap.appendChild(row);
    }
  }
  $("#day-admin-foot").hidden = !state.isAdmin;
  $("#btn-add-on-day").onclick = () => { $("#dialog-day").close(); openForm(null, dateStr); };
  $("#dialog-day").showModal();
}

function openEvent(occ) {
  const ev = occ.event;
  $("#event-title").textContent = occ.overrideTitle || ev.title;
  const body = $("#event-body");
  body.innerHTML = "";
  const add = (dt, dd, isHtml) => {
    if (!dd) return;
    const a = document.createElement("dt"); a.textContent = dt;
    const b = document.createElement("dd");
    if (isHtml) b.innerHTML = dd; else b.textContent = dd;
    body.append(a, b);
  };
  const when = ev.all_day
    ? formatDateLong(occ.start) + " (all day)"
    : `${formatDateTime(occ.start)}${occ.end ? " – " + formatTime(occ.end) : ""}`;
  add("When", when);
  add("Category", catName(ev.category_id));
  if (occ.recurring) add("Repeats", describeRRule(ev.rrule, ev.recurrence_end));
  add("Where", occ.overrideLocation || ev.location);
  if (ev.url) add("Link", `<a href="${escapeAttr(ev.url)}" target="_blank" rel="noopener">${escapeHtml(ev.url)}</a>`, true);
  add("Details", ev.description);
  if (ev.reminders && ev.reminders.length) {
    add("Reminders", ev.reminders.map((r) => minutesToText(r.offset_minutes)).join(", "));
  }

  $("#event-admin-foot").hidden = !state.isAdmin;
  $("#btn-event-skip").hidden = !state.isAdmin || !occ.recurring;
  $("#btn-event-edit").onclick = () => { $("#dialog-event").close(); openForm(ev, null); };
  $("#btn-event-delete").onclick = async () => {
    if (!confirm(`Delete "${ev.title}"${occ.recurring ? " and all its occurrences" : ""}?`)) return;
    try { await deleteEvent(ev.id); $("#dialog-event").close(); await loadData(); }
    catch (e) { alert(friendly(e)); }
  };
  $("#btn-event-skip").onclick = async () => {
    if (!confirm(`Skip the ${occ.date} occurrence of "${ev.title}"?`)) return;
    try { await cancelOccurrence(ev.id, occ.date); $("#dialog-event").close(); await loadData(); }
    catch (e) { alert(friendly(e)); }
  };
  $("#dialog-event").showModal();
}

// ---------- event form ----------
function renderReminderList() {
  const wrap = $("#reminder-list");
  wrap.innerHTML = "";
  if (!state.formReminders.length) {
    wrap.innerHTML = '<p class="muted">No reminders.</p>';
  }
  state.formReminders
    .slice()
    .sort((a, b) => b - a)
    .forEach((m) => {
      const row = document.createElement("div");
      row.className = "reminder-row";
      row.innerHTML = `<span>${minutesToText(m)}</span>`;
      const rm = document.createElement("button");
      rm.type = "button"; rm.className = "btn"; rm.textContent = "Remove";
      rm.onclick = () => {
        state.formReminders = state.formReminders.filter((x) => x !== m);
        renderReminderList();
      };
      row.appendChild(rm);
      wrap.appendChild(row);
    });
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

  $("#f-category").innerHTML =
    '<option value="">Uncategorized</option>' +
    state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  const start = ev ? new Date(ev.starts_at) : null;
  $("#f-title").value = ev ? ev.title : "";
  $("#f-category").value = ev && ev.category_id ? ev.category_id : "";
  $("#f-allday").checked = ev ? ev.all_day : false;
  $("#f-date").value = ev ? ymd(start) : (presetDate || ymd(new Date()));
  $("#f-start").value = ev && !ev.all_day ? hhmm(start) : "18:00";
  $("#f-end").value = ev && ev.ends_at && !ev.all_day ? hhmm(new Date(ev.ends_at)) : "";
  $("#f-location").value = ev ? ev.location || "" : "";
  $("#f-url").value = ev ? ev.url || "" : "";
  $("#f-desc").value = ev ? ev.description || "" : "";

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
    category_id: $("#f-category").value || null,
    starts_at,
    ends_at,
    all_day: allday,
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
      const row = document.createElement("div");
      row.className = "category-row";
      row.innerHTML =
        `<span class="swatch" style="background:${c.color}"></span>` +
        `<input class="name" type="text" value="${escapeAttr(c.name)}" />` +
        `<input type="color" value="${c.color}" />`;
      const [nameInput, colorInput] = row.querySelectorAll("input");
      const save = document.createElement("button");
      save.type = "button"; save.className = "btn"; save.textContent = "Save";
      save.onclick = async () => {
        try { await updateCategory(c.id, { name: nameInput.value.trim(), color: colorInput.value }); await loadData(); draw(); }
        catch (e) { alert(friendly(e)); }
      };
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn btn--danger"; del.textContent = "Delete";
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
    try {
      await createCategory(name, $("#c-color").value);
      $("#c-name").value = "";
      await loadData(); draw();
    } catch (e) { alert(friendly(e)); }
  };
  $("#dialog-categories").showModal();
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
    if (st.subscribed) {
      await pushUnsubscribe();
      setStatus("Reminders turned off on this device.");
    } else {
      await pushSubscribe();
      setStatus("Reminders are on for this device.");
    }
    await refreshRemindersButton();
  } catch (e) {
    alert(friendly(e));
  }
}

async function refreshRemindersButton() {
  const btn = $("#btn-reminders");
  if (!pushSupported()) { btn.disabled = false; return; }
  const st = await pushStatus();
  btn.innerHTML = st.subscribed
    ? '<span aria-hidden="true">&#128276;</span><span class="btn__label"> Reminders on</span>'
    : '<span aria-hidden="true">&#128277;</span><span class="btn__label"> Reminders</span>';
}

// ---------- misc ----------
function hhmm(d) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: GROUP_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(d);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;
function friendly(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/row-level security|permission denied|violates/i.test(m)) {
    return "The server rejected that - your account isn't allowed to make this change.";
  }
  return m;
}

async function goMonth(delta) {
  let m = state.month + delta, y = state.year;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  state.month = m; state.year = y;
  render();
}

function openDeepLinkedEvent() {
  const id = new URLSearchParams(location.search).get("event");
  if (!id) return;
  const ev = state.events.find((e) => e.id === id);
  if (ev) openEvent({ event: ev, start: new Date(ev.starts_at), end: ev.ends_at ? new Date(ev.ends_at) : null, date: ymd(new Date(ev.starts_at)), recurring: !!ev.rrule });
}

// ---------- init ----------
async function init() {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-US", { timeZone: GROUP_TIMEZONE, year: "numeric", month: "numeric" }).formatToParts(now);
  state.year = +p.find((x) => x.type === "year").value;
  state.month = +p.find((x) => x.type === "month").value;
  setStatus("");

  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch (e) { console.warn("SW failed", e); }
  }

  state.session = await getSession();
  await computeIsAdmin();
  await refreshAuthUI();

  onAuthChange(async (session) => {
    state.session = session;
    await computeIsAdmin();
    await refreshAuthUI();
    render();
    // Clean the magic-link hash out of the URL.
    if (location.hash.includes("access_token")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  });

  // nav
  $("#btn-prev").onclick = () => goMonth(-1);
  $("#btn-next").onclick = () => goMonth(1);
  $("#btn-today").onclick = () => { const d = new Date(); const q = new Intl.DateTimeFormat("en-US", { timeZone: GROUP_TIMEZONE, year: "numeric", month: "numeric" }).formatToParts(d); state.year = +q.find((x) => x.type === "year").value; state.month = +q.find((x) => x.type === "month").value; render(); };

  // Enter inside a data-entry field shouldn't submit-and-close the dialog form.
  $("#form-event").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "close") return;
    e.preventDefault();
  });
  $("#form-auth").addEventListener("submit", (e) => {
    if (e.submitter && e.submitter.value === "close") return;
    e.preventDefault();
    $("#btn-send-link").click();
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
  openDeepLinkedEvent();
}

// `hhmm` is referenced inside openForm before this point in source order but
// function declarations hoist, so this is fine.
window.__gc = state; // handy for debugging in the console
init();
