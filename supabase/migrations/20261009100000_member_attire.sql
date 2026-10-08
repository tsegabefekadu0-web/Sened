-- Member-chosen attire for the avatar on the home feed: none | gabi | netela.
--
-- A display preference a member picks for themselves (Gabi: white cotton shawl,
-- Netela: lighter shawl with a woven border). It is never inferred from a name
-- or anything else, so the default is 'none' and only the member can change it.
--
-- Storage: a column on ledger_group_memberships. A membership is already "this
-- person in this group", the avatar is shown in the context of a group, and no
-- profile table exists, so a new table would add nothing. The preference is
-- therefore per user per group.
--
-- Write: sened_ledger_set_member_attire_v1 changes only the CALLER's own active
-- membership; the identity is auth.uid(), there is no user argument at all, so
-- no one can set another person's attire. An outsider (or a non-member, or an
-- inactive member) gets ledger_forbidden, the same answer whether or not the
-- group exists.
--
-- Read: group members can read each other's value through the existing members
-- read, list_group_members_v1 (same signature, one added key `attire`). It is a
-- display preference, not sensitive; no new broad read, no policy widened.
--
-- Error contract: ledger_forbidden 42501 (no session / not an active member),
-- ledger_invalid_request 22023 (null group or an attire not in the list).

alter table public.ledger_group_memberships
  add column if not exists attire text not null default 'none';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ledger_group_memberships'::regclass
      and conname = 'ledger_memberships_attire_known'
  ) then
    alter table public.ledger_group_memberships
      add constraint ledger_memberships_attire_known
      check (attire in ('none', 'gabi', 'netela'));
  end if;
end
$$;

comment on column public.ledger_group_memberships.attire is
  'Avatar attire the member chose for themselves in this group: none, gabi or netela. Never inferred; default none.';

create or replace function public.sened_ledger_set_member_attire_v1(
  requested_group_id uuid,
  requested_attire text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  previous text;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if requested_group_id is null
    or requested_attire is null
    or requested_attire not in ('none', 'gabi', 'netela') then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  -- The caller's own active membership only. Lock it so two taps serialise.
  select membership.attire
  into previous
  from public.ledger_group_memberships membership
  where membership.group_id = requested_group_id
    and membership.user_id = actor
    and membership.status = 'active'
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  if previous <> requested_attire then
    update public.ledger_group_memberships membership
    set attire = requested_attire
    where membership.group_id = requested_group_id
      and membership.user_id = actor;
  end if;

  return jsonb_build_object(
    'groupId', requested_group_id,
    'attire', requested_attire,
    'changed', previous <> requested_attire
  );
end;
$$;

comment on function public.sened_ledger_set_member_attire_v1(uuid, text) is
  'Sets the CALLER''s own avatar attire (none, gabi, netela) in a group they are an active member of. No user argument: no one can set another member''s attire. Idempotent.';

revoke all on function public.sened_ledger_set_member_attire_v1(uuid, text) from public, anon;
grant execute on function public.sened_ledger_set_member_attire_v1(uuid, text) to authenticated;

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
        'email', case when caller_role = 'owner' then member_user.email else null end,
        'attire', membership.attire
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
  'Active members of a group, for any active member. Email is included only for the owner. attire is each member''s own avatar choice (none, gabi, netela).';

revoke all on function public.list_group_members_v1(uuid) from public, anon;
grant execute on function public.list_group_members_v1(uuid) to authenticated;

-- The caller's own value and id, so the profile screen can show their current choice
-- and preview the avatar frame they actually get (derived from the id) without having
-- to work out which row of the members list is theirs. It is their own id.
create or replace function public.list_my_groups_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'groupId', group_row.id,
        'tenantId', group_row.tenant_id,
        'name', group_row.name,
        'currency', group_row.currency,
        'role', membership_row.role,
        'attire', membership_row.attire,
        'userId', membership_row.user_id,
        'accounts', (
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', account_row.id,
                'code', account_row.code,
                'name', account_row.name,
                'type', account_row.account_type
              )
              order by account_row.code
            ),
            '[]'::jsonb
          )
          from public.ledger_accounts account_row
          where account_row.group_id = group_row.id
            and account_row.tenant_id = group_row.tenant_id
        )
      )
      order by group_row.name, group_row.id
    ),
    '[]'::jsonb
  )
  from public.ledger_group_memberships membership_row
  join public.ledger_groups group_row
    on group_row.id = membership_row.group_id
   and group_row.tenant_id = membership_row.tenant_id
  where membership_row.user_id = auth.uid()
    and membership_row.status = 'active';
$$;

comment on function public.list_my_groups_v1() is
  'Every active group the calling user belongs to, with its chart of accounts and the caller''s own avatar attire. Exists because a client cannot otherwise learn which group it is acting for, which the ledger correction form needs.';

revoke all on function public.list_my_groups_v1() from public, anon;
grant execute on function public.list_my_groups_v1() to authenticated;
