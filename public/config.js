// ---------------------------------------------------------------------------
// Group Calendar configuration.
// Everything in here is safe to commit and ship to the browser.
// Fill in the four TODO values, commit, and the app + reminder job both use them.
// ---------------------------------------------------------------------------

// Supabase project URL, e.g. "https://abcdefgh.supabase.co"
// Supabase dashboard > Project Settings > API > Project URL
export const SUPABASE_URL = "TODO_SUPABASE_URL";

// Supabase "anon" public key (NOT the service role key).
// Supabase dashboard > Project Settings > API > Project API keys > anon public
export const SUPABASE_ANON_KEY = "TODO_SUPABASE_ANON_KEY";

// VAPID public key for Web Push. Run `npm run gen:vapid` and paste the
// "Public key" it prints here.
export const VAPID_PUBLIC_KEY = "BL9mYBC_HUQAIIXm-5VdO3hGtFjJFRzWAlyrJrE66fFbfOVyKwjTAp8EjyL0dTxbr8m0nJV65a08AUvHPTm1aB0";

// The single timezone the whole group's events are expressed in.
// IANA name, e.g. "America/New_York", "America/Chicago", "Europe/London".
export const GROUP_TIMEZONE = "America/New_York";

// The deployed URL of this app, no trailing slash. Used for notification
// deep links. e.g. "https://yourname.github.io/group-calendar"
export const APP_URL = "TODO_APP_URL";

// Shown in the sign-in dialog as a hint only. The real enforcement is the
// `admins` table + RLS in Supabase - editing this list changes nothing on the
// server.
export const ADMIN_EMAILS = [
  "admin1@example.com",
  "admin2@example.com",
  "admin3@example.com",
  "admin4@example.com",
];

// Reminder offsets (minutes before start) pre-filled on a new event.
export const DEFAULT_REMINDER_OFFSETS = [1440, 60];
