-- Supabase-provided objects, stubbed so migrations can be validated against a
-- PLAIN local Postgres before they are run against the real project:
--
--   createdb bbs_sqlcheck
--   psql bbs_sqlcheck -v ON_ERROR_STOP=1 -f supabase/local-stubs.sql
--   psql bbs_sqlcheck -v ON_ERROR_STOP=1 -f supabase/migrations/0001_bbs_platform.sql
--
-- These are NOT part of the real schema — Supabase provides all of them.

create schema if not exists auth;
create schema if not exists storage;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text, phone text, raw_user_meta_data jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table if not exists storage.buckets (id text primary key, name text, public boolean);
create table if not exists storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
