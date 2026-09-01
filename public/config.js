// ---------------------------------------------------------------------------
// Group Calendar configuration.
// Everything in here is safe to commit and ship to the browser.
// Fill in the four TODO values, commit, and the app + reminder job both use them.
// ---------------------------------------------------------------------------

// Supabase project URL, e.g. "https://abcdefgh.supabase.co"
// Supabase dashboard > Project Settings > API > Project URL
export const SUPABASE_URL = "https://lrsekqkvxrxxotpxdaym.supabase.co";

// Supabase "anon" public key (NOT the service role key).
// Supabase dashboard > Project Settings > API > Project API keys > anon public
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxyc2VrcWt2eHJ4eG90cHhkYXltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODE0OTYsImV4cCI6MjA5OTQ1NzQ5Nn0.dZR3JyYEZJ67meWg-HURWJj68Gx0q4diYNFaouOTkDQ";

// VAPID public key for Web Push. Run `npm run gen:vapid` and paste the
// "Public key" it prints here.
export const VAPID_PUBLIC_KEY = "BGoHxE9HONx-MZE-jnNfNhpO6GpcQScCS9Va5ARZPMQM0L-gyurdWYFg6-WzzRIg5U1jOs6XRCwYJ6Nw5k-Lneg";

// The single timezone the whole group's events are expressed in.
// IANA name, e.g. "America/New_York", "America/Chicago", "Europe/London".
export const GROUP_TIMEZONE = "America/New_York";

// The deployed URL of this app, no trailing slash. Used for notification
// deep links. e.g. "https://bniem-ops.github.io/connection-group-calendar"
export const APP_URL = "https://bniem-ops.github.io/connection-group-calendar";

// Shown in the sign-in dialog as a hint only. The real enforcement is the
// `admins` table + RLS in Supabase - editing this list changes nothing on the
// server.
export const ADMIN_EMAILS = [
  "brentcniemerski@gmail.com",
  "ebniemerski@gmail.com",
];

// Reminder offsets (minutes before start) pre-filled on a new event.
export const DEFAULT_REMINDER_OFFSETS = [1440, 60];
