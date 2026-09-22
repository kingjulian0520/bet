-- Run this once in the Supabase SQL editor, same way as supabase-setup.sql.
-- Adds profile picture support: a public "avatars" storage bucket (2MB
-- limit, images only), policies so everyone can view avatars but each
-- user can only upload/replace/delete their own, and the column on
-- profiles that stores the current avatar's URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Avatars are stored at "<user id>/avatar" - the folder-name check below is
-- the standard Supabase pattern for "only the owner of this uid folder can
-- write here".
create policy "avatar images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "users can upload their own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "users can replace their own avatar"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "users can delete their own avatar"
  on storage.objects for delete
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

alter table public.profiles add column if not exists avatar_url text;
