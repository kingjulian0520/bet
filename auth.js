// Supabase Authentication + per-user profile storage (Postgres via
// supabase-js).
//
// Degrades gracefully in two ways:
//  1. If supabase-config.js still has placeholder values, we never even
//     fetch the Supabase client library - isAccountsReady() resolves
//     false immediately.
//  2. If the Supabase client CDN is unreachable for any reason (offline,
//     blocked, outage), the dynamic import below is wrapped in try/catch
//     so that failure can't break the rest of the site the way a static
//     top-level `import` would - it just means accounts stay unavailable
//     and everything else (picks, bets, localStorage) keeps working
//     exactly as it did before accounts existed.
const SUPABASE_SDK_VERSION = "2";

let supabase = null;
let ready = false;
let initPromise = null;

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const { supabaseConfig } = await import("./supabase-config.js");
        if (
          !supabaseConfig ||
          !supabaseConfig.url ||
          !supabaseConfig.anonKey ||
          supabaseConfig.url.startsWith("REPLACE_") ||
          supabaseConfig.anonKey.startsWith("REPLACE_")
        ) {
          return; // not configured yet - stay in guest mode, no network calls
        }

        const { createClient } = await import(
          `https://esm.sh/@supabase/supabase-js@${SUPABASE_SDK_VERSION}`
        );
        supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
        ready = true;
      } catch (err) {
        console.warn("Supabase unavailable — running in guest (localStorage-only) mode.", err);
      }
    })();
  }
  return initPromise;
}

export async function isAccountsReady() {
  await ensureInit();
  return ready;
}

// callback(user | null) fires once with the current state, then again on
// every sign-in/sign-out.
export async function onAuthChange(callback) {
  await ensureInit();
  if (!ready) {
    callback(null);
    return () => {};
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  callback(session ? session.user : null);

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session ? session.user : null);
  });
  return () => subscription.unsubscribe();
}

function validUsername(username) {
  return /^[A-Za-z0-9_]{3,20}$/.test(String(username || "").trim());
}

export async function signUp(username, email, password) {
  await ensureInit();
  if (!ready) throw new Error("Accounts aren't set up yet.");
  const trimmedUsername = String(username || "").trim();
  if (!validUsername(trimmedUsername)) {
    throw new Error("Usernames must be 3-20 characters: letters, numbers, underscore only.");
  }

  const { data: existing } = await supabase
    .from("usernames")
    .select("username_lower")
    .eq("username_lower", trimmedUsername.toLowerCase())
    .maybeSingle();
  if (existing) throw new Error("That username is already taken.");

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username: trimmedUsername } },
  });
  if (error) {
    // The signup trigger enforces uniqueness too (belt-and-suspenders
    // against a race with the pre-check above) - surface that plainly.
    if (/username/i.test(error.message)) throw new Error("That username is already taken.");
    throw error;
  }

  return { user: data.user, needsEmailConfirmation: !data.session };
}

export async function signIn(email, password) {
  await ensureInit();
  if (!ready) throw new Error("Accounts aren't set up yet.");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOutUser() {
  await ensureInit();
  if (!ready) return;
  await supabase.auth.signOut();
}

export async function getMyProfile(uid) {
  await ensureInit();
  if (!ready) return null;
  const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
  if (error || !data) return null;
  return {
    username: data.username,
    isPublic: data.is_public,
    unitValue: data.unit_value,
    bets: data.bets || [],
  };
}

export async function saveMyProfile(uid, partial) {
  await ensureInit();
  if (!ready) return;
  const columns = { updated_at: new Date().toISOString() };
  if ("unitValue" in partial) columns.unit_value = partial.unitValue;
  if ("bets" in partial) columns.bets = partial.bets;
  if ("isPublic" in partial) columns.is_public = partial.isPublic;
  const { error } = await supabase.from("profiles").update(columns).eq("id", uid);
  if (error) throw error;
}

// Ranks everyone who has opted their profile public (RLS only returns rows
// where is_public = true to a non-owner) by net settled units.
export async function getPublicLeaderboard() {
  await ensureInit();
  if (!ready) return [];
  const { data, error } = await supabase.from("profiles").select("username, bets").eq("is_public", true);
  if (error || !data) return [];

  return data
    .map((row) => {
      const bets = Array.isArray(row.bets) ? row.bets : [];
      const netUnits = bets
        .filter((b) => b.status && b.status !== "pending")
        .reduce((sum, b) => sum + (b.profitUnits || 0), 0);
      return { username: row.username, netUnits };
    })
    .sort((a, b) => b.netUnits - a.netUnits);
}
