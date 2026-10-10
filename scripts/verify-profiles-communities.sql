-- Verification of profiles and server-side community creation
-- (supabase/migrations/20261017100000_profiles_and_communities.sql).
-- Run by scripts/verify-migrations.ps1 after migrations have been applied twice.
-- Every check raises on failure. Success prints: ALL PROFILES AND COMMUNITIES CHECKS PASSED

begin;
do $prof$
declare
  v_user_a constant uuid := 'aaaaaaaa-1111-4000-8000-000000000001';
  v_user_b constant uuid := 'bbbbbbbb-1111-4000-8000-000000000002';
  v_user_c constant uuid := 'cccccccc-1111-4000-8000-000000000003';
  v_prof jsonb;
  v_comm jsonb;
  v_name text;
  v_count integer;
  v_failed boolean;
  v_group uuid;
begin
  -- 1. Setup users in auth.users
  insert into auth.users (id, email) values
    (v_user_a, 'user-a@example.test'),
    (v_user_b, 'user-b@example.test'),
    (v_user_c, 'user-c@example.test')
  on conflict (id) do nothing;

  -- 2. Check auto-created profiles from trigger
  select count(*) into v_count from public.profiles where id in (v_user_a, v_user_b, v_user_c);
  if v_count <> 3 then
    raise exception 'CHECK 1 FAILED: expected 3 auto-created profiles, got %', v_count;
  end if;

  -- 3. User A updates their profile via RPC
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  v_prof := public.sened_profile_upsert_v1('Abebe Bikila', '0911223344', null, 'am', 'dark');
  if v_prof->>'name' <> 'Abebe Bikila' or v_prof->>'preferredTheme' <> 'dark' then
    raise exception 'CHECK 2 FAILED: profile upsert mismatch %', v_prof;
  end if;

  -- 4. User A reads own profile via SELECT
  select count(*) into v_count from public.profiles where id = v_user_a;
  if v_count <> 1 then
    raise exception 'CHECK 3 FAILED: user cannot read own profile';
  end if;

  -- 5. User B (not in any group with User A yet) cannot read User A's profile
  reset role;
  perform set_config('request.jwt.claim.sub', v_user_b::text, true);
  set local role authenticated;

  select count(*) into v_count from public.profiles where id = v_user_a;
  if v_count <> 0 then
    raise exception 'CHECK 4 FAILED: stranger was able to read User A profile';
  end if;

  -- 6. User B cannot update User A's profile directly
  v_failed := false;
  begin
    update public.profiles set name = 'Hacked' where id = v_user_a;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      raise exception 'Update succeeded across RLS';
    end if;
  exception when others then
    v_failed := true;
  end;

  -- If RLS prevented it silently (0 rows updated), verify name is still intact
  reset role;
  select name into v_name from public.profiles where id = v_user_a;
  if v_name <> 'Abebe Bikila' then
    raise exception 'CHECK 5 FAILED: stranger corrupted profile (%)', v_name;
  end if;

  -- 7. Community creation: User A creates an Equb
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;

  v_comm := public.sened_community_create_v1('Arada Equb', 'equb', 5000, 'monthly', 12);
  if v_comm->>'name' <> 'Arada Equb' or v_comm->>'kind' <> 'equb' or v_comm->>'role' <> 'owner' then
    raise exception 'CHECK 6 FAILED: community creation output mismatch %', v_comm;
  end if;

  v_group := (v_comm->>'groupId')::uuid;
  if v_comm->'invite'->>'token' is null then
    raise exception 'CHECK 6b FAILED: community creation missing invite token %', v_comm;
  end if;

  -- Verify group seeded in ledger_groups with parameters
  select count(*) into v_count from public.ledger_groups
  where id = v_group and kind = 'equb' and contribution_amount = 5000 and target_members = 12;
  if v_count <> 1 then
    raise exception 'CHECK 7 FAILED: ledger_groups row not properly saved';
  end if;

  -- Verify User A is owner in ledger_group_memberships
  select count(*) into v_count from public.ledger_group_memberships
  where group_id = v_group and user_id = v_user_a and role = 'owner' and status = 'active';
  if v_count <> 1 then
    raise exception 'CHECK 8 FAILED: owner membership missing';
  end if;

  -- Verify chart of accounts has 4 accounts
  select count(*) into v_count from public.ledger_accounts where group_id = v_group;
  if v_count <> 4 then
    raise exception 'CHECK 9 FAILED: expected 4 chart accounts, got %', v_count;
  end if;

  -- 8. Add User B to User A's group to test peer profile visibility
  reset role;
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status)
  values (v_group, v_user_a, v_user_b, 'member', 'active');

  -- User B should now be able to read User A's profile as peer group member!
  perform set_config('request.jwt.claim.sub', v_user_b::text, true);
  set local role authenticated;

  select count(*) into v_count from public.profiles where id = v_user_a;
  if v_count <> 1 then
    raise exception 'CHECK 10 FAILED: peer group member should be able to read profile';
  end if;

  -- User C (still an outsider) cannot read User A's profile
  reset role;
  perform set_config('request.jwt.claim.sub', v_user_c::text, true);
  set local role authenticated;

  select count(*) into v_count from public.profiles where id = v_user_a;
  if v_count <> 0 then
    raise exception 'CHECK 11 FAILED: outsider cannot read profile';
  end if;

  -- 9. Anon cannot create a community
  reset role;
  set local role anon;
  v_failed := false;
  begin
    perform public.sened_community_create_v1('Anon Equb', 'equb', 1000, 'monthly', 5);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'CHECK 12 FAILED: anon user should not be able to create community';
  end if;

  -- 10. Invalid community parameters rejected
  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  set local role authenticated;
  v_failed := false;
  begin
    perform public.sened_community_create_v1('', 'equb', 1000, 'monthly', 5);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'CHECK 13 FAILED: empty community name should be rejected';
  end if;

  v_failed := false;
  begin
    perform public.sened_community_create_v1('Test', 'equb', -100, 'monthly', 5);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'CHECK 14 FAILED: negative contribution amount should be rejected';
  end if;

  reset role;
end $prof$;
rollback;

select 'ALL PROFILES AND COMMUNITIES CHECKS PASSED' as result;
