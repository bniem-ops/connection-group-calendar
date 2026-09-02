# Group Calendar

An installable shared calendar (PWA) for a small group. Members open it to see
what's coming up; a few admins add and edit events; anyone can opt in to push
reminders before events.

- **Frontend:** plain HTML/CSS/JS in `public/`, no build step. Deployed to GitHub Pages.
- **Backend:** Supabase (Postgres + Auth + Row Level Security).
- **Reminders:** standard Web Push, sent by a GitHub Actions cron job (`scripts/send-reminders.mjs`).

No app store, no Firebase, no server to run. Target cost: $0.

---

## What's already done

- Full frontend: month grid, category filter toggles, event detail, admin sign-in,
  event editor with recurrence + per-event reminders, category manager, push opt-in/out.
- Service worker: offline shell + push handling.
- Database schema + RLS policies + seed data (`supabase/*.sql`).
- Reminder sender + GitHub Actions workflows (deploy + cron).
- Icons generated (`public/icons/`).
- **VAPID keys generated** — public key is already in `public/config.js`; the
  private key is in `SECRETS.local.txt` (gitignored — keep it safe).

## What you need to do (about 30–40 min)

Work top to bottom. Nothing here needs code changes except editing `public/config.js`.

### 1. Create the Supabase project
1. supabase.com → New project. Pick a region near the group. Save the DB password.
2. Project Settings → API. Copy **Project URL** and the **anon public** key.
3. Authentication → Providers → **enable "Anonymous sign-ins"**.
4. Authentication → URL Configuration → add your future Pages URL (see step 4) and
   `http://localhost:8080` to **Redirect URLs**.

### 2. Run the SQL
Supabase → SQL Editor → New query. Run these files in order (paste contents, Run):
1. `supabase/01_schema.sql`
2. `supabase/02_policies.sql`
3. `supabase/03_seed.sql` — **edit the four admin emails first** (or add real ones
   later with `insert into admins (email) values ('someone@example.com');`).

### 3. Fill in `public/config.js`
Set these four values and save:
- `SUPABASE_URL` — from step 1
- `SUPABASE_ANON_KEY` — from step 1
- `GROUP_TIMEZONE` — e.g. `"America/Chicago"` (all event times are in this zone)
- `APP_URL` — your Pages URL from step 4, no trailing slash

`VAPID_PUBLIC_KEY` and `ADMIN_EMAILS` are already set (adjust the email list to match
what you seeded — it's only a UI hint).

### 4. Put it on GitHub + enable Pages
```
cd group-calendar
git add -A && git commit -m "Configure for my project"
# create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/group-calendar.git
git push -u origin main
```
Then on GitHub: **Settings → Pages → Source: GitHub Actions**. The "Deploy to GitHub
Pages" workflow runs on every push. Your URL will be
`https://<you>.github.io/group-calendar` — put that in `config.js` `APP_URL` and in
Supabase Redirect URLs (steps 1 & 3), commit, push again.

> Free GitHub Pages requires a **public** repo. The code and the Supabase *anon*
> key are safe to be public (RLS protects the data). If you want a private repo,
> deploy `public/` to Cloudflare Pages or Netlify instead — the app doesn't care.

### 5. Add the reminder job secrets
GitHub repo → Settings → Secrets and variables → Actions → New repository secret.
Add three (values are in `SECRETS.local.txt`):
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API → **service_role** key (secret!)
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` — `mailto:youremail@example.com`

The "Send reminders" workflow then runs every 15 minutes. Trigger it once by hand
from the Actions tab to check it's green.

> GitHub disables scheduled workflows after 60 days with no repo commits. A single
> commit resets that, or switch the cron to an external trigger later.

### 6. Try it
- Open your Pages URL. Click **Admin**, enter a seeded admin email, click the link
  in your inbox. Add an event.
- Click **Reminders** to opt in (on iPhone: Share → Add to Home Screen first, open
  from the icon, then opt in).
- Install: browser menu → Install / Add to Home Screen. Share the plain URL with
  the group — they don't sign in.

### 7. (Optional) Push notifications for chat messages
The reminder cron can't do chat (15-min delay). Instead an Edge Function fires on
each new message. One-time setup:

```
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase functions deploy notify-message --no-verify-jwt
npx supabase secrets set \
  VAPID_PUBLIC_KEY=<public>  VAPID_PRIVATE_KEY=<private>  VAPID_SUBJECT=mailto:you@example.com \
  WEBHOOK_SECRET=<random string>  APP_URL=https://bniem-ops.github.io/connection-group-calendar
```
`VAPID_*` are the same values as the reminder job (`SECRETS.local.txt`).
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

Then fill `PROJECT_REF` and the same `WEBHOOK_SECRET` into `supabase/06_chat_push.sql`
and run it (adds the `notify_chat` column + the trigger). Anyone who has tapped
**Reminders** now also gets a push per message; the chat panel has a **Mute chat**
toggle to opt out of just chat.

---

## Local development

```
npm install
npm run serve        # http://localhost:8080  (localhost allows service workers + push)
```
You still need a real Supabase project and a filled-in `config.js`. To test the
reminder sender locally, copy `.env.example` to `.env.local`, fill it, then:
```
node --env-file=.env.local scripts/send-reminders.mjs
```

## Handy commands

| Command | What it does |
|---|---|
| `npm run serve` | Serve `public/` locally |
| `npm run gen:vapid` | Regenerate VAPID keys (writes `SECRETS.local.txt`) |
| `npm run gen:icons` | Rebuild PNG icons from `public/icons/icon.svg` |
| `npm run send:reminders` | Run the reminder job once (needs env vars) |

## Project layout

```
public/                 the app (this is what GitHub Pages serves)
  index.html            markup + dialogs
  app.js                wiring / state
  config.js             <-- the only file you edit to configure
  sw.js                 service worker (offline + push)
  lib/                  supabase, tz, recurrence, events, auth, push, calendar
  icons/
supabase/               SQL to run once, in numeric order
scripts/                node scripts (VAPID, icons, reminder sender, dev server)
.github/workflows/       deploy-pages.yml, reminders.yml
docs/architecture.md     design decisions, data model, known limits
```

## Known limitations (v1)

See `docs/architecture.md` for the full list. The main ones:
- **iPhone push** needs the app added to the Home Screen and permission granted;
  delivery is best-effort.
- **Reminder timing is coarse** (~±15 min) because cron runs every 15 min. Use
  offsets like "1 day" / "1 hour", not "at start".
- **Recurring events can shift by an hour across a daylight-saving change.** An
  admin can nudge the affected series if it matters.
- You can **cancel** a single occurrence of a recurring event ("Skip this date"),
  but not edit just one occurrence — edit the whole series or delete + recreate.
