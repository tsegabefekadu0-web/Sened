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
  '{"sub":"11111111-1111-4111-8111-111111111111"}', false);

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

-- A sealed member contribution, shared by every draw check below. The M4.3
-- protocol refuses a commitment with none, and the draw RPCs were reissued at the
-- new arity by 20260927130000_draw_member_rpcs.sql, so every call here carries a
-- digest and a set.
create or replace function pg_temp.member_digest() returns text
  language sql immutable as $$ select repeat('e', 64) $$;

create or replace function pg_temp.member_set() returns jsonb
  language sql immutable as $$
    select jsonb_build_array(
      jsonb_build_object(
        'memberId', '44444444-4444-4444-8444-444444444444',
        'sealed', repeat('c', 64)
      )
    )
  $$;

create or replace function pg_temp.member_nonces() returns jsonb
  language sql immutable as $$
    select jsonb_build_array(
      jsonb_build_object(
        'memberId', '44444444-4444-4444-8444-444444444444',
        'nonce', repeat('m', 24)
      )
    )
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
    1, 'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    commitment, repeat('n', 32), repeat('2', 64),
    pg_temp.member_digest(), pg_temp.member_set(), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-honest-round-1', now()
  );

  perform public.reveal_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'seed-value-for-round-one-000000000000',
    commitment,
    pg_temp.member_digest(), pg_temp.member_nonces(),
    repeat('3', 64), repeat('4', 64),
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
    commitment, repeat('o', 32), repeat('6', 64),
    pg_temp.member_digest(), pg_temp.member_set(), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-forged-round-2', now()
  );

  -- Claim selected_index 0 (which is member-a) but name member-c.
  begin
    perform public.reveal_draw_v1(
      'dddddddd-0000-4000-8000-000000000002'::uuid,
      'seed-value-for-round-two-0000000000000',
      commitment,
    pg_temp.member_digest(), pg_temp.member_nonces(),
    repeat('7', 64), repeat('8', 64),
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
      commitment,
    pg_temp.member_digest(), pg_temp.member_nonces(),
    repeat('7', 64), repeat('8', 64),
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
    1, 'aaaaaaaa-0000-4000-8000-0000000000c1'::uuid,
    repeat('d1', 32), repeat('r1', 32), repeat('e1', 32),
    pg_temp.member_digest(), pg_temp.member_set(), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-order-c2-round-1', now()
  );
  perform public.commit_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000c2'::uuid,
    2, 'eeeeeeee-0000-4000-8000-000000000002'::uuid,
    repeat('d2', 32), repeat('r2', 32), repeat('e2', 32),
    pg_temp.member_digest(), pg_temp.member_set(), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-order-c2-round-2', now()
  );

  -- Round 2 first. The chosen winner has not won yet, so the ONLY reason this
  -- can fail is the ordering guard.
  begin
    perform public.reveal_draw_v1(
      'eeeeeeee-0000-4000-8000-000000000002'::uuid,
      'seed-cycle-two-round-two-000000000',
      repeat('d2', 32),
      pg_temp.member_digest(), pg_temp.member_nonces(),
      repeat('f1', 32), repeat('f2', 32),
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
    'aaaaaaaa-0000-4000-8000-0000000000c1'::uuid,
    'seed-cycle-two-round-one-000000000',
    repeat('d1', 32),
    pg_temp.member_digest(), pg_temp.member_nonces(),
    repeat('f3', 32), repeat('f4', 32),
    0, '44444444-4444-4444-8444-444444444444'::uuid, repeat('a', 64),
    2700.00, 300.00, now()
  );

  -- With round 1 revealed, round 2 becomes revealable.
  perform public.reveal_draw_v1(
    'eeeeeeee-0000-4000-8000-000000000002'::uuid,
    'seed-cycle-two-round-two-000000000',
    repeat('d2', 32),
    pg_temp.member_digest(), pg_temp.member_nonces(),
    repeat('f1', 32), repeat('f2', 32),
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
      'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
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
      'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
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
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
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
      -- The wire form is a *string*: `post_ledger_entry_v1` rejects a JSON
      -- number here, which is the same rule the TypeScript `formatEtbAmount`
      -- enforces. Passing 5000.00 rather than '5000.00' is rejected as
      -- ledger_invalid_posting.
      jsonb_build_object('accountId', cash_id, 'direction', 'debit', 'amount', '5000.00'),
      jsonb_build_object('accountId', income_id, 'direction', 'credit', 'amount', '5000.00')
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

-- ---------------------------------------------------------------------------
-- Member-seed commitments
--
-- The seed-grinding attack: a treasurer could search seeds for a favourable
-- outcome and commit to the one they liked, and the reveal would be perfectly
-- consistent. These checks confirm the database can *hold* the member
-- contributions and refuses the shapes that would let a commitment or reveal
-- claim a ceremony nobody can check.
--
-- Scope: this migration adds storage and constraints. Passing them through
-- `commit_draw_v1` and `reveal_draw_v1` is the remaining piece and is recorded
-- in AGENTWORK.md section 6 — the RPCs keep their committed signatures, and
-- changing a granted function's arity is how the bank migration became
-- unappliable.
-- ---------------------------------------------------------------------------
do $member$
declare
  draw_uuid constant uuid := 'cccccccc-0000-4000-8000-000000000001';
  group_uuid constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  tenant_uuid constant uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  cycle_uuid constant uuid := 'aaaaaaaa-0000-4000-8000-0000000000c1';
  actor_uuid constant uuid := '11111111-1111-4111-8111-111111111111';
begin
  -- A commitment carrying a real member set is accepted.
  insert into public.draw_commitments (
    draw_id, group_id, tenant_id, cycle_id, round, commitment, commitment_nonce,
    member_digest, member_commitments, roster_digest, participants, pot_amount,
    total_rounds, reserve_ratio_bps, actor_id, idempotency_key
  ) values (
    draw_uuid, group_uuid, tenant_uuid, cycle_uuid, 1, repeat('a', 64),
    'nonce-0123456789abcdef-XYZ', repeat('e', 64),
    jsonb_build_array(
      jsonb_build_object(
        'memberId', '44444444-4444-4444-8444-444444444444',
        'sealed', repeat('c', 64)
      )
    ),
    repeat('b', 64),
    -- One participant, so the reveal's selected_index 0 is a real member. The
    -- reveal trigger checks the index against the committed roster and raises
    -- draw_selection_out_of_range otherwise, which would mask the constraint
    -- these checks are actually about.
    jsonb_build_array(
      jsonb_build_object(
        'memberId', '44444444-4444-4444-8444-444444444444',
        'displayName', 'Member A',
        'ticket', repeat('c', 64),
        'contributionAmount', '5000.00'
      )
    ),
    5000.00, 5, 1000, actor_uuid, 'member-commit-1'
  );

  if not exists (
    select 1 from public.draw_commitments
    where draw_id = draw_uuid
      and jsonb_array_length(member_commitments) = 1
  ) then
    raise exception 'MEMBER 1 FAILED: the member contribution was not stored';
  end if;

  -- A commitment that claims a digest but carries an empty set is refused. This
  -- is the shape that would make a "fair" draw unfalsifiable.
  begin
    insert into public.draw_commitments (
      draw_id, group_id, tenant_id, cycle_id, round, commitment, commitment_nonce,
      member_digest, member_commitments, roster_digest, participants, pot_amount,
      total_rounds, reserve_ratio_bps, actor_id, idempotency_key
    ) values (
      'cccccccc-0000-4000-8000-000000000002', group_uuid, tenant_uuid, cycle_uuid,
      2, repeat('a', 64), 'nonce-0123456789abcdef-XYZ', repeat('e', 64), '[]'::jsonb,
      repeat('b', 64), '[]'::jsonb, 5000.00, 5, 1000, actor_uuid, 'member-commit-empty'
    );
    raise exception 'MEMBER 2 FAILED: a commitment with an EMPTY member set was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_commitments_member_set_present%' then
      raise exception 'MEMBER 2 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A digest that is not a SHA-256 hex string is refused.
  begin
    insert into public.draw_commitments (
      draw_id, group_id, tenant_id, cycle_id, round, commitment, commitment_nonce,
      member_digest, member_commitments, roster_digest, participants, pot_amount,
      total_rounds, reserve_ratio_bps, actor_id, idempotency_key
    ) values (
      'cccccccc-0000-4000-8000-000000000003', group_uuid, tenant_uuid, cycle_uuid,
      3, repeat('a', 64), 'nonce-0123456789abcdef-XYZ', 'not-a-digest', '[]'::jsonb,
      repeat('b', 64), '[]'::jsonb, 5000.00, 5, 1000, actor_uuid, 'member-commit-baddigest'
    );
    raise exception 'MEMBER 3 FAILED: a non-digest member_digest was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_commitments%' then
      raise exception 'MEMBER 3 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A reveal that opens an empty set is refused for the same reason: the
  -- randomness that decided the winner would not be public.
  --
  -- The split must balance first: the reveal validation trigger runs before the
  -- table constraint, and 5000 + 500 against a 5000 pot trips
  -- draw_payout_split_mismatch long before the nonce set is ever examined.
  begin
    insert into public.draw_reveals (
      draw_id, commitment, seed, member_digest, member_nonces, transcript_digest,
      selection_digest, selected_index, winner_member_id, winning_ticket,
      payout_amount, reserve_amount, actor_id
    ) values (
      draw_uuid, repeat('a', 64), 'reveal-seed-0123456789', repeat('e', 64), '[]'::jsonb,
      repeat('f', 64), repeat('a', 64), 0,
      '44444444-4444-4444-8444-444444444444', repeat('c', 64),
      4500.00, 500.00, actor_uuid
    );
    raise exception 'MEMBER 4 FAILED: a reveal with an EMPTY member nonce set was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_reveals_member_set_matches%' then
      raise exception 'MEMBER 4 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;
end;
$member$;

-- ---------------------------------------------------------------------------
-- The draw RPCs refuse a ceremony nobody can check
--
-- The application already refuses a commitment with no member contribution, but
-- `commit_draw_v1` is reachable directly through PostgREST. If the function
-- accepted an empty set, the fairness property would be a convention rather than
-- a guarantee — and a caller going straight to the database is exactly who an
-- attacker is.
--
-- These also confirm the new arities exist and are granted, which is the class
-- of defect that made the bank migration unappliable: a revoke or grant naming a
-- function that does not exist.
-- ---------------------------------------------------------------------------
do $rpc$
begin
  -- A commit with an empty member set is refused by the function itself.
  begin
    perform public.commit_draw_v1(
      'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
      'aaaaaaaa-0000-4000-8000-0000000000c1'::uuid,
      1,
      'cccccccc-0000-4000-8000-000000000010'::uuid,
      repeat('a', 64),
      'nonce-0123456789abcdef-XYZ',
      repeat('b', 64),
      repeat('e', 64),
      '[]'::jsonb,
      '[]'::jsonb,
      5000.00, 5, 1000, 'rpc-empty-member-set', now()
    );
    raise exception 'RPC 1 FAILED: commit_draw_v1 ACCEPTED an empty member set';
  exception when others then
    if sqlerrm not like '%draw_member_commitment_missing%' then
      raise exception 'RPC 1 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A null member set is refused too, not silently defaulted.
  begin
    perform public.commit_draw_v1(
      'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
      'aaaaaaaa-0000-4000-8000-0000000000c1'::uuid,
      1,
      'cccccccc-0000-4000-8000-000000000011'::uuid,
      repeat('a', 64),
      'nonce-0123456789abcdef-XYZ',
      repeat('b', 64),
      null, null, '[]'::jsonb, 5000.00, 5, 1000, 'rpc-null-member-set', now()
    );
    raise exception 'RPC 2 FAILED: commit_draw_v1 ACCEPTED a null member set';
  exception when others then
    if sqlerrm not like '%draw_member_commitment_missing%' then
      raise exception 'RPC 2 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- An honest commit through the RPC is accepted and stores the set. Round 2 of
  -- a cycle whose total is 5, because CHECK 2 already holds round 1 of cycle 1
  -- and `draw_commitments_cycle_round_key` is unique while
  -- `draw_commitments_round_total_check` requires round <= total_rounds.
  perform public.commit_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000c1'::uuid,
    2,
    'cccccccc-0000-4000-8000-000000000012'::uuid,
    repeat('a', 64),
    'nonce-0123456789abcdef-XYZ',
    repeat('b', 64),
    repeat('e', 64),
    jsonb_build_array(
      jsonb_build_object(
        'memberId', '44444444-4444-4444-8444-444444444444',
        'sealed', repeat('c', 64)
      )
    ),
    '[]'::jsonb,
    5000.00, 5, 1000, 'rpc-honest-member-set', now()
  );

  if not exists (
    select 1 from public.draw_commitments
    where idempotency_key = 'rpc-honest-member-set'
      and jsonb_array_length(member_commitments) = 1
  ) then
    raise exception 'RPC 3 FAILED: the honest member set was not stored';
  end if;

  -- A reveal that opens fewer nonces than were sealed is refused.
  begin
    perform public.reveal_draw_v1(
      'cccccccc-0000-4000-8000-000000000012'::uuid,
      'reveal-seed-0123456789', repeat('a', 64), repeat('e', 64), '[]'::jsonb,
      repeat('f', 64), repeat('a', 64), 0,
      '44444444-4444-4444-8444-444444444444', repeat('c', 64),
      5000.00, 500.00, now()
    );
    raise exception 'RPC 4 FAILED: reveal_draw_v1 ACCEPTED an empty nonce set';
  exception when others then
    if sqlerrm not like '%draw_member_commitment_missing%' then
      raise exception 'RPC 4 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A reveal carrying a different member digest than was committed is refused.
  begin
    perform public.reveal_draw_v1(
      'cccccccc-0000-4000-8000-000000000012'::uuid,
      'reveal-seed-0123456789', repeat('a', 64), repeat('1', 64),
      jsonb_build_array(
        jsonb_build_object('memberId', '44444444-4444-4444-8444-444444444444', 'nonce', 'n')
      ),
      repeat('f', 64), repeat('a', 64), 0,
      '44444444-4444-4444-8444-444444444444', repeat('c', 64),
      5000.00, 500.00, now()
    );
    raise exception 'RPC 5 FAILED: reveal_draw_v1 ACCEPTED a swapped member digest';
  exception when others then
    if sqlerrm not like '%draw_member_commitment_mismatch%' then
      raise exception 'RPC 5 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- The new arities are the only ones that exist, and they are granted. This is
  -- the check that would have caught the bank migration's mismatched grants.
  if exists (
    select 1 from pg_proc
    join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    where pg_namespace.nspname = 'public'
      and pg_proc.proname = 'commit_draw_v1'
      and pg_proc.pronargs <> 15
  ) then
    raise exception 'RPC 6 FAILED: an old commit_draw_v1 arity still exists';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'RPC 7 FAILED: authenticated cannot execute the new commit_draw_v1';
  end if;

  if has_function_privilege(
    'anon',
    'public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'RPC 8 FAILED: anon can execute commit_draw_v1';
  end if;
end;
$rpc$;

-- ---------------------------------------------------------------------------
-- The read paths a client needs
--
-- `get_bank_account_binding_v1` takes a binding id and a client cannot know its
-- own, which is what blocked the voice -> bank hand-off. These checks prove the
-- new list functions answer for the caller, stay scoped to the caller, and leak
-- no account material.
-- ---------------------------------------------------------------------------
do $reads$
declare
  payload jsonb;
begin
  -- A binding for the calling user, so the list has something to return.
  insert into public.bank_account_bindings (
    id, user_id, group_id, tenant_id, ledger_account_id, provider, currency,
    account_label, account_fingerprint_hmac, sender_fingerprint_hmac,
    receiver_fingerprint_hmac, active
  ) values (
    'abababab-0000-4000-8000-000000000001'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000a1'::uuid,
    'telebirr', 'ETB', 'Treasury mobile money',
    repeat('a', 64), repeat('b', 64), repeat('c', 64), true
  );

  -- Another member's binding, which the caller's list must not contain.
  insert into public.bank_account_bindings (
    id, user_id, group_id, tenant_id, ledger_account_id, provider, currency,
    account_label, account_fingerprint_hmac, sender_fingerprint_hmac,
    receiver_fingerprint_hmac, active
  ) values (
    'abababab-0000-4000-8000-000000000002'::uuid,
    '44444444-4444-4444-8444-444444444444'::uuid,
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000a1'::uuid,
    'cbe', 'ETB', 'Someone else''s account',
    repeat('d', 64), repeat('e', 64), repeat('f', 64), true
  );

  payload := public.list_bank_account_bindings_v1();
  if jsonb_array_length(payload) <> 1 then
    raise exception 'READ 1 FAILED: the caller should see exactly their one binding, saw %',
      jsonb_array_length(payload);
  end if;
  if payload -> 0 ->> 'id' <> 'abababab-0000-4000-8000-000000000001' then
    raise exception 'READ 2 FAILED: the wrong binding was returned';
  end if;

  -- The list carries a label and a provider so a treasurer can recognise the
  -- account, and must not carry the fingerprints or any sealed reference. Those
  -- are HMACs over masked numbers, and shipping them to a browser would move
  -- material that is meant to stay server-side.
  if payload::text like '%accountFingerprintHmac%'
     or payload::text like '%senderFingerprintHmac%'
     or payload::text like '%receiverFingerprintHmac%'
     or payload::text like '%sealedProviderReference%' then
    raise exception 'READ 3 FAILED: the binding list leaked key material';
  end if;
  if payload -> 0 ->> 'accountLabel' is null
     or payload -> 0 ->> 'provider' is null then
    raise exception 'READ 4 FAILED: the list is not recognisable to a treasurer';
  end if;

  -- Group membership, with the chart of accounts the resolver needs. The harness
  -- fixture may already have made the treasurer an owner of this group, so this
  -- is written to be re-runnable.
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status)
  values (
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'bbbbbbbb-0000-4000-8000-000000000001'::uuid,
    '11111111-1111-4111-8111-111111111111'::uuid,
    'owner', 'active'
  )
  on conflict (group_id, user_id) do nothing;

  payload := public.list_my_groups_v1();
  if jsonb_array_length(payload) = 0 then
    raise exception 'READ 5 FAILED: the caller belongs to a group and should see it';
  end if;
  if payload -> 0 ->> 'groupId' <> 'aaaaaaaa-0000-4000-8000-000000000001' then
    raise exception 'READ 6 FAILED: the wrong group was returned';
  end if;
  if payload -> 0 ->> 'role' <> 'owner' then
    raise exception 'READ 7 FAILED: the caller''s role was not returned';
  end if;

  -- The accounts are what the ledger account resolver looks up by code, so they
  -- have to be there. This is the check that would notice a group that exists
  -- with no chart of accounts - the state that made the sink fail closed.
  if not exists (
    select 1
    from jsonb_array_elements(payload -> 0 -> 'accounts') account
    where account ->> 'code' in ('POT', 'PAYABLE')
  ) then
    raise exception 'READ 8 FAILED: the group''s chart of accounts was not returned';
  end if;

  -- A non-member sees nothing. Switch the JWT subject and re-read.
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
  if jsonb_array_length(public.list_bank_account_bindings_v1()) <> 1 then
    raise exception 'READ 9 FAILED: the other member should see only their own binding';
  end if;
  if jsonb_array_length(public.list_my_groups_v1()) <> 0 then
    raise exception 'READ 10 FAILED: a non-member was shown a group';
  end if;
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
end;
$reads$;

-- ---------------------------------------------------------------------------
-- The ledger read path (src/lib/ledger/reader.ts, GET /api/ledger/entries)
--
-- The route does plain selects on ledger_groups, ledger_entries and
-- ledger_entry_postings under the caller's own JWT and relies entirely on RLS for
-- tenant isolation. Everything above runs as the superuser, which bypasses RLS,
-- so none of it could notice a policy that leaks or a grant that is missing.
-- These checks switch to the `authenticated` and `anon` roles, as PostgREST does,
-- and read the rows the route reads.
-- ---------------------------------------------------------------------------
do $ledgerread$
declare
  member_uid constant text := '11111111-1111-4111-8111-111111111111';
  other_uid  constant text := '22222222-2222-4222-8222-222222222222';
  group_a    constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  group_b    uuid;
  cash_b     uuid;
  income_b   uuid;
  n          bigint;
  seq_type   text;
  amt_type   text;
  seq_json   text;
  amt_json   text;
begin
  -- A second tenant: a different user provisions their own group and posts an
  -- entry with a non-round amount, so the numeric rendering below is not
  -- trivially "x.00".
  perform set_config('request.jwt.claim.sub', other_uid, false);
  group_b := (public.sened_ledger_provision_group_v1('Other tenant equb') ->> 'groupId')::uuid;
  select id into cash_b from public.ledger_accounts where group_id = group_b and code = 'POT_CASH';
  select id into income_b from public.ledger_accounts where group_id = group_b and code = 'CONTRIBUTION_INCOME';
  perform public.post_ledger_entry_v1(
    group_b, 'ledger-read-other-tenant', now(), 'contribution', null, null,
    jsonb_build_array(
      jsonb_build_object('accountId', cash_b, 'direction', 'debit', 'amount', '1234.50'),
      jsonb_build_object('accountId', income_b, 'direction', 'credit', 'amount', '1234.50')
    )
  );

  -- Sanity, as the superuser: both groups really have entries and postings, so
  -- the zero-row assertions below cannot pass vacuously.
  select count(*) into n from public.ledger_entries where group_id = group_a;
  if n = 0 then raise exception 'LEDGER READ 0 FAILED: fixture group A has no entries'; end if;
  select count(*) into n from public.ledger_entry_postings where group_id = group_b;
  if n = 0 then raise exception 'LEDGER READ 0 FAILED: fixture group B has no postings'; end if;

  -- ---- A member reads their own group (the reader's three selects) ----------
  perform set_config('request.jwt.claim.sub', member_uid, false);
  set local role authenticated;

  select count(*) into n from public.ledger_groups where id = group_a;
  if n <> 1 then raise exception 'LEDGER READ 1 FAILED: a member could not select their group (saw %)', n; end if;

  select count(*) into n from public.ledger_entries where group_id = group_a;
  if n = 0 then raise exception 'LEDGER READ 2 FAILED: a member saw no entries in their own group'; end if;

  select count(*) into n from public.ledger_entry_postings where group_id = group_a;
  if n = 0 then raise exception 'LEDGER READ 3 FAILED: a member saw no postings in their own group'; end if;

  -- ---- A non-member sees none of another tenant's rows ----------------------
  select count(*) into n from public.ledger_groups where id = group_b;
  if n <> 0 then raise exception 'LEDGER READ 4 FAILED: a non-member saw another tenant''s group (%)', n; end if;
  select count(*) into n from public.ledger_entries where group_id = group_b;
  if n <> 0 then raise exception 'LEDGER READ 5 FAILED: a non-member saw another tenant''s entries (%)', n; end if;
  select count(*) into n from public.ledger_entry_postings where group_id = group_b;
  if n <> 0 then raise exception 'LEDGER READ 6 FAILED: a non-member saw another tenant''s postings (%)', n; end if;

  reset role;

  -- ---- The other tenant, symmetrically --------------------------------------
  perform set_config('request.jwt.claim.sub', other_uid, false);
  set local role authenticated;
  select count(*) into n from public.ledger_entries where group_id = group_b;
  if n = 0 then raise exception 'LEDGER READ 7 FAILED: the other tenant cannot read their own entries'; end if;
  select count(*) into n from public.ledger_entries where group_id = group_a;
  if n <> 0 then raise exception 'LEDGER READ 8 FAILED: the other tenant saw group A entries (%)', n; end if;
  select count(*) into n from public.ledger_entry_postings where group_id = group_a;
  if n <> 0 then raise exception 'LEDGER READ 9 FAILED: the other tenant saw group A postings (%)', n; end if;
  select count(*) into n from public.ledger_groups where id = group_a;
  if n <> 0 then raise exception 'LEDGER READ 10 FAILED: the other tenant saw group A (%)', n; end if;

  -- ---- JSON types as PostgREST renders them ---------------------------------
  -- PostgREST serialises rows with to_json, so jsonb_typeof(to_jsonb(row)) gives
  -- the same answer. reader.ts accepts a number or a string for both fields and
  -- reformats the amount through formatEtbAmount.
  select jsonb_typeof(to_jsonb(e) -> 'sequence'), (to_jsonb(e) -> 'sequence')::text
    into seq_type, seq_json
    from public.ledger_entries e where e.group_id = group_b limit 1;
  select jsonb_typeof(to_jsonb(p) -> 'amount'), (to_jsonb(p) -> 'amount')::text
    into amt_type, amt_json
    from public.ledger_entry_postings p where p.group_id = group_b and p.direction = 'debit' limit 1;
  reset role;

  raise notice 'JSON TYPES: sequence (bigint) -> % (%), amount (numeric(20,2)) -> % (%)',
    seq_type, seq_json, amt_type, amt_json;

  if seq_type not in ('number', 'string') or amt_type not in ('number', 'string') then
    raise exception 'LEDGER READ 11 FAILED: unexpected JSON types for sequence/amount: % / %', seq_type, amt_type;
  end if;
  -- Postgres renders 1234.50 as 1234.50; JavaScript parses it to 1234.5, which
  -- formatEtbAmount re-pads to 1234.50. Either way it is a plain decimal with no
  -- exponent, which is what the parser needs.
  if amt_json !~ '^"?[0-9]+(\.[0-9]{1,2})?"?$' or seq_json !~ '^"?[0-9]+"?$' then
    raise exception 'LEDGER READ 12 FAILED: sequence/amount JSON is not a plain decimal: % / %', seq_json, amt_json;
  end if;

  -- ---- anon sees nothing ----------------------------------------------------
  -- Either zero rows or a permission error counts: no row may come back. Which of
  -- the two it is gets reported, since the route would surface an error as a
  -- storage failure rather than an empty list.
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claim.role', 'anon', false);
  set local role anon;
  begin
    select count(*) into n from public.ledger_entries;
    if n <> 0 then raise exception 'LEDGER READ 13 FAILED: anon read % entries', n; end if;
    raise notice 'ANON: ledger_entries select returned zero rows';
  exception when insufficient_privilege then
    raise notice 'ANON: ledger_entries select refused (permission denied)';
  end;
  begin
    select count(*) into n from public.ledger_entry_postings;
    if n <> 0 then raise exception 'LEDGER READ 14 FAILED: anon read % postings', n; end if;
    raise notice 'ANON: ledger_entry_postings select returned zero rows';
  exception when insufficient_privilege then
    raise notice 'ANON: ledger_entry_postings select refused (permission denied)';
  end;
  begin
    select count(*) into n from public.ledger_groups;
    if n <> 0 then raise exception 'LEDGER READ 15 FAILED: anon read % groups', n; end if;
    raise notice 'ANON: ledger_groups select returned zero rows';
  exception when insufficient_privilege then
    raise notice 'ANON: ledger_groups select refused (permission denied)';
  end;
  reset role;

  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', member_uid, false);
end;
$ledgerread$;

-- ---------------------------------------------------------------------------
-- Posting a correction (src/lib/ledger/repository.ts -> post_ledger_entry_v1)
--
-- POST /api/ledger/entries calls one function, public.post_ledger_entry_v1, as the
-- signed-in user. A correction is an ordinary entry with entry_type 'correction',
-- corrects_entry_id and a rationale. The function itself checks identity, the
-- caller's role in the group (owner or treasurer, from ledger_group_memberships), the idempotency key and shape; the
-- compensating-entry rules (exact reversal, not before the original, one
-- correction per original) live in a DEFERRED constraint trigger, so they fire at
-- commit rather than inside the call. A DO block is a single transaction, so each
-- refusal below calls `set constraints all immediate` after the call, which is
-- exactly what COMMIT would do, and expects the trigger to raise.
--
-- All writes here go through the function as `authenticated`; counts are taken as
-- the superuser, because RLS would otherwise hide the very rows being counted.
-- ---------------------------------------------------------------------------
do $ledgercorrect$
declare
  tre_uid constant text := '11111111-1111-4111-8111-111111111111';  -- owner of group C
  oth_uid constant text := '22222222-2222-4222-8222-222222222222';  -- owns group B, not a member of C
  mem_uid constant text := '33333333-3333-4333-8333-333333333333';  -- plain member of group C
  claims_owner constant text := '{"sub":"11111111-1111-4111-8111-111111111111"}';
  group_c   uuid;
  group_b   uuid;
  cash_c    uuid;
  income_c  uuid;
  filler    jsonb;
  orig      jsonb;
  orig2     jsonb;
  corr      jsonb;
  replay    jsonb;
  fwd       jsonb;
  rev       jsonb;
  rev_wrong_amount jsonb;
  orig_id   uuid;
  orig2_id  uuid;
  names     text[];
  n         bigint;
  e0        bigint;
  p0        bigint;
  h0        bigint;
  e1        bigint;
  p1        bigint;
  head_seq  bigint;
  head_hash text;
begin
  -- ---- Fixture: a fresh group provisioned by the treasurer --------------------
  perform set_config('request.jwt.claim.sub', tre_uid, false);
  perform set_config('request.jwt.claims', claims_owner, false);
  group_c := (public.sened_ledger_provision_group_v1('Correction test equb') ->> 'groupId')::uuid;
  select id into cash_c from public.ledger_accounts where group_id = group_c and code = 'POT_CASH';
  select id into income_c from public.ledger_accounts where group_id = group_c and code = 'CONTRIBUTION_INCOME';
  select group_id into group_b from public.ledger_entries
    where idempotency_key = 'ledger-read-other-tenant' limit 1;

  fwd := jsonb_build_array(
    jsonb_build_object('accountId', cash_c, 'direction', 'debit', 'amount', '500.25'),
    jsonb_build_object('accountId', income_c, 'direction', 'credit', 'amount', '500.25'));
  rev := jsonb_build_array(
    jsonb_build_object('accountId', cash_c, 'direction', 'credit', 'amount', '500.25'),
    jsonb_build_object('accountId', income_c, 'direction', 'debit', 'amount', '500.25'));
  rev_wrong_amount := jsonb_build_array(
    jsonb_build_object('accountId', cash_c, 'direction', 'credit', 'amount', '500.24'),
    jsonb_build_object('accountId', income_c, 'direction', 'debit', 'amount', '500.24'));

  -- ---- Sanity (superuser): the fixture is what the checks below assume --------
  if group_c is null or cash_c is null or income_c is null then
    raise exception 'LEDGER CORRECT 0 FAILED: fixture group or accounts missing';
  end if;
  if group_b is null then
    raise exception 'LEDGER CORRECT 0 FAILED: the other tenant''s group from the read checks is missing';
  end if;
  select count(*) into n from public.ledger_entries where group_id = group_c;
  if n <> 0 then raise exception 'LEDGER CORRECT 0 FAILED: group C should start empty, has % entries', n; end if;

  -- The RPC's parameter names are what PostgREST binds a JSON body to. If the
  -- application sends different names the call never reaches the function.
  select proargnames into names from pg_proc
    where proname = 'post_ledger_entry_v1' and pronamespace = 'public'::regnamespace;
  raise notice 'post_ledger_entry_v1 argument names: %', names;
  if names is distinct from array[
       'requested_group_id', 'requested_idempotency_key', 'requested_occurred_at',
       'requested_entry_type', 'requested_corrects_entry_id', 'requested_rationale',
       'requested_postings'] then
    raise exception 'LEDGER CORRECT 0 FAILED: unexpected argument names %', names;
  end if;

  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status)
  values (group_c, tre_uid::uuid, mem_uid::uuid, 'member', 'active');

  -- ---- Three plain entries as the treasurer (named notation, as PostgREST) ----
  set local role authenticated;
  filler := public.post_ledger_entry_v1(
    requested_group_id => group_c, requested_idempotency_key => 'corr-filler',
    requested_occurred_at => '2026-01-05T09:00:00Z', requested_entry_type => 'contribution',
    requested_corrects_entry_id => null, requested_rationale => null, requested_postings => fwd);
  orig := public.post_ledger_entry_v1(
    group_c, 'corr-original', '2026-01-10T10:00:00Z', 'contribution', null, null, fwd);
  orig2 := public.post_ledger_entry_v1(
    group_c, 'corr-original-2', '2026-02-01T10:00:00Z', 'contribution', null, null, fwd);
  reset role;
  orig_id := (orig -> 'entry' ->> 'id')::uuid;
  orig2_id := (orig2 -> 'entry' ->> 'id')::uuid;

  select count(*) into n from public.ledger_entries where group_id = group_c;
  if n <> 3 then raise exception 'LEDGER CORRECT 0 FAILED: expected 3 plain entries, found %', n; end if;
  select count(*) into n from public.ledger_entry_postings where entry_id = orig_id;
  if n <> 2 then raise exception 'LEDGER CORRECT 0 FAILED: the original should have 2 postings, has %', n; end if;
  -- A deferred trigger that never fires would make every refusal below vacuous
  -- in the other direction, so prove the trigger really is deferred and live.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'ledger_entries_validate_at_commit' and tgdeferrable and tginitdeferred
  ) then
    raise exception 'LEDGER CORRECT 0 FAILED: the correction validation trigger is not a deferred constraint trigger';
  end if;

  -- ---- Refusals against an UNCORRECTED original (E2) --------------------------
  select count(*) into e0 from public.ledger_entries;
  select count(*) into p0 from public.ledger_entry_postings;
  select count(*) into h0 from public.ledger_group_heads where last_sequence > 0;
  select last_sequence into head_seq from public.ledger_group_heads where group_id = group_c;
  if head_seq <> 3 then raise exception 'LEDGER CORRECT 0 FAILED: head should be at sequence 3, is %', head_seq; end if;

  set local role authenticated;

  -- 5a. Wrong amount.
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-wrong-amount', '2026-03-02T10:00:00Z',
      'correction', orig2_id, 'Amount typed wrong in error', rev_wrong_amount);
    set constraints all immediate;
    raise exception 'LEDGER CORRECT 5 FAILED: a correction with the wrong amount was ACCEPTED';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_invalid_correction_amounts%' then
      raise exception 'LEDGER CORRECT 5 FAILED: wrong rejection reason for a wrong amount: %', sqlerrm;
    end if;
    raise notice 'CORRECT 5a: wrong amount refused (%)', sqlerrm;
  end;
  set constraints all deferred;

  -- 5b. Wrong direction: same sides as the original, so balanced but not reversed.
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-wrong-direction', '2026-03-02T10:00:00Z',
      'correction', orig2_id, 'Direction not flipped by mistake', fwd);
    set constraints all immediate;
    raise exception 'LEDGER CORRECT 5 FAILED: a correction that is not reversed was ACCEPTED';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_invalid_correction_amounts%' then
      raise exception 'LEDGER CORRECT 5 FAILED: wrong rejection reason for a wrong direction: %', sqlerrm;
    end if;
    raise notice 'CORRECT 5b: wrong direction refused (%)', sqlerrm;
  end;
  set constraints all deferred;

  -- 6. Dated before the original (E2 occurred 2026-02-01), otherwise an exact reversal.
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-predated', '2026-01-15T10:00:00Z',
      'correction', orig2_id, 'Dated before the original entry', rev);
    set constraints all immediate;
    raise exception 'LEDGER CORRECT 6 FAILED: a correction dated before its original was ACCEPTED';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_invalid_correction_time%' then
      raise exception 'LEDGER CORRECT 6 FAILED: wrong rejection reason for a predated correction: %', sqlerrm;
    end if;
    raise notice 'CORRECT 6: predated correction refused (%)', sqlerrm;
  end;
  set constraints all deferred;

  -- A correction that targets nothing real (random id) is refused too.
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-ghost-target', '2026-03-02T10:00:00Z',
      'correction', gen_random_uuid(), 'Targets an entry that is not there', rev);
    set constraints all immediate;
    raise exception 'LEDGER CORRECT 6 FAILED: a correction of a nonexistent entry was ACCEPTED';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    raise notice 'CORRECT 6b: nonexistent target refused (%)', sqlerrm;
  end;
  set constraints all deferred;

  reset role;
  select count(*) into e1 from public.ledger_entries;
  select count(*) into p1 from public.ledger_entry_postings;
  if e1 <> e0 or p1 <> p0 then
    raise exception 'LEDGER CORRECT 5/6 FAILED: refusals changed row counts (entries % -> %, postings % -> %)', e0, e1, p0, p1;
  end if;
  select last_sequence into head_seq from public.ledger_group_heads where group_id = group_c;
  if head_seq <> 3 then raise exception 'LEDGER CORRECT 5/6 FAILED: refusals advanced the head to %', head_seq; end if;

  -- ---- 1. A correct correction: exact reversal of the original ----------------
  set local role authenticated;
  corr := public.post_ledger_entry_v1(group_c, 'corr-ok', '2026-03-01T10:00:00Z',
    'correction', orig_id, 'Posted to the wrong account', rev);
  set constraints all immediate;   -- what COMMIT does; raises if the reversal is wrong
  set constraints all deferred;
  reset role;

  if corr ->> 'replayed' <> 'false' then
    raise exception 'LEDGER CORRECT 1 FAILED: a first post reported replayed = %', corr ->> 'replayed';
  end if;
  if corr -> 'entry' ->> 'entryType' <> 'correction'
     or (corr -> 'entry' ->> 'correctsEntryId')::uuid <> orig_id then
    raise exception 'LEDGER CORRECT 1 FAILED: the stored entry is not a correction of the original: %', corr -> 'entry';
  end if;
  select count(*) into n
  from public.ledger_entry_postings c
  join public.ledger_entry_postings o
    on o.account_id = c.account_id and o.amount = c.amount and o.direction <> c.direction
  where c.entry_id = (corr -> 'entry' ->> 'id')::uuid and o.entry_id = orig_id;
  if n <> 2 then
    raise exception 'LEDGER CORRECT 1 FAILED: stored postings are not the exact reverse (% of 2 pairs matched)', n;
  end if;
  select count(*) into n from public.ledger_entry_postings where entry_id = (corr -> 'entry' ->> 'id')::uuid;
  if n <> 2 then raise exception 'LEDGER CORRECT 1 FAILED: the correction has % postings, expected 2', n; end if;
  raise notice 'CORRECT 1: correction % reverses % (sequence %)',
    corr -> 'entry' ->> 'id', orig_id, corr -> 'entry' ->> 'sequence';

  -- ---- 9. Hash chain and sequence ---------------------------------------------
  -- The entry just before the correction is E2 (sequence 3).
  if (corr -> 'entry' ->> 'sequence') <> '4' then
    raise exception 'LEDGER CORRECT 9 FAILED: correction sequence is %, expected 4', corr -> 'entry' ->> 'sequence';
  end if;
  if corr -> 'entry' ->> 'previousHash' <> orig2 -> 'entry' ->> 'entryHash' then
    raise exception 'LEDGER CORRECT 9 FAILED: previous_hash does not equal the prior entry''s entry_hash';
  end if;
  if corr -> 'entry' ->> 'entryHash' = orig2 -> 'entry' ->> 'entryHash' then
    raise exception 'LEDGER CORRECT 9 FAILED: the correction reused the prior entry hash';
  end if;
  select last_sequence, last_hash into head_seq, head_hash
    from public.ledger_group_heads where group_id = group_c;
  if head_seq <> 4 or head_hash <> corr -> 'entry' ->> 'entryHash' then
    raise exception 'LEDGER CORRECT 9 FAILED: head is (%, %), expected (4, correction hash)', head_seq, head_hash;
  end if;
  -- Whole chain: sequences are 1..4 with no gap, each previous_hash is the prior hash.
  select count(*) into n from (
    select sequence, previous_hash,
           lag(entry_hash, 1, repeat('0', 64)) over (order by sequence) as expected_prev,
           lag(sequence, 1, 0::bigint) over (order by sequence) as prev_seq
    from public.ledger_entries where group_id = group_c
  ) chain
  where chain.previous_hash <> chain.expected_prev or chain.sequence <> chain.prev_seq + 1;
  if n <> 0 then raise exception 'LEDGER CORRECT 9 FAILED: % entries break the hash chain or sequence', n; end if;

  select count(*) into e0 from public.ledger_entries;
  select count(*) into p0 from public.ledger_entry_postings;

  set local role authenticated;

  -- ---- 2. Replay: same key, same payload --------------------------------------
  replay := public.post_ledger_entry_v1(group_c, 'corr-ok', '2026-03-01T10:00:00Z',
    'correction', orig_id, 'Posted to the wrong account', rev);
  if replay ->> 'replayed' <> 'true' then
    raise exception 'LEDGER CORRECT 2 FAILED: a replay reported replayed = %', replay ->> 'replayed';
  end if;
  if replay -> 'entry' ->> 'id' <> corr -> 'entry' ->> 'id'
     or replay -> 'entry' ->> 'entryHash' <> corr -> 'entry' ->> 'entryHash'
     or replay -> 'entry' -> 'postings' is distinct from corr -> 'entry' -> 'postings' then
    raise exception 'LEDGER CORRECT 2 FAILED: the replay did not return the original result';
  end if;

  -- ---- 3. Same key, different payload -----------------------------------------
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-ok', '2026-03-01T10:00:00Z',
      'correction', orig_id, 'A different rationale entirely', rev);
    raise exception 'LEDGER CORRECT 3 FAILED: a changed payload under the same key was ACCEPTED';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_idempotency_conflict%' then
      raise exception 'LEDGER CORRECT 3 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-ok', '2026-03-01T10:00:00Z',
      'correction', orig_id, 'Posted to the wrong account', rev_wrong_amount);
    raise exception 'LEDGER CORRECT 3 FAILED: changed postings under the same key were ACCEPTED';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_idempotency_conflict%' then
      raise exception 'LEDGER CORRECT 3 FAILED: wrong rejection reason (postings): %', sqlerrm;
    end if;
  end;

  -- ---- 4. A second correction of the same original, new key -------------------
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-second', '2026-03-05T10:00:00Z',
      'correction', orig_id, 'Trying to correct it twice', rev);
    set constraints all immediate;
    raise exception 'LEDGER CORRECT 4 FAILED: a second correction of the same original was ACCEPTED';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_entries_one_correction_per_original_idx%'
       and sqlerrm not like '%ledger_invalid_correction_duplicate%' then
      raise exception 'LEDGER CORRECT 4 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
    raise notice 'CORRECT 4: second correction refused (%)', sqlerrm;
  end;
  set constraints all deferred;

  -- ---- 7. Authorization --------------------------------------------------------
  -- 7a. A plain member of the group. No JWT in this file carries an app_metadata
  -- role (roles live in ledger_group_memberships), so the member's own role in
  -- the group is the only thing that can refuse this.
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims',
    '{"sub":"33333333-3333-4333-8333-333333333333"}', false);
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-member', now(), 'contribution', null, null, fwd);
    raise exception 'LEDGER CORRECT 7 FAILED: a plain member posted an entry';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'LEDGER CORRECT 7 FAILED: member refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  -- 7b. The same member again, with an explicitly empty app_metadata.
  perform set_config('request.jwt.claims',
    '{"sub":"33333333-3333-4333-8333-333333333333","app_metadata":{}}', false);
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-member-2', now(), 'contribution', null, null, fwd);
    raise exception 'LEDGER CORRECT 7 FAILED: a plain member posted an entry (empty app_metadata)';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'LEDGER CORRECT 7 FAILED: role-less member refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  -- 7d. A treasurer of another tenant (owner of group B, no membership in C).
  perform set_config('request.jwt.claim.sub', oth_uid, false);
  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-4222-8222-222222222222"}', false);
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-outsider', now(), 'contribution', null, null, fwd);
    raise exception 'LEDGER CORRECT 7 FAILED: a non-member of another tenant posted into group C';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'LEDGER CORRECT 7 FAILED: outsider refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  -- ...and cannot correct group C's entry either, even naming the right ids.
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-outsider-2', '2026-04-01T10:00:00Z',
      'correction', orig2_id, 'Outsider tries to correct it', rev);
    raise exception 'LEDGER CORRECT 7 FAILED: a non-member posted a correction into group C';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'LEDGER CORRECT 7 FAILED: outsider correction refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  -- 7e. The group C owner cannot write into the other tenant's group B.
  perform set_config('request.jwt.claim.sub', tre_uid, false);
  perform set_config('request.jwt.claims', claims_owner, false);
  begin
    perform public.post_ledger_entry_v1(group_b, 'corr-cross-tenant', now(), 'contribution', null, null, fwd);
    raise exception 'LEDGER CORRECT 7 FAILED: the owner of group C wrote into group B';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'LEDGER CORRECT 7 FAILED: cross-tenant write refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  -- 7f. Authenticated role but no subject at all.
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false);
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-nosub', now(), 'contribution', null, null, fwd);
    raise exception 'LEDGER CORRECT 7 FAILED: a request with no subject posted an entry';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'LEDGER CORRECT 7 FAILED: subject-less request refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;

  -- ---- 8. anon -------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claim.role', 'anon', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  set local role anon;
  begin
    perform public.post_ledger_entry_v1(group_c, 'corr-anon', now(), 'contribution', null, null, fwd);
    raise exception 'LEDGER CORRECT 8 FAILED: anon posted an entry';
  exception when others then
    if sqlerrm like 'LEDGER CORRECT%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'LEDGER CORRECT 8 FAILED: anon refused for the wrong reason: %', sqlerrm;
    end if;
    raise notice 'CORRECT 8: anon refused (%)', sqlerrm;
  end;
  reset role;

  -- ---- Nothing written by any refusal after the correction ----------------------
  select count(*) into e1 from public.ledger_entries;
  select count(*) into p1 from public.ledger_entry_postings;
  if e1 <> e0 or p1 <> p0 then
    raise exception 'LEDGER CORRECT 2-8 FAILED: replay/refusals changed row counts (entries % -> %, postings % -> %)', e0, e1, p0, p1;
  end if;
  select last_sequence, last_hash into head_seq, head_hash
    from public.ledger_group_heads where group_id = group_c;
  if head_seq <> 4 or head_hash <> corr -> 'entry' ->> 'entryHash' then
    raise exception 'LEDGER CORRECT 2-8 FAILED: a refusal or replay moved the chain head to (%, %)', head_seq, head_hash;
  end if;
  select count(*) into n from public.ledger_entries
    where group_id in (group_c, group_b) and idempotency_key like 'corr-%' and idempotency_key not in
      ('corr-filler', 'corr-original', 'corr-original-2', 'corr-ok');
  if n <> 0 then raise exception 'LEDGER CORRECT 7 FAILED: % rows were written under a refused key', n; end if;

  -- ---- Restore the session identity the rest of the file expects ----------------
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', tre_uid, false);
  perform set_config('request.jwt.claims', claims_owner, false);
  raise notice 'LEDGER CORRECT: all 9 correction checks passed';
end;
$ledgercorrect$;

-- ---------------------------------------------------------------------------
-- Per-group roles, with NO app_metadata on any JWT
--
-- Write authorization is the caller's role in the group, read from
-- ledger_group_memberships inside the security-definer functions. Whoever
-- provisions a group is its owner; the owner grants and clears the treasurer role
-- with sened_ledger_set_member_role_v1. Every claim set below omits
-- app_metadata.role (one case sets it to "owner" on a plain member to prove it is
-- ignored). All calls run as `authenticated`, as PostgREST does.
--
--   owner  1111  provisions the group
--   member 3333  added as a plain member
--   other  4444  never a member
--   other  2222  never a member (owns another group)
-- ---------------------------------------------------------------------------
do $roles$
declare
  own_uid constant text := '11111111-1111-4111-8111-111111111111';
  mem_uid constant text := '33333333-3333-4333-8333-333333333333';
  out_uid constant text := '44444444-4444-4444-8444-444444444444';
  oth_uid constant text := '22222222-2222-4222-8222-222222222222';
  group_r  uuid;
  cash_r   uuid;
  income_r uuid;
  fwd      jsonb;
  res      jsonb;
  n        bigint;
  bind_id  constant uuid := 'abababab-0000-4000-8000-0000000000f1';
  member_role text;
begin
  -- Fixture (owner provisions; superuser for setup).
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  group_r := (public.sened_ledger_provision_group_v1('Roles test equb') ->> 'groupId')::uuid;
  reset role;
  select id into cash_r from public.ledger_accounts where group_id = group_r and code = 'POT_CASH';
  select id into income_r from public.ledger_accounts where group_id = group_r and code = 'CONTRIBUTION_INCOME';
  fwd := jsonb_build_array(
    jsonb_build_object('accountId', cash_r, 'direction', 'debit', 'amount', '10.00'),
    jsonb_build_object('accountId', income_r, 'direction', 'credit', 'amount', '10.00'));

  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status)
  values (group_r, own_uid::uuid, mem_uid::uuid, 'member', 'active');
  insert into public.bank_account_bindings (
    id, user_id, group_id, tenant_id, ledger_account_id, provider, currency,
    account_label, account_fingerprint_hmac, sender_fingerprint_hmac,
    receiver_fingerprint_hmac, active
  ) values (
    bind_id, mem_uid::uuid, group_r, own_uid::uuid, cash_r, 'telebirr', 'ETB',
    'Roles test binding', repeat('1', 64), repeat('2', 64), repeat('3', 64), true);

  -- ROLES 1. The provisioner is the owner, and can post.
  select role into member_role from public.ledger_group_memberships
    where group_id = group_r and user_id = own_uid::uuid;
  if member_role is distinct from 'owner' then
    raise exception 'ROLES 1 FAILED: the provisioner is % not owner', member_role;
  end if;
  set local role authenticated;
  res := public.post_ledger_entry_v1(group_r, 'roles-owner-1', now(), 'contribution', null, null, fwd);
  reset role;
  if res -> 'entry' ->> 'sequence' is null then
    raise exception 'ROLES 1 FAILED: the owner could not post';
  end if;

  -- ROLES 2. A plain member is refused (ledger and bank), even with a JWT that
  -- claims role "owner" - the claim is not consulted.
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '","app_metadata":{"role":"owner"}}', false);
  set local role authenticated;
  begin
    perform public.post_ledger_entry_v1(group_r, 'roles-member-1', now(), 'contribution', null, null, fwd);
    raise exception 'ROLES 2 FAILED: a plain member posted';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'ROLES 2 FAILED: member refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.create_bank_verification_intent_v1(
      bind_id, 'telebirr', repeat('a', 64), repeat('c', 24), 'v1', 100.00, 'ETB',
      'inbound', now(), 'roles-bank-member');
    raise exception 'ROLES 2 FAILED: a plain member created a bank verification intent';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%bank_forbidden%' then
      raise exception 'ROLES 2 FAILED: member refused for the wrong reason (bank): %', sqlerrm;
    end if;
  end;
  reset role;

  -- ROLES 3. A non-owner cannot promote: the plain member (self), and an outsider.
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'treasurer');
    raise exception 'ROLES 3 FAILED: a member promoted themselves';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'ROLES 3 FAILED: self-promotion refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', oth_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || oth_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'treasurer');
    raise exception 'ROLES 3 FAILED: an outsider promoted a member';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'ROLES 3 FAILED: outsider refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;
  select role into member_role from public.ledger_group_memberships
    where group_id = group_r and user_id = mem_uid::uuid;
  if member_role <> 'member' then
    raise exception 'ROLES 3 FAILED: the member''s role moved to % after refused promotions', member_role;
  end if;

  -- ROLES 4. The owner promotes the member; the member can now post and create a
  -- bank intent. Promoting again is a no-op.
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  res := public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'treasurer');
  if res ->> 'role' <> 'treasurer' or (res ->> 'changed')::boolean is not true then
    raise exception 'ROLES 4 FAILED: unexpected promotion result %', res;
  end if;
  res := public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'treasurer');
  if (res ->> 'changed')::boolean is not false then
    raise exception 'ROLES 4 FAILED: a repeated promotion reported a change: %', res;
  end if;
  reset role;
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '"}', false);
  set local role authenticated;
  res := public.post_ledger_entry_v1(group_r, 'roles-treasurer-1', now(), 'contribution', null, null, fwd);
  if res -> 'entry' ->> 'sequence' is null then
    raise exception 'ROLES 4 FAILED: the promoted treasurer could not post';
  end if;
  res := public.create_bank_verification_intent_v1(
    bind_id, 'telebirr', repeat('a', 64), repeat('c', 24), 'v1', 100.00, 'ETB',
    'inbound', now(), 'roles-bank-treasurer');
  if res is null then
    raise exception 'ROLES 4 FAILED: the promoted treasurer could not create a bank intent';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(public.list_my_groups_v1()) g
    where g ->> 'groupId' = group_r::text and g ->> 'role' = 'treasurer'
  ) then
    raise exception 'ROLES 4 FAILED: list_my_groups_v1 does not report the treasurer role';
  end if;
  -- A treasurer is not an owner: cannot hand out roles.
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, own_uid::uuid, 'member');
    raise exception 'ROLES 4 FAILED: a treasurer changed the owner''s role';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'ROLES 4 FAILED: treasurer role change refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;

  -- ROLES 5. The owner demotes; the former treasurer is refused again.
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  res := public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'member');
  if res ->> 'role' <> 'member' or (res ->> 'changed')::boolean is not true then
    raise exception 'ROLES 5 FAILED: unexpected demotion result %', res;
  end if;
  res := public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'member');
  if (res ->> 'changed')::boolean is not false then
    raise exception 'ROLES 5 FAILED: a repeated demotion reported a change: %', res;
  end if;
  reset role;
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.post_ledger_entry_v1(group_r, 'roles-demoted-1', now(), 'contribution', null, null, fwd);
    raise exception 'ROLES 5 FAILED: a demoted treasurer posted';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'ROLES 5 FAILED: demoted treasurer refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.create_bank_verification_intent_v1(
      bind_id, 'telebirr', repeat('b', 64), repeat('c', 24), 'v1', 100.00, 'ETB',
      'inbound', now(), 'roles-bank-demoted');
    raise exception 'ROLES 5 FAILED: a demoted treasurer created a bank intent';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%bank_forbidden%' then
      raise exception 'ROLES 5 FAILED: demoted treasurer refused for the wrong reason (bank): %', sqlerrm;
    end if;
  end;
  reset role;

  -- ROLES 6. An outsider cannot be promoted: no membership is created. The owner
  -- also cannot demote themselves, or assign ownership.
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, out_uid::uuid, 'treasurer');
    raise exception 'ROLES 6 FAILED: an outsider was promoted';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_member_not_found%' then
      raise exception 'ROLES 6 FAILED: outsider promotion refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, own_uid::uuid, 'member');
    raise exception 'ROLES 6 FAILED: the owner demoted themselves';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_invalid_request%' then
      raise exception 'ROLES 6 FAILED: self-demotion refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'owner');
    raise exception 'ROLES 6 FAILED: ownership was assigned through the role function';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_invalid_request%' then
      raise exception 'ROLES 6 FAILED: owner assignment refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.sened_ledger_set_member_role_v1(gen_random_uuid(), mem_uid::uuid, 'treasurer');
    raise exception 'ROLES 6 FAILED: a role was set in a group that does not exist';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_group_not_found%' then
      raise exception 'ROLES 6 FAILED: missing group refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;
  select count(*) into n from public.ledger_group_memberships
    where group_id = group_r and user_id = out_uid::uuid;
  if n <> 0 then raise exception 'ROLES 6 FAILED: a membership was created for the outsider'; end if;
  select role into member_role from public.ledger_group_memberships
    where group_id = group_r and user_id = own_uid::uuid;
  if member_role <> 'owner' then
    raise exception 'ROLES 6 FAILED: the owner''s role is now %', member_role;
  end if;

  -- ROLES 7. No session, and anon, cannot change roles.
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false);
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'treasurer');
    raise exception 'ROLES 7 FAILED: a request with no subject changed a role';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'ROLES 7 FAILED: subject-less request refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.role', 'anon', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  set local role anon;
  begin
    perform public.sened_ledger_set_member_role_v1(group_r, mem_uid::uuid, 'treasurer');
    raise exception 'ROLES 7 FAILED: anon changed a role';
  exception when others then
    if sqlerrm like 'ROLES%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'ROLES 7 FAILED: anon refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;

  -- Restore the session identity the rest of the file expects.
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  raise notice 'ROLES: all 7 per-group role checks passed';
end;
$roles$;

select 'ALL DRAW BINDING CHECKS PASSED' as result;
