-- Verification harness for the Sened Supabase migrations.
--
-- Runs against a stock postgres container rather than Supabase. The runner
-- (scripts/verify-migrations.ps1) applies scripts/supabase-auth-stub.sql first,
-- then every project migration in filename order, then this file.
--
-- Purpose: execute the draw SQL rather than assert things about its text. A
-- migration that parses is not a migration that enforces anything, and the two
-- CRITICAL findings this harness now guards were both in code that read
-- correctly and had never been run.
--
-- Every check raises on failure, so any ERROR in the output is a real failure.
-- Success prints exactly: ALL DRAW BINDING CHECKS PASSED

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'treasurer@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'member-c@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'member-b@example.test'),
  ('44444444-4444-4444-8444-444444444444', 'member-a@example.test'),
  -- ledger_groups.tenant_id references auth.users(id)
  ('bbbbbbbb-0000-4000-8000-000000000001', 'tenant@example.test')
on conflict (id) do nothing;

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","app_metadata":{"role":"owner"}}', false);

insert into public.ledger_groups (id, tenant_id, name, currency, created_by)
values ('aaaaaaaa-0000-4000-8000-000000000001',
        'bbbbbbbb-0000-4000-8000-000000000001', 'Mesfin Equb', 'ETB',
        '11111111-1111-4111-8111-111111111111');

insert into public.ledger_accounts (id, group_id, tenant_id, code, name, account_type) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000001', 'POT', 'Equb pot', 'asset'),
  ('aaaaaaaa-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000001', 'PAYABLE', 'Payable to members', 'liability');

insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
   '11111111-1111-4111-8111-111111111111', 'owner');

insert into public.draw_cycles (id, group_id, tenant_id, name, total_rounds, pot_amount)
values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000001', 'Cycle 1', 8, 3000.00),
  -- Cycle 2 isolates the round-ordering check in CHECK 4.
  ('aaaaaaaa-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000001', 'Cycle 2', 8, 3000.00);

-- Participants are listed in an order that is deliberately NOT ticket order:
-- ticket 'aaa...' belongs to the LAST member listed, so any lookup that ignored
-- ordering would return 22222222 at index 0 instead of 44444444. Ticket order
-- is therefore a: 44444444, b: 33333333, c: 22222222.
create or replace function pg_temp.roster()
returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('memberId','22222222-2222-4222-8222-222222222222','ticket', repeat('c',64),'contributionAmount','1000.00'),
    jsonb_build_object('memberId','33333333-3333-4333-8333-333333333333','ticket', repeat('b',64),'contributionAmount','1000.00'),
    jsonb_build_object('memberId','44444444-4444-4444-8444-444444444444','ticket', repeat('a',64),'contributionAmount','1000.00')
  )
$$;

-- ===========================================================================
-- CHECK 1: ticket-ordered lookup matches the application's ordering
-- ===========================================================================
do $$
declare
  got jsonb;
begin
  got := public.sened_draw_ordered_participant(pg_temp.roster(), 0);
  if got ->> 'memberId' <> '44444444-4444-4444-8444-444444444444' then
    raise exception 'CHECK 1 FAILED: index 0 should be lowest ticket (44444444), got %',
      got ->> 'memberId';
  end if;

  got := public.sened_draw_ordered_participant(pg_temp.roster(), 1);
  if got ->> 'memberId' <> '33333333-3333-4333-8333-333333333333' then
    raise exception 'CHECK 1 FAILED: index 1 should be 33333333, got %', got ->> 'memberId';
  end if;

  got := public.sened_draw_ordered_participant(pg_temp.roster(), 2);
  if got ->> 'memberId' <> '22222222-2222-4222-8222-222222222222' then
    raise exception 'CHECK 1 FAILED: index 2 should be 22222222, got %', got ->> 'memberId';
  end if;

  if public.sened_draw_ordered_participant(pg_temp.roster(), 3) is not null then
    raise exception 'CHECK 1 FAILED: out-of-range index should yield null';
  end if;
end;
$$;

-- ===========================================================================
-- CHECK 2: an honest reveal is accepted
--
-- Cycle 1, round 1. Winner is index 0 in ticket order = member-a.
-- ===========================================================================
do $$
declare
  commitment text := repeat('1', 64);
begin
  perform public.commit_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000c1'::uuid,
    1, 'dddddddd-0000-4000-8000-000000000001'::uuid,
    commitment, repeat('n', 32), repeat('2', 64), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-honest-round-1', now()
  );

  perform public.reveal_draw_v1(
    'dddddddd-0000-4000-8000-000000000001'::uuid,
    'seed-value-for-round-one-000000000000',
    commitment, repeat('3', 64), repeat('4', 64),
    0, '44444444-4444-4444-8444-444444444444'::uuid, repeat('a', 64),
    2700.00, 300.00, now()
  );
end;
$$;

-- ===========================================================================
-- CHECK 3: forged reveals are rejected by the database
--
-- CRITICAL regression guard. Before
-- 20260926110000_draw_reveal_binding.sql the trigger never compared
-- winner_member_id against the committed roster, so a treasurer holding an
-- ordinary user JWT could name any winner and write a permanently
-- unalterable row.
-- ===========================================================================
do $$
declare
  commitment text := repeat('5', 64);
begin
  perform public.commit_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000c1'::uuid,
    2, 'dddddddd-0000-4000-8000-000000000002'::uuid,
    commitment, repeat('o', 32), repeat('6', 64), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-forged-round-2', now()
  );

  -- Claim selected_index 0 (which is member-a) but name member-c.
  begin
    perform public.reveal_draw_v1(
      'dddddddd-0000-4000-8000-000000000002'::uuid,
      'seed-value-for-round-two-0000000000000',
      commitment, repeat('7', 64), repeat('8', 64),
      0, '22222222-2222-4222-8222-222222222222'::uuid, repeat('c', 64),
      2700.00, 300.00, now()
    );
    raise exception 'CHECK 3 FAILED: forged winner was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_winner_binding_mismatch%' then
      raise exception 'CHECK 3 FAILED: wrong rejection reason for winner: %', sqlerrm;
    end if;
  end;

  -- Correct winner, but claim a ticket that belongs to somebody else. Uses
  -- index 2 / member-c, who has not won yet, so the repeat-winner guard cannot
  -- mask this check.
  begin
    perform public.reveal_draw_v1(
      'dddddddd-0000-4000-8000-000000000002'::uuid,
      'seed-value-for-round-two-0000000000000',
      commitment, repeat('7', 64), repeat('8', 64),
      2, '22222222-2222-4222-8222-222222222222'::uuid, repeat('a', 64),
      2700.00, 300.00, now()
    );
    raise exception 'CHECK 3 FAILED: mismatched winning ticket was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_winning_ticket_mismatch%' then
      raise exception 'CHECK 3 FAILED: wrong rejection reason for ticket: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ===========================================================================
-- CHECK 4: a later round cannot be revealed before an earlier one
--
-- Before the fix every prior-winner filter used `round < current`, so
-- revealing round 2 before round 1 defeated rotation with no cryptographic
-- attack. Uses cycle 2 so the check is isolated from CHECK 2 and CHECK 3.
-- ===========================================================================
do $$
begin
  perform public.commit_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000c2'::uuid,
    1, 'eeeeeeee-0000-4000-8000-000000000001'::uuid,
    repeat('d1', 32), repeat('r1', 32), repeat('e1', 32), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-order-c2-round-1', now()
  );
  perform public.commit_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000c2'::uuid,
    2, 'eeeeeeee-0000-4000-8000-000000000002'::uuid,
    repeat('d2', 32), repeat('r2', 32), repeat('e2', 32), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-order-c2-round-2', now()
  );

  -- Round 2 first. The chosen winner has not won yet, so the ONLY reason this
  -- can fail is the ordering guard.
  begin
    perform public.reveal_draw_v1(
      'eeeeeeee-0000-4000-8000-000000000002'::uuid,
      'seed-cycle-two-round-two-000000000',
      repeat('d2', 32), repeat('f1', 32), repeat('f2', 32),
      2, '22222222-2222-4222-8222-222222222222'::uuid, repeat('c', 64),
      2700.00, 300.00, now()
    );
    raise exception 'CHECK 4 FAILED: out-of-order reveal was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_round_out_of_order%' then
      raise exception 'CHECK 4 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- Round 1 now succeeds, proving the guard is ordering-based rather than
  -- simply refusing everything.
  perform public.reveal_draw_v1(
    'eeeeeeee-0000-4000-8000-000000000001'::uuid,
    'seed-cycle-two-round-one-000000000',
    repeat('d1', 32), repeat('f3', 32), repeat('f4', 32),
    0, '44444444-4444-4444-8444-444444444444'::uuid, repeat('a', 64),
    2700.00, 300.00, now()
  );

  -- With round 1 revealed, round 2 becomes revealable.
  perform public.reveal_draw_v1(
    'eeeeeeee-0000-4000-8000-000000000002'::uuid,
    'seed-cycle-two-round-two-000000000',
    repeat('d2', 32), repeat('f1', 32), repeat('f2', 32),
    2, '22222222-2222-4222-8222-222222222222'::uuid, repeat('c', 64),
    2700.00, 300.00, now()
  );
end;
$$;

-- ===========================================================================
-- CHECK 5: a payout must agree with the reveal it settles
--
-- draw_payouts had no validate trigger at all, so amount and reserve_amount
-- were free. The ledger entry is posted through post_ledger_entry_v1 so the
-- hash chain and the balanced-postings rule are genuinely exercised, rather
-- than inserting ledger rows behind the database's back.
-- ===========================================================================
do $$
declare
  entry jsonb;
  entry_id uuid;
begin
  entry := public.post_ledger_entry_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'verify-payout-entry-1',
    now(),
    'contribution',
    null,
    null,
    jsonb_build_array(
      jsonb_build_object('accountId','aaaaaaaa-0000-4000-8000-0000000000a1','direction','debit','amount','2700.00'),
      jsonb_build_object('accountId','aaaaaaaa-0000-4000-8000-0000000000a2','direction','credit','amount','2700.00')
    )
  );
  entry_id := (entry -> 'entry' ->> 'id')::uuid;

  if entry_id is null then
    raise exception 'CHECK 5 FAILED: could not post the ledger entry: %', entry::text;
  end if;

  -- Payout for a different amount than the reveal recorded must be refused.
  begin
    perform public.record_draw_payout_v1(
      'dddddddd-0000-4000-8000-000000000001'::uuid,
      entry_id,
      '44444444-4444-4444-8444-444444444444'::uuid,
      9999.00, 300.00, now()
    );
    raise exception 'CHECK 5 FAILED: payout with a mismatched amount was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_payout_amount_mismatch%' then
      raise exception 'CHECK 5 FAILED: wrong rejection reason for amount: %', sqlerrm;
    end if;
  end;

  -- Payout naming a different winner than the reveal must be refused. The RPC
  -- already guards this (draw_commitment_mismatch, an unfortunately named
  -- error); the new trigger is the backstop for a direct table insert.
  begin
    perform public.record_draw_payout_v1(
      'dddddddd-0000-4000-8000-000000000001'::uuid,
      entry_id,
      '22222222-2222-4222-8222-222222222222'::uuid,
      2700.00, 300.00, now()
    );
    raise exception 'CHECK 5 FAILED: payout naming a different winner was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_commitment_mismatch%'
       and sqlerrm not like '%draw_winner_binding_mismatch%' then
      raise exception 'CHECK 5 FAILED: wrong rejection reason for winner: %', sqlerrm;
    end if;
  end;

  -- The honest payout is accepted.
  perform public.record_draw_payout_v1(
    'dddddddd-0000-4000-8000-000000000001'::uuid,
    entry_id,
    '44444444-4444-4444-8444-444444444444'::uuid,
    2700.00, 300.00, now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Group provisioning and the standard chart of accounts
--
-- The sink that turns a VERIFIED bank result into a ledger entry resolves a
-- counter-account by code. Before this migration no function ever wrote a row to
-- ledger_accounts, so that lookup could only ever come back empty and the sink
-- could only fail closed. These checks execute the provisioning path and confirm
-- the codes the TypeScript resolver asks for are the codes that get created.
-- ---------------------------------------------------------------------------
do $provision$
declare
  provisioned jsonb;
  provisioned_group uuid;
  account_codes text[];
  income_id uuid;
  cash_id uuid;
begin
  -- The treasurer provisions their own group.
  provisioned := public.sened_ledger_provision_group_v1('Mesfin Equb (provisioned)');
  provisioned_group := (provisioned->>'groupId')::uuid;

  if provisioned_group is null then
    raise exception 'PROVISION 1 FAILED: no groupId was returned';
  end if;

  -- All four standard accounts, and only those.
  select coalesce(array_agg(account.code order by account.code), '{}')
  into account_codes
  from public.ledger_accounts account
  where account.group_id = provisioned_group;

  if account_codes <> array['CONTRIBUTION_INCOME', 'EQUITY_OPENING', 'PAYOUT_EXPENSE', 'POT_CASH'] then
    raise exception 'PROVISION 2 FAILED: unexpected chart of accounts: %', account_codes;
  end if;

  -- The group head row is created by the baseline trigger, so a group is usable
  -- the moment it is provisioned.
  perform 1 from public.ledger_group_heads head
  where head.group_id = provisioned_group;
  if not found then
    raise exception 'PROVISION 3 FAILED: the group head was not initialised';
  end if;

  -- The creator is an owner, or every tenant check downstream fails.
  perform 1 from public.ledger_group_memberships membership
  where membership.group_id = provisioned_group
    and membership.user_id = auth.uid()
    and membership.role = 'owner';
  if not found then
    raise exception 'PROVISION 4 FAILED: the creator is not an owner of the new group';
  end if;

  select id into cash_id from public.ledger_accounts
  where group_id = provisioned_group and code = 'POT_CASH';
  select id into income_id from public.ledger_accounts
  where group_id = provisioned_group and code = 'CONTRIBUTION_INCOME';

  -- The exact shape the ledger sink posts for an inbound movement, so the
  -- codes the resolver returns are proven to be accepted by the ledger.
  perform public.post_ledger_entry_v1(
    provisioned_group,
    'provision-check-1',
    now(),
    'contribution',
    null,
    null,
    jsonb_build_array(
      jsonb_build_object('accountId', cash_id, 'direction', 'debit', 'amount', 5000.00),
      jsonb_build_object('accountId', income_id, 'direction', 'credit', 'amount', 5000.00)
    )
  );

  -- An unauthenticated caller must not be able to provision a group.
  perform set_config('request.jwt.claim.sub', '', false);
  begin
    perform public.sened_ledger_provision_group_v1('Should not exist');
    raise exception 'PROVISION 5 FAILED: an unauthenticated caller created a group';
  exception when others then
    if sqlerrm not like '%ledger_provision_unauthorized%' then
      raise exception 'PROVISION 5 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

  -- A blank name is refused rather than creating an unnamed group.
  begin
    perform public.sened_ledger_provision_group_v1('   ');
    raise exception 'PROVISION 6 FAILED: a blank group name was ACCEPTED';
  exception when others then
    if sqlerrm not like '%ledger_invalid_request%' then
      raise exception 'PROVISION 6 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- Provisioning again is additive, not destructive: codes are unique per
  -- group, so a second group of the same name coexists and nothing is mutated.
  perform public.sened_ledger_provision_group_v1('Mesfin Equb (provisioned)');
end;
$provision$;

select 'ALL DRAW BINDING CHECKS PASSED' as result;
