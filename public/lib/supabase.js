import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

if (SUPABASE_URL.startsWith("TODO") || SUPABASE_ANON_KEY.startsWith("TODO")) {
  console.warn(
    "[config] Supabase URL / anon key are still placeholders. Edit public/config.js."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
