-- Per-group roles: the group owner grants and removes the treasurer role.
--
-- Write authorization is a property of a person *in a group*, not of their
-- login. `ledger_group_memberships.role` ('owner' | 'treasurer' | 'member') has
-- always carried it, `sened_ledger_provision_group_v1` makes the provisioner the
-- owner, and `sened_ledger_can_manage_group` (owner or treasurer, active) is the
-- gate inside every write function. The JWT's app_metadata role is not part of
-- the model: nothing sets it.
--
-- What was missing is a way to change a member's role. This is it.
--
-- Rules, all enforced here and not in the API layer:
--   * only an active owner of the group may call it;
--   * the target must already be an active member of that group — it never
--     creates a membership, so an outsider cannot be promoted;
--   * the only values are 'treasurer' (grant) and 'member' (clear);
--   * an owner's role cannot be changed, which covers the owner demoting
--     themselves (the group would be left without one);
--   * idempotent: setting the role a member already has changes nothing and
--     reports changed = false.
--
-- Error contract (message, SQLSTATE):
--   ledger_forbidden           42501  no session, or caller is not an owner
--   ledger_group_not_found     P0002  no such group
--   ledger_member_not_found    P0002  target is not an active member
--   ledger_invalid_request     22023  bad role value, or target is an owner

create or replace function public.sened_ledger_set_member_role_v1(
  requested_group_id uuid,
  requested_user_id uuid,
  requested_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
  target public.ledger_group_memberships%rowtype;
  did_change boolean := false;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  if requested_group_id is null
    or requested_user_id is null
    or requested_role is null
    or requested_role not in ('treasurer', 'member') then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  select group_row.tenant_id
  into tenant
  from public.ledger_groups group_row
  where group_row.id = requested_group_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_group_not_found';
  end if;

  if not exists (
    select 1
    from public.ledger_group_memberships caller
    where caller.group_id = requested_group_id
      and caller.tenant_id = tenant
      and caller.user_id = actor
      and caller.role = 'owner'
      and caller.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  -- Lock the row so two concurrent role changes serialise.
  select membership.*
  into target
  from public.ledger_group_memberships membership
  where membership.group_id = requested_group_id
    and membership.tenant_id = tenant
    and membership.user_id = requested_user_id
    and membership.status = 'active'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_member_not_found';
  end if;

  if target.role = 'owner' then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  if target.role <> requested_role then
    update public.ledger_group_memberships membership
    set role = requested_role
    where membership.group_id = requested_group_id
      and membership.user_id = requested_user_id;
    did_change := true;
  end if;

  return jsonb_build_object(
    'groupId', requested_group_id,
    'userId', requested_user_id,
    'role', requested_role,
    'changed', did_change
  );
end;
$$;

comment on function public.sened_ledger_set_member_role_v1(uuid, uuid, text) is
  'Owner-only. Sets an existing active member of the group to treasurer or member. Never creates a membership and never changes an owner. Idempotent.';

revoke all on function public.sened_ledger_set_member_role_v1(uuid, uuid, text) from public, anon;
grant execute on function public.sened_ledger_set_member_role_v1(uuid, uuid, text) to authenticated;
