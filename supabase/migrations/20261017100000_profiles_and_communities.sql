-- Profiles and server-side community creation.
--
-- HOW TO RUN: `supabase db push` (or scripts/verify-migrations.ps1 against a
-- throwaway Postgres). Safe to re-run: every statement is idempotent.
--
-- Trust model:
--   * A user's profile (name, phone, photo, preferred locale & theme) lives in
--     public.profiles with RLS enabled.
--   * A user can only insert or update their own profile (id = auth.uid()).
--   * A user can read their own profile, or the profile of any member in a group
--     they belong to (via active membership in ledger_group_memberships).
--   * Avatars live in the public `avatars` bucket under `<user_id>/...`.
--     Only the user (auth.uid()) can upload, overwrite or delete their avatar.
--   * Community creation is atomic: sened_community_create_v1 provisions the group,
--     assigns the creator as active owner, seeds the 4 standard chart accounts
--     (POT_CASH, CONTRIBUTION_INCOME, PAYOUT_EXPENSE, EQUITY_OPENING), and generates
--     an initial 7-day invite link in a single transaction.

-- ---------------------------------------------------------------------------
-- 1. profiles table
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 120),
  phone text not null default '' check (char_length(phone) <= 30),
  photo text check (photo is null or char_length(photo) <= 2000),
  preferred_locale text not null default 'am' check (preferred_locale in ('am', 'en', 'om')),
  preferred_theme text not null default 'system' check (preferred_theme in ('system', 'light', 'dark')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.profiles enable row level security;

-- Updated at trigger
create or replace function public.sened_set_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.sened_set_profiles_updated_at();

-- Helper function to check if caller can read a profile (security definer
-- to avoid RLS re-entry on ledger_group_memberships where members only read own rows)
create or replace function public.sened_profile_can_read(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and (
      target_user_id = auth.uid()
      or exists (
        select 1
        from public.ledger_group_memberships m1
        join public.ledger_group_memberships m2
          on m1.group_id = m2.group_id
         and m1.tenant_id = m2.tenant_id
        where m1.user_id = auth.uid()
          and m2.user_id = target_user_id
          and m1.status = 'active'
          and m2.status = 'active'
      )
    );
$$;

revoke all on function public.sened_profile_can_read(uuid) from public, anon;
grant execute on function public.sened_profile_can_read(uuid) to authenticated, service_role;

-- RLS: Read own profile or peer profile in shared active groups
drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read"
on public.profiles
for select
to authenticated
using (public.sened_profile_can_read(id));

-- RLS: Insert own profile
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

-- RLS: Update own profile
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

revoke all on table public.profiles from anon, public;
grant select, insert, update on table public.profiles to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Profile auto-creation on auth.users insert
-- ---------------------------------------------------------------------------
create or replace function public.sened_handle_user_created_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  user_json jsonb := to_jsonb(new);
  initial_name text;
  initial_phone text;
begin
  initial_name := coalesce(
    nullif(btrim(user_json->'raw_user_meta_data'->>'name'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  );
  initial_phone := coalesce(
    nullif(btrim(user_json->'raw_user_meta_data'->>'phone'), ''),
    ''
  );

  insert into public.profiles (id, name, phone)
  values (new.id, initial_name, initial_phone)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row
execute function public.sened_handle_user_created_v1();

-- ---------------------------------------------------------------------------
-- 3. Profile upsert RPC (convenience for callers under auth.uid())
-- ---------------------------------------------------------------------------
create or replace function public.sened_profile_upsert_v1(
  requested_name text,
  requested_phone text,
  requested_photo text default null,
  requested_locale text default 'am',
  requested_theme text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sanitized_name text;
  sanitized_phone text;
  sanitized_photo text;
  sanitized_locale text;
  sanitized_theme text;
  profile_row record;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'profile_unauthorized';
  end if;

  sanitized_name := btrim(coalesce(requested_name, ''));
  if char_length(sanitized_name) > 120 then
    raise exception using errcode = '22023', message = 'profile_invalid_name';
  end if;

  sanitized_phone := btrim(coalesce(requested_phone, ''));
  if char_length(sanitized_phone) > 30 then
    raise exception using errcode = '22023', message = 'profile_invalid_phone';
  end if;

  sanitized_photo := nullif(btrim(coalesce(requested_photo, '')), '');
  if sanitized_photo is not null and char_length(sanitized_photo) > 2000 then
    raise exception using errcode = '22023', message = 'profile_invalid_photo';
  end if;

  sanitized_locale := coalesce(nullif(btrim(requested_locale), ''), 'am');
  if sanitized_locale not in ('am', 'en', 'om') then
    sanitized_locale := 'am';
  end if;

  sanitized_theme := coalesce(nullif(btrim(requested_theme), ''), 'system');
  if sanitized_theme not in ('system', 'light', 'dark') then
    sanitized_theme := 'system';
  end if;

  insert into public.profiles (id, name, phone, photo, preferred_locale, preferred_theme)
  values (actor, sanitized_name, sanitized_phone, sanitized_photo, sanitized_locale, sanitized_theme)
  on conflict (id) do update set
    name = excluded.name,
    phone = excluded.phone,
    photo = coalesce(excluded.photo, public.profiles.photo),
    preferred_locale = excluded.preferred_locale,
    preferred_theme = excluded.preferred_theme,
    updated_at = clock_timestamp()
  returning * into profile_row;

  return jsonb_build_object(
    'id', profile_row.id,
    'name', profile_row.name,
    'phone', profile_row.phone,
    'photo', profile_row.photo,
    'preferredLocale', profile_row.preferred_locale,
    'preferredTheme', profile_row.preferred_theme,
    'createdAt', profile_row.created_at,
    'updatedAt', profile_row.updated_at
  );
end;
$$;

revoke all on function public.sened_profile_upsert_v1(text, text, text, text, text) from public, anon;
grant execute on function public.sened_profile_upsert_v1(text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Storage bucket: avatars
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
on storage.objects
for select
to authenticated, anon
using (bucket_id = 'avatars');

drop policy if exists "avatars_owner_insert" on storage.objects;
create policy "avatars_owner_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "avatars_owner_update" on storage.objects;
create policy "avatars_owner_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "avatars_owner_delete" on storage.objects;
create policy "avatars_owner_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ---------------------------------------------------------------------------
-- 5. ledger_groups columns for community parameters
-- ---------------------------------------------------------------------------
alter table public.ledger_groups
  add column if not exists kind text default 'equb' check (kind in ('equb', 'iddir')),
  add column if not exists contribution_amount numeric(14, 2) default 5000 check (contribution_amount > 0),
  add column if not exists frequency text default 'monthly' check (frequency in ('monthly', 'weekly')),
  add column if not exists target_members integer default 8 check (target_members between 2 and 50);

-- ---------------------------------------------------------------------------
-- 6. Community creation RPC: sened_community_create_v1
-- ---------------------------------------------------------------------------
create or replace function public.sened_community_create_v1(
  requested_name text,
  requested_kind text default 'equb',
  requested_amount numeric default 5000,
  requested_frequency text default 'monthly',
  requested_target_members integer default 8
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor uuid := auth.uid();
  new_group_id uuid;
  new_tenant_id uuid;
  sanitized_name text;
  sanitized_kind text;
  sanitized_amount numeric(14, 2);
  sanitized_frequency text;
  sanitized_members integer;
  account_row record;
  invite_res jsonb;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  sanitized_name := btrim(coalesce(requested_name, ''));
  if char_length(sanitized_name) < 1 or char_length(sanitized_name) > 120 then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  sanitized_kind := coalesce(nullif(btrim(requested_kind), ''), 'equb');
  if sanitized_kind not in ('equb', 'iddir') then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  sanitized_amount := coalesce(requested_amount, 5000);
  if sanitized_amount <= 0 or sanitized_amount > 10000000 then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  sanitized_frequency := coalesce(nullif(btrim(requested_frequency), ''), 'monthly');
  if sanitized_frequency not in ('monthly', 'weekly') then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  sanitized_members := coalesce(requested_target_members, 8);
  if sanitized_members < 2 or sanitized_members > 50 then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  new_tenant_id := actor;
  new_group_id := gen_random_uuid();

  insert into public.ledger_groups (
    id, tenant_id, name, currency, created_by, kind, contribution_amount, frequency, target_members
  )
  values (
    new_group_id, new_tenant_id, sanitized_name, 'ETB', actor, sanitized_kind, sanitized_amount, sanitized_frequency, sanitized_members
  );

  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status)
  values (new_group_id, new_tenant_id, actor, 'owner', 'active')
  on conflict (group_id, user_id) do nothing;

  -- Seed the standard chart of accounts
  for account_row in
    select *
    from (
      values
        ('POT_CASH', 'የእቁብ ጥሬ ሂሳብ', 'asset'),
        ('CONTRIBUTION_INCOME', 'የስጠታ ገቢ', 'income'),
        ('PAYOUT_EXPENSE', 'የእጣ ክፍያ ወጪ', 'expense'),
        ('EQUITY_OPENING', 'የመክፈት ቀድሞ ሂሳብ', 'equity')
    ) as standard(code, name, account_type)
  loop
    insert into public.ledger_accounts (group_id, tenant_id, code, name, account_type)
    values (new_group_id, new_tenant_id, account_row.code, account_row.name, account_row.account_type)
    on conflict (group_id, code) do nothing;
  end loop;

  -- Create initial group invite (7 days expiry, sanitized_members uses)
  invite_res := public.create_group_invite_v1(new_group_id, 168, sanitized_members);

  return jsonb_build_object(
    'groupId', new_group_id,
    'tenantId', new_tenant_id,
    'name', sanitized_name,
    'kind', sanitized_kind,
    'amount', sanitized_amount,
    'frequency', sanitized_frequency,
    'members', sanitized_members,
    'role', 'owner',
    'invite', invite_res
  );
end;
$$;

revoke all on function public.sened_community_create_v1(text, text, numeric, text, integer) from public, anon;
grant execute on function public.sened_community_create_v1(text, text, numeric, text, integer) to authenticated;
