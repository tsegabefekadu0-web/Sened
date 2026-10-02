-- Invite links: the only way a person becomes a member of a group.
--
-- Until now `sened_ledger_provision_group_v1` made the creator the owner and
-- `sened_ledger_set_member_role_v1` could promote an *existing* member, but
-- nothing could add one. This adds an owner-created, expiring, use-limited,
-- revocable invite.
--
-- Token handling. The raw token is 32 random bytes (hex, 64 chars) generated in
-- the database by `create_group_invite_v1` and returned exactly once, in that
-- function's result. Only its SHA-256 is stored (`token_hash`); the raw value is
-- never written to a table, a log line or a list result. The hash column is not
-- even granted to `authenticated` for direct selects.
--
-- Error contract (message, SQLSTATE):
--   ledger_forbidden           42501  no session, or caller lacks the role
--   ledger_group_not_found     P0002  no such group
--   ledger_invalid_request     22023  bad expiry / max_uses
--   ledger_invite_invalid      P0002  no invite matches the token / id
--   ledger_invite_expired      P0001
--   ledger_invite_revoked      P0001
--   ledger_invite_exhausted    P0001  max_uses reached

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ledger_group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  tenant_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '7 days'),
  max_uses integer not null default 1 check (max_uses between 1 and 50),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  revoked_at timestamptz,
  constraint ledger_invites_expiry_window
    check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint ledger_invites_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict
);

create index if not exists ledger_invites_group_idx
  on public.ledger_group_invites (group_id, created_at desc);

alter table public.ledger_group_invites enable row level security;

drop policy if exists "group owners read invites" on public.ledger_group_invites;
create policy "group owners read invites"
on public.ledger_group_invites
for select
to authenticated
using (
  exists (
    select 1
    from public.ledger_group_memberships membership
    where membership.group_id = ledger_group_invites.group_id
      and membership.tenant_id = ledger_group_invites.tenant_id
      and membership.user_id = auth.uid()
      and membership.role = 'owner'
      and membership.status = 'active'
  )
);

revoke all on table public.ledger_group_invites from anon, authenticated;
grant select (id, group_id, tenant_id, created_by, created_at, expires_at, max_uses, use_count, revoked_at)
  on table public.ledger_group_invites to authenticated;

-- create ----------------------------------------------------------------------

create or replace function public.create_group_invite_v1(
  requested_group_id uuid,
  expires_in_hours integer default 168,
  requested_max_uses integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
  raw_token text;
  new_id uuid;
  new_expires timestamptz;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  expires_in_hours := coalesce(expires_in_hours, 168);
  requested_max_uses := coalesce(requested_max_uses, 1);
  if requested_group_id is null
    or expires_in_hours < 1 or expires_in_hours > 720
    or requested_max_uses < 1 or requested_max_uses > 50 then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  select group_row.tenant_id into tenant
  from public.ledger_groups group_row
  where group_row.id = requested_group_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_group_not_found';
  end if;

  if not exists (
    select 1 from public.ledger_group_memberships caller
    where caller.group_id = requested_group_id
      and caller.tenant_id = tenant
      and caller.user_id = actor
      and caller.role = 'owner'
      and caller.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');
  new_expires := clock_timestamp() + make_interval(hours => expires_in_hours);

  insert into public.ledger_group_invites (
    group_id, tenant_id, token_hash, created_by, expires_at, max_uses
  ) values (
    requested_group_id, tenant,
    encode(sha256(convert_to(raw_token, 'UTF8')), 'hex'),
    actor, new_expires, requested_max_uses
  )
  returning id into new_id;

  return jsonb_build_object(
    'inviteId', new_id,
    'groupId', requested_group_id,
    'token', raw_token,
    'expiresAt', new_expires,
    'maxUses', requested_max_uses
  );
end;
$$;

comment on function public.create_group_invite_v1(uuid, integer, integer) is
  'Owner-only. Generates a random invite token, stores only its SHA-256, and returns the raw token once.';

-- redeem ----------------------------------------------------------------------

create or replace function public.redeem_group_invite_v1(requested_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
declare
  actor uuid := auth.uid();
  invite public.ledger_group_invites%rowtype;
  existing public.ledger_group_memberships%rowtype;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  if requested_token is null
    or char_length(requested_token) < 16
    or char_length(requested_token) > 256 then
    raise exception using errcode = 'P0002', message = 'ledger_invite_invalid';
  end if;

  -- Lock the invite so concurrent redemptions cannot exceed max_uses.
  select invite_row.* into invite
  from public.ledger_group_invites invite_row
  where invite_row.token_hash = encode(sha256(convert_to(requested_token, 'UTF8')), 'hex')
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_invite_invalid';
  end if;

  select membership.* into existing
  from public.ledger_group_memberships membership
  where membership.group_id = invite.group_id and membership.user_id = actor
  for update;

  -- Already an active member: nothing changes and no use is counted. This runs
  -- before the expiry checks so a member re-opening an old link is told the
  -- truth, and it never touches an owner's or treasurer's role.
  if found and existing.status = 'active' then
    return jsonb_build_object(
      'status', 'already_member',
      'groupId', invite.group_id,
      'role', existing.role
    );
  end if;

  if invite.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'ledger_invite_revoked';
  end if;
  if invite.expires_at <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'ledger_invite_expired';
  end if;
  if invite.use_count >= invite.max_uses then
    raise exception using errcode = 'P0001', message = 'ledger_invite_exhausted';
  end if;

  if found then
    -- A deactivated member rejoining comes back as a plain member, whatever
    -- role they held, so an invite can never restore privilege.
    update public.ledger_group_memberships membership
    set status = 'active', role = 'member'
    where membership.group_id = invite.group_id and membership.user_id = actor;
  else
    insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status)
    values (invite.group_id, invite.tenant_id, actor, 'member', 'active');
  end if;

  update public.ledger_group_invites invite_row
  set use_count = invite_row.use_count + 1
  where invite_row.id = invite.id;

  return jsonb_build_object('status', 'joined', 'groupId', invite.group_id, 'role', 'member');
end;
$$;

comment on function public.redeem_group_invite_v1(text) is
  'Adds the caller to the invite group as a member. Idempotent for active members; never changes an owner or treasurer.';

-- revoke ----------------------------------------------------------------------

create or replace function public.revoke_group_invite_v1(requested_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
declare
  actor uuid := auth.uid();
  invite public.ledger_group_invites%rowtype;
  did_change boolean := false;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if requested_invite_id is null then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  select invite_row.* into invite
  from public.ledger_group_invites invite_row
  where invite_row.id = requested_invite_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_invite_invalid';
  end if;

  if not exists (
    select 1 from public.ledger_group_memberships caller
    where caller.group_id = invite.group_id
      and caller.tenant_id = invite.tenant_id
      and caller.user_id = actor
      and caller.role = 'owner'
      and caller.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  if invite.revoked_at is null then
    update public.ledger_group_invites invite_row
    set revoked_at = clock_timestamp()
    where invite_row.id = invite.id;
    did_change := true;
  end if;

  return jsonb_build_object('inviteId', invite.id, 'revoked', true, 'changed', did_change);
end;
$$;

comment on function public.revoke_group_invite_v1(uuid) is
  'Owner-only. Revokes an invite. Idempotent.';

-- list members ----------------------------------------------------------------
-- Email is returned ONLY to the group owner (who needs it to tell people apart
-- when managing roles). Everyone else gets null: members have not agreed to
-- show their login address to each other.

create or replace function public.list_group_members_v1(requested_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor uuid := auth.uid();
  caller_role text;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if requested_group_id is null then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  select caller.role into caller_role
  from public.ledger_group_memberships caller
  where caller.group_id = requested_group_id
    and caller.user_id = actor
    and caller.status = 'active';

  -- Outsiders get the same answer whether or not the group exists.
  if caller_role is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'userId', membership.user_id,
        'role', membership.role,
        'joinedAt', membership.created_at,
        'email', case when caller_role = 'owner' then member_user.email else null end
      )
      order by membership.created_at, membership.user_id
    )
    from public.ledger_group_memberships membership
    left join auth.users member_user on member_user.id = membership.user_id
    where membership.group_id = requested_group_id
      and membership.status = 'active'
  ), '[]'::jsonb);
end;
$$;

comment on function public.list_group_members_v1(uuid) is
  'Active members of a group, for any active member. Email is included only for the owner.';

-- list invites ----------------------------------------------------------------

create or replace function public.list_group_invites_v1(requested_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if requested_group_id is null then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  if not exists (
    select 1 from public.ledger_group_memberships caller
    where caller.group_id = requested_group_id
      and caller.user_id = actor
      and caller.role = 'owner'
      and caller.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'inviteId', invite.id,
        'createdAt', invite.created_at,
        'expiresAt', invite.expires_at,
        'maxUses', invite.max_uses,
        'useCount', invite.use_count,
        'revokedAt', invite.revoked_at,
        'status', case
          when invite.revoked_at is not null then 'revoked'
          when invite.expires_at <= clock_timestamp() then 'expired'
          when invite.use_count >= invite.max_uses then 'used_up'
          else 'active' end
      )
      order by invite.created_at desc, invite.id
    )
    from public.ledger_group_invites invite
    where invite.group_id = requested_group_id
  ), '[]'::jsonb);
end;
$$;

comment on function public.list_group_invites_v1(uuid) is
  'Owner-only. Invites for a group with status and use counts. Never includes a token or its hash.';

-- grants ----------------------------------------------------------------------

revoke all on function public.create_group_invite_v1(uuid, integer, integer) from public, anon;
revoke all on function public.redeem_group_invite_v1(text) from public, anon;
revoke all on function public.revoke_group_invite_v1(uuid) from public, anon;
revoke all on function public.list_group_members_v1(uuid) from public, anon;
revoke all on function public.list_group_invites_v1(uuid) from public, anon;
grant execute on function public.create_group_invite_v1(uuid, integer, integer) to authenticated;
grant execute on function public.redeem_group_invite_v1(text) to authenticated;
grant execute on function public.revoke_group_invite_v1(uuid) to authenticated;
grant execute on function public.list_group_members_v1(uuid) to authenticated;
grant execute on function public.list_group_invites_v1(uuid) to authenticated;
