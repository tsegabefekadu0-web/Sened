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
