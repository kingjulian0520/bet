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
  url: "REPLACE_WITH_YOUR_PROJECT_URL",
  anonKey: "REPLACE_WITH_YOUR_ANON_KEY",
};
