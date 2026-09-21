-- Run this once in the Supabase dashboard: SQL Editor > New query > paste
-- all of this > Run. Sets up everything accounts need: the username
-- claims table, the profiles table (bets/unit size/public toggle), Row
-- Level Security policies, and a trigger that creates a user's username +
-- profile row atomically when they sign up.
--
-- The atomic-trigger part matters: if the requested username is already
-- taken, the trigger raises an exception, which rolls back the ENTIRE
-- signup transaction (including the new row in Supabase's own auth.users
-- table) - so a rejected username can never leave a half-created,
-- orphaned account behind.

-- ---------- username claims (public read, trigger-only write) ----------

create table if not exists public.usernames (
  username_lower text primary key,
  user_id uuid not null references auth.users(id) on delete cascade
);

alter table public.usernames enable row level security;

-- Public read so the sign-up form can check availability before
-- submitting. No sensitive data here - just which names are taken.
create policy "usernames are publicly readable"
  on public.usernames for select
  using (true);

-- No insert/update/delete policy for the client roles (anon/authenticated)
-- on purpose - only the SECURITY DEFINER trigger below can write here.

-- ---------- profiles (bets, unit size, public/private toggle) ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  is_public boolean not null default false,
  unit_value numeric,
  bets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Owner can always read their own profile; anyone can read it ONLY once
-- the owner has flipped is_public to true. Email lives in Supabase's own
-- auth.users table (not exposed here), so it's never affected by this
-- toggle either way.
create policy "profiles readable by owner or if public"
  on public.profiles for select
  using (auth.uid() = id or is_public = true);

create policy "profiles updatable by owner"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No insert policy for the client roles - only the trigger below creates
-- profile rows, at signup time.

-- ---------- signup trigger: claim username + create profile ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_username text := new.raw_user_meta_data->>'username';
  lower_username text := lower(requested_username);
begin
  if requested_username is null or requested_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'Invalid username';
  end if;

  insert into public.usernames (username_lower, user_id) values (lower_username, new.id);
  insert into public.profiles (id, username) values (new.id, requested_username);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
