-- Minimal Supabase `auth` stub.
--
-- The Sened migrations reference auth.users, auth.uid(), auth.jwt() and
-- auth.role(), all of which exist in a real Supabase project. This file
-- provides just enough of them to apply the migrations to a stock Postgres
-- container, so the SQL can be executed and verified outside Supabase.
--
-- Applied by scripts/verify-migrations.ps1 BEFORE any project migration,
-- because ledger_core.sql uses auth.uid() as a column default.

create schema if not exists auth;

-- Supabase provisions these roles; the migrations grant and revoke against them.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Supabase populates request.jwt.claim.sub from the bearer token.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '')
$$;

-- Minimal Supabase Storage and Realtime stubs, so the chat migration's storage
-- policies and publication membership are executed rather than skipped.
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert on storage.objects to authenticated;

create or replace function storage.foldername(name text) returns text[]
language sql immutable
as $$
  select case when array_length(string_to_array(name, '/'), 1) > 1
    then (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
    else array[]::text[] end
$$;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;
