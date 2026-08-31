# Group Calendar — Architecture & Requirements

Status: MVP build. Decisions below were made to get a working v1 without blocking
on further input; each "locked decision" notes how to revisit it.

## 1. Purpose

A shared, installable calendar for a group that meets weekly. Members open it to
see upcoming events. ~4 admins add and maintain events. The app sends reminder
notifications before events to members who opt in.

## 2. Goals

- Feels like an app: installed icon, fullscreen, no browser chrome.
- Shared by a single link — no account to view.
- Works on Windows, Android, iPhone, Mac.
- Month-grid view (Apple Calendar style) with category filter toggles.
- Recurring events plus one-offs.
- Per-event reminder notifications, opt-in/out per device.
- ~$0/month.

## 3. Non-goals (v1)

- No member accounts, RSVPs, or per-person calendars.
- No comments, chat, attachments.
- No native App Store build.
- No real-time multi-admin editing (admin edits are infrequent; a reload gets latest).
- No per-user timezones — one fixed group timezone.

## 4. Users & roles

| Role | Auth | Can |
|---|---|---|
| Member | none (anonymous session created only if they opt into reminders) | View, filter, toggle reminders on their device |
| Admin | Supabase magic-link email, and on the `admins` table | + create/edit/delete events & categories, cancel single occurrences |

Admin list lives in the `admins` table, editable without a code change. RLS is the
real enforcement; `ADMIN_EMAILS` in `config.js` only controls what the UI offers.

## 5. Architecture

```
   PWA (static, GitHub Pages)                 Supabase
   ┌───────────────────────────┐   HTTPS      ┌──────────────────────────────┐
   │ index.html / app.js       │ ───────────▶ │ Postgres: events, categories,│
   │ month grid, dialogs       │ ◀─────────── │   reminders, exceptions,     │
   │ service worker (offline+  │              │   push_subscriptions, log,   │
   │   push)                   │              │   admins                     │
   │ Supabase JS (esm.sh CDN)  │              │ Auth: magic link + anon      │
   └───────────────────────────┘              │ RLS on every table           │
                                              └──────────────────────────────┘
   GitHub Actions (cron */15)                         ▲
   ┌───────────────────────────┐  service role key    │
   │ scripts/send-reminders.mjs │ ─────────────────────┘
   │ expand recurrence, match   │      Web Push (VAPID)
   │ due reminders, send,       │ ───────────────────────▶ browser push services
   │ dedupe via notification_log│                          (Apple / Mozilla / Google)
   └───────────────────────────┘
```

- Frontend imports `@supabase/supabase-js` and `rrule` from `esm.sh` at runtime —
  no bundler. The service worker precaches the shell so it opens offline (data
  still needs network).
- The reminder job is plain Node, uses the **service role key** (bypasses RLS),
  and is safe to run repeatedly — `notification_log` has a unique constraint on
  `(event_id, occurrence_date, reminder_offset_minutes)`.

## 6. Data model

| Table | Purpose | Notes |
|---|---|---|
| `categories` | label + color, admin-editable | filter toggles are client-side |
| `events` | one row per one-off **or** recurring series | `rrule` is an iCal RRULE body without DTSTART (e.g. `FREQ=WEEKLY;INTERVAL=1`); null = one-off. `recurrence_end` optional date cap. |
| `event_reminders` | offsets in minutes before start | replaced wholesale on save |
| `event_exceptions` | per-occurrence overrides | v1 writes `status='cancelled'` only; `modified` columns exist for a future "edit one occurrence" |
| `push_subscriptions` | one row per opted-in device | `user_id` = anon auth uid; device manages only its own row |
| `notification_log` | dedupe ledger for the sender | no client access at all |
| `admins` | allowlisted emails | readable/writable only by admins |

Times are stored as `timestamptz` (UTC instants). The app treats them as
wall-clock time in `GROUP_TIMEZONE` for all display and entry (`lib/tz.js`).

## 7. Security model

- Anon key ships in the client (by design). RLS is the protection.
- Public `SELECT` on `categories`, `events`, `event_reminders`, `event_exceptions`.
- All writes to those tables require `is_admin()` (email in `admins`).
  `is_admin()` is `SECURITY DEFINER` so it can read `admins` without recursion.
- `push_subscriptions`: a row is insert/select/update/delete-able only by the
  session whose `auth.uid()` matches `user_id`. That's why opting into reminders
  triggers an anonymous sign-in.
- `notification_log`: no policies → invisible to clients; only the service role
  (reminder job) touches it.

## 8. Locked decisions (and how to revisit)

| # | Decision | Why | Revisit by |
|---|---|---|---|
| 1 | **Scheduler = GitHub Actions cron** (`*/15`) | No extra tooling; user knows GitHub; fully in-repo | Move to a Supabase scheduled Edge Function for tighter timing / no dormancy rule |
| 2 | **Anonymous Supabase session** for push subscribers | Clean per-device ownership of the subscription row, no login UI | — |
| 3 | **Recurrence editing = cancel-occurrence only** | "Edit just this one" needs override UI + merge logic | Fill in `event_exceptions` `modified` path + editor |
| 4 | Optional `url` field on events | Cheap, useful for call links | — |
| 5 | **One fixed `GROUP_TIMEZONE`** in config | Group is co-located; per-user tz is a large scope jump | Store tz per event + convert per viewer |
| 6 | Categories seeded but **admin-editable in-app** | Group can tune labels themselves | — |
| 7 | **Full month navigation**, past included | Simpler than gating history | Add a "jump to date" / list view later |
| 8 | Default reminders **1 day + 1 hour** before | Sensible for a weekly meeting | Per-admin preference |
| 9 | Push copy = title + date/time + location, deep-links to `?event=<id>` | Enough to act on | Richer payload / actions |

## 9. Known limitations (v1)

- **iOS push**: only works if the PWA is added to the Home Screen and the user
  grants permission (iOS 16.4+). Delivery is best-effort, not guaranteed/instant.
- **Reminder precision ≈ ±15 min** — cron granularity. The sender also has a
  90-minute look-back so a skipped run still fires (late), deduped by the log.
- **DST drift**: a recurring series is expanded from a stored UTC instant, so an
  occurrence can land an hour off across a daylight-saving boundary. Acceptable
  for a group calendar; an admin can adjust the series. Proper fix: store local
  wall time + expand in `GROUP_TIMEZONE`.
- **No delete-safety for categories**: deleting a category just nulls the label on
  its events (FK `on delete set null`).
- **esm.sh dependency**: first load needs network to fetch the two CDN modules;
  after that the service worker serves the app shell offline (not the CDN modules).
- **Concurrent admin edits**: last write wins; no locking.

## 10. Build sequence (status)

1. ✅ Supabase schema + RLS + seed SQL.
2. ✅ PWA shell: manifest, service worker, installable, icons.
3. ✅ Read path: fetch events, expand recurrence, month grid + category toggles.
4. ✅ Admin auth + event/category CRUD (recurrence builder, per-event reminders).
5. ✅ Push subscribe/unsubscribe + storage.
6. ✅ Reminder job: send + dedupe + dead-subscription pruning + workflows.
7. ⬜ Polish pass after the visual design (Claude Design) lands: empty states,
   install prompt, richer day view, "jump to date".
