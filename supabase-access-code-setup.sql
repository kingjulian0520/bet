-- Run this once in the Supabase SQL editor, same way as the other
-- supabase-*-setup.sql files. Adds the daily passcode gate for
-- Picks + Long Shots.
--
-- access_control holds today's code but is NEVER readable or writable from
-- the browser (no RLS policies granted to anon/authenticated at all, and
-- RLS defaults to deny-everything once enabled). You rotate the code by
-- editing it directly in the Supabase dashboard's Table Editor, which uses
-- your own dashboard session and bypasses RLS - no code deploy needed.
--
-- The site checks a typed code through verify_access_code(), a function
-- that runs server-side and returns only true/false - the real code is
-- never sent to the browser, even to someone reading network requests.

create table if not exists public.access_control (
  id int primary key default 1,
  code text not null,
  updated_at timestamptz not null default now()
);

insert into public.access_control (id, code) values (1, 'CHANGE_ME')
on conflict (id) do nothing;

alter table public.access_control enable row level security;
-- Intentionally no policies - the table is unreachable from the client.

create or replace function public.verify_access_code(input_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  stored text;
begin
  select code into stored from public.access_control where id = 1;
  return stored is not null and stored = input_code;
end;
$$;

revoke all on function public.verify_access_code(text) from public;
grant execute on function public.verify_access_code(text) to authenticated;
