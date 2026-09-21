// Paste your Supabase project's URL and anon (public) key here (Supabase
// dashboard > Project Settings > API).
//
// The anon key is meant to be public - it identifies your project, it is
// not a secret, and it's safe to commit to the repo. Security comes from
// the Row Level Security policies in supabase-setup.sql, not from hiding
// this file. Never put your "service_role" key here - that one IS secret
// and must never go in client-side code.
//
// Until these are filled in, the site runs in guest-only mode (bets/unit
// size stay in this browser's localStorage, same as before accounts
// existed) - nothing breaks, sign in/up just stays unavailable.
export const supabaseConfig = {
  url: "https://kubjcoaorbypiyulgiwy.supabase.co",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1Ympjb2FvcmJ5cGl5dWxnaXd5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwMjk1NzgsImV4cCI6MjEwNTYwNTU3OH0.e3uJMDo-L5139cK1BzmRH0N72hdrkY6tKIKD_eHKaSk",
};
