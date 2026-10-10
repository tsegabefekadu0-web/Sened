-- Verification of draw role gating under real authenticated sessions
-- (Owner, Treasurer, Member, and Outsider).
-- Run by scripts/verify-migrations.ps1 against Postgres container.
-- Success prints: ALL DRAW ROLE GATING CHECKS PASSED

begin;
do $roles$
declare
  v_owner constant uuid := 'd1111111-1111-4000-8000-000000000001';
  v_treasurer constant uuid := 'd2222222-2222-4000-8000-000000000002';
  v_member constant uuid := 'd3333333-3333-4000-8000-000000000003';
  v_outsider constant uuid := 'd4444444-4444-4000-8000-000000000004';
  v_newcomer constant uuid := 'd5555555-5555-4000-8000-000000000005';
  v_newcomer2 constant uuid := 'd6666666-6666-4000-8000-000000000006';
  v_group uuid;
  v_cycle_res jsonb;
  v_cycle_id uuid;
  v_invite_res jsonb;
  v_invite_token text;
  v_invite_id uuid;
  v_redeem_res jsonb;
  v_failed boolean;
begin
  -- 1. Setup test users in auth.users
  insert into auth.users (id, email) values
    (v_owner, 'draw-owner@example.test'),
    (v_treasurer, 'draw-treasurer@example.test'),
    (v_member, 'draw-member@example.test'),
    (v_outsider, 'draw-outsider@example.test'),
    (v_newcomer, 'draw-newcomer@example.test'),
    (v_newcomer2, 'draw-newcomer2@example.test')
  on conflict (id) do nothing;

  -- 2. Owner provisions community
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  v_group := (public.sened_community_create_v1(
    'Draw Role Test Equb',
    'equb',
    5000,
    'monthly',
    8
  )->>'groupId')::uuid;

  if v_group is null then
    raise exception 'CHECK 1 FAILED: could not provision test group';
  end if;

  -- Add treasurer and member to ledger_group_memberships
  reset role;
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role)
  values
    (v_group, v_owner, v_treasurer, 'treasurer'),
    (v_group, v_owner, v_member, 'member');

  -- 3. Owner creates a draw cycle -> SUCCEEDS
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  v_cycle_res := public.create_draw_cycle_v1(
    v_group,
    'Cycle 1',
    5000.00,
    3,
    0,
    now(),
    'idem-owner-cycle-1',
    'off',
    48,
    48
  );
  v_cycle_id := (v_cycle_res->'cycle'->>'cycleId')::uuid;
  if v_cycle_id is null then
    raise exception 'CHECK 2 FAILED: owner could not create draw cycle';
  end if;

  -- 4. Member calls create_draw_cycle_v1 -> MUST FAIL with 42501 FORBIDDEN
  reset role;
  perform set_config('request.jwt.claim.sub', v_member::text, true);
  set local role authenticated;

  v_failed := false;
  begin
    perform public.create_draw_cycle_v1(
      v_group,
      'Member Forbidden Cycle',
      5000.00,
      3,
      0,
      now(),
      'idem-member-cycle-fail',
      'off',
      48,
      48
    );
  exception when sqlstate '42501' then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'CHECK 3 FAILED: member was allowed to create a draw cycle!';
  end if;

  -- 5. Member calls set_draw_cycle_contribution_gate_v1 -> MUST FAIL with 42501 FORBIDDEN
  v_failed := false;
  begin
    perform public.set_draw_cycle_contribution_gate_v1(
      v_cycle_id,
      'warn',
      'Member trying to change gate without treasurer permission'
    );
  exception when sqlstate '42501' then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'CHECK 4 FAILED: member was allowed to change draw contribution gate!';
  end if;

  -- 6. Member calls open_draw_v1 -> MUST FAIL with 42501 FORBIDDEN
  v_failed := false;
  begin
    perform public.open_draw_v1(
      v_cycle_id,
      1,
      'idem-member-open-fail'
    );
  exception when sqlstate '42501' then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'CHECK 5 FAILED: member was allowed to open a draw round!';
  end if;

  -- 7. Treasurer calls set_draw_cycle_contribution_gate_v1 -> SUCCEEDS
  reset role;
  perform set_config('request.jwt.claim.sub', v_treasurer::text, true);
  set local role authenticated;

  v_cycle_res := public.set_draw_cycle_contribution_gate_v1(
    v_cycle_id,
    'warn',
    'Treasurer changing gate policy for verification check'
  );
  if v_cycle_res->'cycle'->>'contributionGate' <> 'warn' then
    raise exception 'CHECK 6 FAILED: treasurer gate change did not apply %', v_cycle_res;
  end if;

  -- 8. Outsider (not in group) calls open_draw_v1 -> MUST FAIL with 42501 FORBIDDEN
  reset role;
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  set local role authenticated;

  v_failed := false;
  begin
    perform public.open_draw_v1(
      v_cycle_id,
      1,
      'idem-outsider-open-fail'
    );
  exception when sqlstate '42501' then
    v_failed := true;
  end;

  if not v_failed then
    raise exception 'CHECK 7 FAILED: outsider was allowed to open a draw round!';
  end if;

  -- 9. INVITE LIFECYCLE & EXPIRY VERIFICATION
  -- 9a. Owner creates an invite link
  reset role;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  v_invite_res := public.create_group_invite_v1(v_group, 24, 2);
  v_invite_token := v_invite_res->>'token';
  v_invite_id := (v_invite_res->>'inviteId')::uuid;

  if v_invite_token is null or v_invite_id is null then
    raise exception 'CHECK 8 FAILED: owner could not create group invite %', v_invite_res;
  end if;

  -- 9b. Newcomer redeems active invite -> SUCCEEDS
  reset role;
  perform set_config('request.jwt.claim.sub', v_newcomer::text, true);
  set local role authenticated;

  v_redeem_res := public.redeem_group_invite_v1(v_invite_token);
  if v_redeem_res->>'status' <> 'joined' then
    raise exception 'CHECK 9 FAILED: newcomer could not redeem invite %', v_redeem_res;
  end if;

  -- 9c. Re-redemption by active member -> returns 'already_member' without consuming use_count
  v_redeem_res := public.redeem_group_invite_v1(v_invite_token);
  if v_redeem_res->>'status' <> 'already_member' then
    raise exception 'CHECK 10 FAILED: active member repeat redemption was %', v_redeem_res;
  end if;

  -- 9d. Expired invite redemption -> MUST FAIL with ledger_invite_expired
  reset role;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  v_invite_res := public.create_group_invite_v1(v_group, 1, 1);
  v_invite_token := v_invite_res->>'token';
  v_invite_id := (v_invite_res->>'inviteId')::uuid;

  reset role;
  update public.ledger_group_invites
  set created_at = clock_timestamp() - interval '2 days',
      expires_at = clock_timestamp() - interval '1 day'
  where id = v_invite_id;

  perform set_config('request.jwt.claim.sub', v_newcomer2::text, true);
  set local role authenticated;

  v_failed := false;
  begin
    perform public.redeem_group_invite_v1(v_invite_token);
  exception when others then
    if sqlerrm like '%ledger_invite_expired%' then
      v_failed := true;
    end if;
  end;

  if not v_failed then
    raise exception 'CHECK 11 FAILED: expired invite did not throw ledger_invite_expired!';
  end if;

  -- 9e. Revoked invite redemption -> MUST FAIL with ledger_invite_revoked
  reset role;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  v_invite_res := public.create_group_invite_v1(v_group, 24, 1);
  v_invite_token := v_invite_res->>'token';
  v_invite_id := (v_invite_res->>'inviteId')::uuid;

  perform public.revoke_group_invite_v1(v_invite_id);

  reset role;
  perform set_config('request.jwt.claim.sub', v_newcomer2::text, true);
  set local role authenticated;

  v_failed := false;
  begin
    perform public.redeem_group_invite_v1(v_invite_token);
  exception when others then
    if sqlerrm like '%ledger_invite_revoked%' then
      v_failed := true;
    end if;
  end;

  if not v_failed then
    raise exception 'CHECK 12 FAILED: revoked invite did not throw ledger_invite_revoked!';
  end if;

  -- 9f. Exhausted invite redemption -> MUST FAIL with ledger_invite_exhausted
  reset role;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  set local role authenticated;

  v_invite_res := public.create_group_invite_v1(v_group, 24, 1);
  v_invite_token := v_invite_res->>'token';
  v_invite_id := (v_invite_res->>'inviteId')::uuid;

  -- Newcomer2 uses the single slot -> SUCCEEDS
  reset role;
  perform set_config('request.jwt.claim.sub', v_newcomer2::text, true);
  set local role authenticated;

  v_redeem_res := public.redeem_group_invite_v1(v_invite_token);
  if v_redeem_res->>'status' <> 'joined' then
    raise exception 'CHECK 13 FAILED: newcomer2 could not redeem single-use invite %', v_redeem_res;
  end if;

  -- Outsider tries to use the now-exhausted invite -> MUST FAIL with ledger_invite_exhausted
  reset role;
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  set local role authenticated;

  v_failed := false;
  begin
    perform public.redeem_group_invite_v1(v_invite_token);
  exception when others then
    if sqlerrm like '%ledger_invite_exhausted%' then
      v_failed := true;
    end if;
  end;

  if not v_failed then
    raise exception 'CHECK 14 FAILED: exhausted invite did not throw ledger_invite_exhausted!';
  end if;

end $roles$;
commit;

select 'ALL DRAW ROLE AND INVITE LIFECYCLE CHECKS PASSED' as result;
