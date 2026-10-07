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
    3000.00, 8, 1000, 'verify-honest-round-1', now(), 'v3'
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
    3000.00, 8, 1000, 'verify-forged-round-2', now(), 'v3'
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
    3000.00, 8, 1000, 'verify-order-c2-round-1', now(), 'v3'
  );
  perform public.commit_draw_v1(
    'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
    'aaaaaaaa-0000-4000-8000-0000000000c2'::uuid,
    2, 'eeeeeeee-0000-4000-8000-000000000002'::uuid,
    repeat('d2', 32), repeat('r2', 32), repeat('e2', 32),
    pg_temp.member_digest(), pg_temp.member_set(), pg_temp.roster(),
    3000.00, 8, 1000, 'verify-order-c2-round-2', now(), 'v3'
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
      5000.00, 5, 1000, 'rpc-empty-member-set', now(), 'v3'
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
      null, null, '[]'::jsonb, 5000.00, 5, 1000, 'rpc-null-member-set', now(), 'v3'
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
    5000.00, 5, 1000, 'rpc-honest-member-set', now(), 'v3'
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
      and pg_proc.pronargs <> 16
  ) then
    raise exception 'RPC 6 FAILED: an old commit_draw_v1 arity still exists';
  end if;

  -- 20261005100000_draw_cycles_and_member_seals.sql takes commit_draw_v1 away
  -- from clients: it accepted a sealed set from the caller, which is exactly what
  -- the stored seals replace. It stays callable by the database owner (this
  -- harness) so the pre-session checks above still run.
  if has_function_privilege(
    'authenticated',
    'public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz, text)',
    'EXECUTE'
  ) then
    raise exception 'RPC 7 FAILED: authenticated can still execute the client-seals commit_draw_v1';
  end if;

  if has_function_privilege(
    'anon',
    'public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz, text)',
    'EXECUTE'
  ) then
    raise exception 'RPC 8 FAILED: anon can execute commit_draw_v1';
  end if;
end;
$rpc$;

-- ---------------------------------------------------------------------------
-- Draw protocol v3 (20261004100000_draw_protocol_v3.sql)
--
-- v2 selected the winner from values the treasurer knew before committing, so the
-- treasurer could grind the seed. v3 folds the revealed member nonces into the
-- winner. The database's part: pin the protocol version at commit time, refuse a
-- new v2 commitment even through a direct RPC call, publish the version for the
-- verifier, and require a v3 reveal to open exactly the sealed set of members.
-- ---------------------------------------------------------------------------
do $proto$
declare
  group_uuid constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  cycle_uuid constant uuid := 'aaaaaaaa-0000-4000-8000-0000000000c1';
  member_a constant text := '44444444-4444-4444-8444-444444444444';
  member_b constant text := '55555555-5555-4555-8555-555555555555';
  two_sealed jsonb := jsonb_build_array(
    jsonb_build_object('memberId', member_a, 'sealed', repeat('c', 64)),
    jsonb_build_object('memberId', member_b, 'sealed', repeat('d', 64))
  );
  response jsonb;
begin
  -- A new v2 commitment is refused by the function, not just the application.
  begin
    perform public.commit_draw_v1(
      group_uuid, cycle_uuid, 3, 'cccccccc-0000-4000-8000-000000000020'::uuid,
      repeat('a', 64), 'nonce-0123456789abcdef-XYZ', repeat('b', 64),
      repeat('e', 64), two_sealed, '[]'::jsonb,
      5000.00, 5, 1000, 'proto-v2-refused', now(), 'v2'
    );
    raise exception 'PROTO 1 FAILED: commit_draw_v1 ACCEPTED a new v2 commitment';
  exception when others then
    if sqlerrm not like '%draw_protocol_version_unsupported%' then
      raise exception 'PROTO 1 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A missing version is refused too, not defaulted to something weaker.
  begin
    perform public.commit_draw_v1(
      group_uuid, cycle_uuid, 3, 'cccccccc-0000-4000-8000-000000000021'::uuid,
      repeat('a', 64), 'nonce-0123456789abcdef-XYZ', repeat('b', 64),
      repeat('e', 64), two_sealed, '[]'::jsonb,
      5000.00, 5, 1000, 'proto-null-refused', now(), null
    );
    raise exception 'PROTO 2 FAILED: commit_draw_v1 ACCEPTED a null protocol version';
  exception when others then
    if sqlerrm not like '%draw_protocol_version_unsupported%' then
      raise exception 'PROTO 2 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A v3 commitment is stored as v3 and the response publishes it.
  response := public.commit_draw_v1(
    group_uuid, cycle_uuid, 3, 'cccccccc-0000-4000-8000-000000000022'::uuid,
    repeat('a', 64), 'nonce-0123456789abcdef-XYZ', repeat('b', 64),
    repeat('e', 64), two_sealed, '[]'::jsonb,
    5000.00, 5, 1000, 'proto-v3-accepted', now(), 'v3'
  );
  if not exists (
    select 1 from public.draw_commitments
    where idempotency_key = 'proto-v3-accepted' and protocol_version = 'v3'
  ) then
    raise exception 'PROTO 3 FAILED: the v3 commitment was not stored as v3';
  end if;
  if response -> 'round' -> 'commitment' ->> 'protocolVersion' is distinct from 'v3' then
    raise exception 'PROTO 4 FAILED: the round response does not publish protocolVersion: %', response;
  end if;

  -- Replaying the same key under the grindable version is refused, not swapped in.
  begin
    perform public.commit_draw_v1(
      group_uuid, cycle_uuid, 3, 'cccccccc-0000-4000-8000-000000000022'::uuid,
      repeat('a', 64), 'nonce-0123456789abcdef-XYZ', repeat('b', 64),
      repeat('e', 64), two_sealed, '[]'::jsonb,
      5000.00, 5, 1000, 'proto-v3-accepted', now(), 'v2'
    );
    raise exception 'PROTO 5 FAILED: a replay under a different protocol version was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_protocol_version_unsupported%' then
      raise exception 'PROTO 5 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- The version column only admits known versions.
  begin
    insert into public.draw_commitments (
      draw_id, group_id, tenant_id, cycle_id, round, commitment, commitment_nonce,
      member_digest, member_commitments, roster_digest, participants, pot_amount,
      total_rounds, reserve_ratio_bps, actor_id, idempotency_key, protocol_version
    ) values (
      'cccccccc-0000-4000-8000-000000000023', group_uuid, 'bbbbbbbb-0000-4000-8000-000000000001',
      cycle_uuid, 4, repeat('a', 64), 'nonce-0123456789abcdef-XYZ', repeat('e', 64),
      two_sealed, repeat('b', 64), '[]'::jsonb, 5000.00, 5, 1000,
      '11111111-1111-4111-8111-111111111111', 'proto-unknown-version', 'v9'
    );
    raise exception 'PROTO 6 FAILED: an unknown protocol version was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_commitments_protocol_version_known%' then
      raise exception 'PROTO 6 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A v3 reveal must open exactly the sealed members. The count matches here
  -- (two for two), so only the set check can catch each of these.
  --
  -- The same member opened twice hides that the other was never opened, which is
  -- precisely the unknown the treasurer cannot grind over.
  begin
    perform public.reveal_draw_v1(
      'cccccccc-0000-4000-8000-000000000022'::uuid,
      'reveal-seed-0123456789', repeat('a', 64), repeat('e', 64),
      jsonb_build_array(
        jsonb_build_object('memberId', member_a, 'nonce', repeat('m', 24)),
        jsonb_build_object('memberId', member_a, 'nonce', repeat('m', 24))
      ),
      repeat('f', 64), repeat('a', 64), 0, member_a::uuid, repeat('c', 64),
      5000.00, 0.00, now()
    );
    raise exception 'PROTO 7 FAILED: a v3 reveal opening the same member twice was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_member_commitment_missing%' then
      raise exception 'PROTO 7 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- An outsider standing in for a sealed member.
  begin
    perform public.reveal_draw_v1(
      'cccccccc-0000-4000-8000-000000000022'::uuid,
      'reveal-seed-0123456789', repeat('a', 64), repeat('e', 64),
      jsonb_build_array(
        jsonb_build_object('memberId', member_a, 'nonce', repeat('m', 24)),
        jsonb_build_object('memberId', '99999999-9999-4999-8999-999999999999', 'nonce', repeat('m', 24))
      ),
      repeat('f', 64), repeat('a', 64), 0, member_a::uuid, repeat('c', 64),
      5000.00, 0.00, now()
    );
    raise exception 'PROTO 8 FAILED: a v3 reveal with an outsider nonce was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_member_commitment_missing%' then
      raise exception 'PROTO 8 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;

  -- A nonce too short to carry entropy.
  begin
    perform public.reveal_draw_v1(
      'cccccccc-0000-4000-8000-000000000022'::uuid,
      'reveal-seed-0123456789', repeat('a', 64), repeat('e', 64),
      jsonb_build_array(
        jsonb_build_object('memberId', member_a, 'nonce', 'short'),
        jsonb_build_object('memberId', member_b, 'nonce', repeat('m', 24))
      ),
      repeat('f', 64), repeat('a', 64), 0, member_a::uuid, repeat('c', 64),
      5000.00, 0.00, now()
    );
    raise exception 'PROTO 9 FAILED: a v3 reveal with a short nonce was ACCEPTED';
  exception when others then
    if sqlerrm not like '%draw_member_commitment_mismatch%' then
      raise exception 'PROTO 9 FAILED: wrong rejection reason: %', sqlerrm;
    end if;
  end;
end;
$proto$;

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

-- ---------------------------------------------------------------------------
-- INVITES: invite links add members, safely.
-- ---------------------------------------------------------------------------
do $invites$
declare
  own_uid constant text := '11111111-1111-4111-8111-111111111111';
  mem_uid constant text := '33333333-3333-4333-8333-333333333333';
  out_uid constant text := '44444444-4444-4444-8444-444444444444';
  group_i uuid;
  res jsonb;
  tok text;
  tok2 text;
  tok3 text;
  revoked_tok text;
  inv_id uuid;
  inv_id2 uuid;
  n bigint;
  r text;
begin
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  group_i := (public.sened_ledger_provision_group_v1('Invites test equb') ->> 'groupId')::uuid;

  -- INVITES 1. Only the owner can create; the raw token comes back once.
  res := public.create_group_invite_v1(group_i, 24, 1);
  tok := res ->> 'token';
  inv_id := (res ->> 'inviteId')::uuid;
  if tok is null or char_length(tok) <> 64 then
    raise exception 'INVITES 1 FAILED: no raw token returned: %', res;
  end if;
  reset role;
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.create_group_invite_v1(group_i, 24, 1);
    raise exception 'INVITES 1 FAILED: a non-member created an invite';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'INVITES 1 FAILED: refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.create_group_invite_v1(group_i, 721, 1);
    raise exception 'INVITES 1 FAILED: a 31 day invite was created';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_invalid_request%' then
      raise exception 'INVITES 1 FAILED: expiry bound refused wrongly: %', sqlerrm;
    end if;
  end;
  begin
    perform public.create_group_invite_v1(group_i, 24, 51);
    raise exception 'INVITES 1 FAILED: 51 uses allowed';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_invalid_request%' then
      raise exception 'INVITES 1 FAILED: max_uses bound refused wrongly: %', sqlerrm;
    end if;
  end;
  reset role;

  -- INVITES 2. The raw token is not stored in the invites table.
  select count(*) into n from public.ledger_group_invites i
    where to_jsonb(i)::text like '%' || tok || '%';
  if n <> 0 then raise exception 'INVITES 2 FAILED: the raw token is stored'; end if;
  select count(*) into n from public.ledger_group_invites i
    where i.id = inv_id and i.token_hash = encode(sha256(convert_to(tok, 'UTF8')), 'hex');
  if n <> 1 then raise exception 'INVITES 2 FAILED: the stored value is not the SHA-256 of the token'; end if;

  -- INVITES 3. Redeem adds a member.
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '"}', false);
  set local role authenticated;
  res := public.redeem_group_invite_v1(tok);
  reset role;
  if res ->> 'status' <> 'joined' then
    raise exception 'INVITES 3 FAILED: unexpected result %', res;
  end if;
  select role into r from public.ledger_group_memberships
    where group_id = group_i and user_id = mem_uid::uuid and status = 'active';
  if r is distinct from 'member' then
    raise exception 'INVITES 3 FAILED: joined role is %', r;
  end if;

  -- INVITES 4. A second redeem by the same user is already_member; count unchanged.
  set local role authenticated;
  res := public.redeem_group_invite_v1(tok);
  reset role;
  if res ->> 'status' <> 'already_member' then
    raise exception 'INVITES 4 FAILED: second redeem gave %', res;
  end if;
  select use_count into n from public.ledger_group_invites where id = inv_id;
  if n <> 1 then raise exception 'INVITES 4 FAILED: use_count is %', n; end if;

  -- INVITES 5. max_uses is enforced (this invite had one use).
  perform set_config('request.jwt.claim.sub', out_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || out_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.redeem_group_invite_v1(tok);
    raise exception 'INVITES 5 FAILED: a used-up invite was redeemed';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_invite_exhausted%' then
      raise exception 'INVITES 5 FAILED: refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;
  select count(*) into n from public.ledger_group_memberships
    where group_id = group_i and user_id = out_uid::uuid;
  if n <> 0 then raise exception 'INVITES 5 FAILED: a membership was created'; end if;

  -- INVITES 6. An expired invite is refused, and so is an unknown token.
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  res := public.create_group_invite_v1(group_i, 24, 5);
  tok2 := res ->> 'token';
  inv_id2 := (res ->> 'inviteId')::uuid;
  res := public.create_group_invite_v1(group_i, 24, 5);
  tok3 := res ->> 'token';
  reset role;
  update public.ledger_group_invites
    set created_at = clock_timestamp() - interval '2 days',
        expires_at = clock_timestamp() - interval '1 day'
    where id = inv_id2;
  perform set_config('request.jwt.claim.sub', out_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || out_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.redeem_group_invite_v1(tok2);
    raise exception 'INVITES 6 FAILED: an expired invite was redeemed';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_invite_expired%' then
      raise exception 'INVITES 6 FAILED: expired refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.redeem_group_invite_v1(repeat('z', 40));
    raise exception 'INVITES 6 FAILED: an unknown token was redeemed';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_invite_invalid%' then
      raise exception 'INVITES 6 FAILED: unknown token refused wrongly: %', sqlerrm;
    end if;
  end;
  reset role;

  -- INVITES 7. The owner lists (no token) and revokes; a revoked invite is refused.
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  res := public.list_group_invites_v1(group_i);
  if jsonb_array_length(res) <> 3 or res::text like '%' || tok3 || '%' or res::text like '%token%' then
    raise exception 'INVITES 7 FAILED: owner invite list wrong or leaks a token: %', res;
  end if;
  select (e ->> 'inviteId')::uuid into inv_id2
    from jsonb_array_elements(res) e where e ->> 'status' = 'active' limit 1;
  res := public.revoke_group_invite_v1(inv_id2);
  if (res ->> 'changed')::boolean is not true then
    raise exception 'INVITES 7 FAILED: revoke did not change: %', res;
  end if;
  res := public.revoke_group_invite_v1(inv_id2);
  if (res ->> 'changed')::boolean is not false then
    raise exception 'INVITES 7 FAILED: repeated revoke reported a change';
  end if;
  reset role;
  -- Whichever active invite was revoked, redeeming tok3 or the other must now fail
  -- for the revoked one; check by hash.
  select count(*) into n from public.ledger_group_invites where id = inv_id2 and revoked_at is not null;
  if n <> 1 then raise exception 'INVITES 7 FAILED: revoked_at not set'; end if;
  -- Pick the revoked invite's token as superuser: token_hash is not readable by authenticated.
  revoked_tok := case when exists (select 1 from public.ledger_group_invites
                        where id = inv_id2 and token_hash = encode(sha256(convert_to(tok3, 'UTF8')), 'hex'))
           then tok3 else tok end;
  perform set_config('request.jwt.claim.sub', out_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || out_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.redeem_group_invite_v1(revoked_tok);
    raise exception 'INVITES 7 FAILED: a revoked invite was redeemed';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_invite_revoked%' then
      raise exception 'INVITES 7 FAILED: revoked refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  reset role;

  -- INVITES 8. A non-owner cannot list or revoke invites or read the table.
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.list_group_invites_v1(group_i);
    raise exception 'INVITES 8 FAILED: a member listed invites';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'INVITES 8 FAILED: list refused wrongly: %', sqlerrm;
    end if;
  end;
  begin
    perform public.revoke_group_invite_v1(inv_id);
    raise exception 'INVITES 8 FAILED: a member revoked an invite';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'INVITES 8 FAILED: revoke refused wrongly: %', sqlerrm;
    end if;
  end;
  select count(*) into n from public.ledger_group_invites;
  if n <> 0 then raise exception 'INVITES 8 FAILED: a member can select invite rows (%)', n; end if;
  begin
    perform token_hash from public.ledger_group_invites limit 1;
    raise exception 'INVITES 8 FAILED: token_hash is selectable';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'INVITES 8 FAILED: token_hash refused wrongly: %', sqlerrm;
    end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  select count(*) into n from public.ledger_group_invites;
  if n <> 3 then raise exception 'INVITES 8 FAILED: owner sees % invite rows', n; end if;
  reset role;

  -- INVITES 9. Redeeming never demotes an owner or treasurer.
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  res := public.create_group_invite_v1(group_i, 24, 10);
  tok := res ->> 'token';
  perform public.sened_ledger_set_member_role_v1(group_i, mem_uid::uuid, 'treasurer');
  res := public.redeem_group_invite_v1(tok);
  if res ->> 'status' <> 'already_member' or res ->> 'role' <> 'owner' then
    raise exception 'INVITES 9 FAILED: owner redeem gave %', res;
  end if;
  reset role;
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '"}', false);
  set local role authenticated;
  res := public.redeem_group_invite_v1(tok);
  if res ->> 'status' <> 'already_member' or res ->> 'role' <> 'treasurer' then
    raise exception 'INVITES 9 FAILED: treasurer redeem gave %', res;
  end if;
  reset role;
  select role into r from public.ledger_group_memberships where group_id = group_i and user_id = own_uid::uuid;
  if r <> 'owner' then raise exception 'INVITES 9 FAILED: owner role is now %', r; end if;
  select role into r from public.ledger_group_memberships where group_id = group_i and user_id = mem_uid::uuid;
  if r <> 'treasurer' then raise exception 'INVITES 9 FAILED: treasurer role is now %', r; end if;
  select use_count into n from public.ledger_group_invites
    where token_hash = encode(sha256(convert_to(tok, 'UTF8')), 'hex');
  if n <> 0 then raise exception 'INVITES 9 FAILED: already-member redeems counted uses (%)', n; end if;

  -- INVITES 10. Members list: any member may call; an outsider may not. Email is
  -- visible to the owner only.
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  set local role authenticated;
  res := public.list_group_members_v1(group_i);
  if jsonb_array_length(res) <> 2 or not exists (
    select 1 from jsonb_array_elements(res) e where e ->> 'email' = 'member-b@example.test') then
    raise exception 'INVITES 10 FAILED: owner member list wrong: %', res;
  end if;
  reset role;
  perform set_config('request.jwt.claim.sub', mem_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || mem_uid || '"}', false);
  set local role authenticated;
  res := public.list_group_members_v1(group_i);
  if jsonb_array_length(res) <> 2 or res::text like '%@example.test%' then
    raise exception 'INVITES 10 FAILED: member list wrong or leaks email: %', res;
  end if;
  reset role;
  perform set_config('request.jwt.claim.sub', out_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || out_uid || '"}', false);
  set local role authenticated;
  begin
    perform public.list_group_members_v1(group_i);
    raise exception 'INVITES 10 FAILED: an outsider listed members';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'INVITES 10 FAILED: outsider refused wrongly: %', sqlerrm;
    end if;
  end;
  reset role;

  -- INVITES 11. No subject, and anon, are refused.
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false);
  set local role authenticated;
  begin
    perform public.redeem_group_invite_v1(tok);
    raise exception 'INVITES 11 FAILED: a request with no subject redeemed';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'INVITES 11 FAILED: subject-less redeem refused wrongly: %', sqlerrm;
    end if;
  end;
  begin
    perform public.create_group_invite_v1(group_i, 24, 1);
    raise exception 'INVITES 11 FAILED: a request with no subject created an invite';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%ledger_forbidden%' then
      raise exception 'INVITES 11 FAILED: subject-less create refused wrongly: %', sqlerrm;
    end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.role', 'anon', false);
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  set local role anon;
  begin
    perform public.redeem_group_invite_v1(tok);
    raise exception 'INVITES 11 FAILED: anon redeemed';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'INVITES 11 FAILED: anon redeem refused wrongly: %', sqlerrm;
    end if;
  end;
  begin
    perform public.list_group_members_v1(group_i);
    raise exception 'INVITES 11 FAILED: anon listed members';
  exception when others then
    if sqlerrm like 'INVITES%' then raise; end if;
    if sqlerrm not like '%permission denied%' then
      raise exception 'INVITES 11 FAILED: anon list refused wrongly: %', sqlerrm;
    end if;
  end;
  reset role;

  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', own_uid, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own_uid || '"}', false);
  raise notice 'INVITES: all 11 invite-link checks passed';
end;
$invites$;

select 'ALL DRAW BINDING CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Reconciliation worker RPCs (20261001100000_reconciliation_worker_rpcs.sql)
--
-- The cron-driven drain runs as service_role, which has no auth.uid(). Checks
-- that the two worker wrappers (a) only work for a CLAIMED, unexpired job,
-- (b) act as the job's owner, (c) are idempotent on replay, (d) refuse a
-- posting that is not the bank posting for that intent, and (e) are not
-- callable by `authenticated`. Runs in a transaction that is rolled back.
-- ---------------------------------------------------------------------------
reset role;
begin;
select set_config('request.jwt.claim.sub','',true);
insert into public.bank_account_bindings (id,user_id,tenant_id,group_id,ledger_account_id,provider,account_label,account_fingerprint_hmac,sender_fingerprint_hmac,receiver_fingerprint_hmac)
values ('cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-0000000000a1','telebirr','T',repeat('a',64),repeat('b',64),repeat('c',64));
insert into public.bank_verification_intents (id,user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at)
values ('dddddddd-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-0000000000a1','telebirr',repeat('d',64),'bank-intent-9',repeat('e',64),25.00,'inbound',now());
insert into public.bank_reconciliation_jobs (verification_id,user_id,provider) values ('dddddddd-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','telebirr');

delete from public.bank_reconciliation_jobs where verification_id <> 'dddddddd-0000-4000-8000-000000000001';
set local role service_role;
-- 1. unclaimed job: both wrappers refuse
do $$ begin
  begin perform public.get_bank_account_binding_for_reconciliation_v1('cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111'); raise exception 'FAIL unclaimed binding'; exception when sqlstate '42501' then null; end;
end $$;
do $$ begin if (public.claim_bank_reconciliation_job_v1('w1', 60)->'job'->>'state') is distinct from 'CLAIMED' then raise exception 'worker check: claim failed'; end if; end $$;
-- 2. claimed: binding readable
do $$ begin if public.get_bank_account_binding_for_reconciliation_v1('cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111')->>'accountLabel' is distinct from 'T' then raise exception 'worker check: binding not readable by worker rpc'; end if; end $$;
do $$ begin if coalesce(nullif(current_setting('request.jwt.claim.sub', true),''),'') <> '' then raise exception 'worker check: identity leaked after rpc'; end if; end $$;
-- wrong user refused
do $$ begin
  begin perform public.get_bank_account_binding_for_reconciliation_v1('cccccccc-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222'); raise exception 'FAIL wrong user'; exception when sqlstate '42501' then null; end;
end $$;
-- 3. ledger post
create temp table r as select public.post_ledger_entry_for_reconciliation_v1(
 '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','bank-verified-bank-intent-9',now(),'contribution',null,null,
 '[{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a1","direction":"debit","amount":"25.00"},{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a2","direction":"credit","amount":"25.00"}]'::jsonb) as j;
do $$ begin if (select j->>'replayed' from r) <> 'false' then raise exception 'worker check: first post replayed'; end if; end $$;
create temp table r2 as select public.post_ledger_entry_for_reconciliation_v1(
 '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','bank-verified-bank-intent-9',now(),'contribution',null,null,
 '[{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a1","direction":"debit","amount":"25.00"},{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a2","direction":"credit","amount":"25.00"}]'::jsonb) as j;
do $$ begin if (select j->>'replayed' from r2) <> 'true' or (select j->'entry'->>'id' from r2) <> (select j->'entry'->>'id' from r) then raise exception 'worker check: replay was not idempotent'; end if; end $$;
-- refusals
do $$ begin
  begin perform public.post_ledger_entry_for_reconciliation_v1('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','other-key',now(),'contribution',null,null,'[{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a1","direction":"debit","amount":"25.00"},{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a2","direction":"credit","amount":"25.00"}]'::jsonb); raise exception 'FAIL key'; exception when sqlstate '42501' then null; end;
  begin perform public.post_ledger_entry_for_reconciliation_v1('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','bank-verified-bank-intent-9',now(),'contribution',null,null,'[{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a1","direction":"debit","amount":"2500.00"},{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a2","direction":"credit","amount":"2500.00"}]'::jsonb); raise exception 'FAIL amount'; exception when sqlstate '42501' then null; end;
  begin perform public.post_ledger_entry_for_reconciliation_v1('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','bank-verified-bank-intent-9',now(),'disbursement',null,null,'[{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a2","direction":"debit","amount":"25.00"},{"accountId":"aaaaaaaa-0000-4000-8000-0000000000a1","direction":"credit","amount":"25.00"}]'::jsonb); raise exception 'FAIL type'; exception when sqlstate '42501' then null; end;
end $$;
-- 4. grants: authenticated cannot call
reset role; set local role authenticated;
do $$ begin
  begin perform public.get_bank_account_binding_for_reconciliation_v1('cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111'); raise exception 'FAIL grant'; exception when sqlstate '42501' then null; end;
end $$;
rollback;
select 'ALL RECONCILIATION WORKER CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Stuck-job reaper (reap_exhausted_bank_reconciliation_jobs_v1)
--
-- claim only reclaims an expired lease while attempts remain, so a worker that
-- dies on its FINAL attempt used to leave a job that was never claimed again
-- and never reached MANUAL_REVIEW. Checks that the reaper (a) moves that job to
-- MANUAL_REVIEW exactly as reschedule does on exhaustion, (b) leaves an expired
-- lease with attempts left for claim to reclaim as before, (c) leaves a live
-- lease alone, (d) is idempotent, and (e) is not callable by `authenticated`.
-- ---------------------------------------------------------------------------
reset role;
begin;
delete from public.bank_reconciliation_jobs;
insert into public.bank_account_bindings (id,user_id,tenant_id,group_id,ledger_account_id,provider,account_label,account_fingerprint_hmac,sender_fingerprint_hmac,receiver_fingerprint_hmac)
values ('cccccccc-0000-4000-8000-0000000000f1','11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-0000000000a1','telebirr','R',repeat('a',64),repeat('b',64),repeat('c',64));
insert into public.bank_verification_intents (id,user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at)
select ('eeeeeeee-0000-4000-8000-00000000000' || n)::uuid,'11111111-1111-4111-8111-111111111111','bbbbbbbb-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-0000000000f1','aaaaaaaa-0000-4000-8000-0000000000a1','telebirr',repeat(n::text,64),'reap-intent-' || n,repeat('e',64),10.00,'inbound',now()
from generate_series(1,3) n;
-- 1: final attempt, lease expired (stuck). 2: attempts left, lease expired. 3: final attempt, lease live.
insert into public.bank_reconciliation_jobs (verification_id,user_id,provider,state,attempt,max_attempts,lease_owner,lease_token,lease_expires_at) values
  ('eeeeeeee-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','telebirr','CLAIMED',1,1,'dead',gen_random_uuid(),clock_timestamp() - interval '1 minute'),
  ('eeeeeeee-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','telebirr','CLAIMED',1,3,'dead',gen_random_uuid(),clock_timestamp() - interval '1 minute'),
  ('eeeeeeee-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','telebirr','CLAIMED',1,1,'busy',gen_random_uuid(),clock_timestamp() + interval '10 minutes');

set local role service_role;
do $$
begin
  if public.reap_exhausted_bank_reconciliation_jobs_v1() <> 1 then
    raise exception 'reaper check: expected exactly one job reaped';
  end if;
  if public.reap_exhausted_bank_reconciliation_jobs_v1() <> 0 then
    raise exception 'reaper check: second run was not a no-op';
  end if;
end $$;
reset role;
do $$
declare
  j public.bank_reconciliation_jobs%rowtype;
  i public.bank_verification_intents%rowtype;
begin
  select * into j from public.bank_reconciliation_jobs where verification_id = 'eeeeeeee-0000-4000-8000-000000000001';
  if j.state <> 'MANUAL_REVIEW' or j.lease_token is not null or j.lease_owner is not null
     or j.lease_expires_at is not null or j.terminal_at is null or j.last_reason_code <> 'MANUAL_REVIEW_REQUIRED' then
    raise exception 'reaper check: stuck job not in MANUAL_REVIEW shape (state=%)', j.state;
  end if;
  select * into i from public.bank_verification_intents where id = 'eeeeeeee-0000-4000-8000-000000000001';
  if i.state <> 'PENDING_RECONCILIATION' or i.reason_code <> 'MANUAL_REVIEW_REQUIRED' then
    raise exception 'reaper check: intent not marked MANUAL_REVIEW_REQUIRED';
  end if;
  if (select count(*) from public.bank_verification_events
      where verification_id = 'eeeeeeee-0000-4000-8000-000000000001' and event_type = 'MANUAL_REVIEW') <> 1 then
    raise exception 'reaper check: expected one MANUAL_REVIEW event';
  end if;
  if (select state from public.bank_reconciliation_jobs where verification_id = 'eeeeeeee-0000-4000-8000-000000000003') <> 'CLAIMED' then
    raise exception 'reaper check: live lease was touched';
  end if;
  if (select state from public.bank_reconciliation_jobs where verification_id = 'eeeeeeee-0000-4000-8000-000000000002') <> 'CLAIMED' then
    raise exception 'reaper check: job with attempts left was touched';
  end if;
end $$;
-- The job with attempts left is still reclaimable by claim, as before.
set local role service_role;
do $$
begin
  if (public.claim_bank_reconciliation_job_v1('w2', 60) -> 'job' ->> 'verificationId') is distinct from 'eeeeeeee-0000-4000-8000-000000000002' then
    raise exception 'reaper check: expired lease with attempts left was not reclaimable';
  end if;
end $$;
reset role;
set local role authenticated;
do $$
begin
  begin
    perform public.reap_exhausted_bank_reconciliation_jobs_v1();
    raise exception 'reaper check: authenticated could call the reaper';
  exception when sqlstate '42501' then null;
  end;
end $$;
reset role;
rollback;
select 'ALL RECONCILIATION REAPER CHECKS PASSED' as result;

-- ===========================================================================
-- Draw cycles, server-created draws, and member seal / nonce submission
-- (20261005100000_draw_cycles_and_member_seals.sql)
--
-- Every call below runs as `authenticated` with a JWT whose `sub` is the caller,
-- as PostgREST does; the fixtures that need superuser (memberships, hashes the
-- clients are not allowed to compute) are built outside that role. Cast:
--
--   own  a1..01  owner of group A (provisions it)
--   tre  a1..02  treasurer of group A
--   mb1  a1..03  plain member, seals and releases a nonce
--   mb2  a1..04  plain member, seals and releases a nonce
--   out  a1..05  owner of a DIFFERENT group B; no part in group A
--
-- Failure raises, so any ERROR in the output is a real failure. Success prints:
-- ALL DRAW CYCLE AND SEAL CHECKS PASSED
-- ===========================================================================
insert into auth.users (id, email) values
  ('a1a1a1a1-0000-4000-8000-000000000001', 'cyc-owner@example.test'),
  ('a1a1a1a1-0000-4000-8000-000000000002', 'cyc-treasurer@example.test'),
  ('a1a1a1a1-0000-4000-8000-000000000003', 'cyc-member1@example.test'),
  ('a1a1a1a1-0000-4000-8000-000000000004', 'cyc-member2@example.test'),
  ('a1a1a1a1-0000-4000-8000-000000000005', 'cyc-outsider@example.test')
on conflict (id) do nothing;

-- Run one statement as a user under a role and report what happened: the result
-- text, or 'ERR:' || the error message (plus SQLSTATE). Role switching lives in
-- one place so a check cannot forget to reset it.
create or replace function pg_temp.call_as(p_uid uuid, p_role text, p_stmt text)
returns text
language plpgsql
as $$
declare
  res text;
begin
  perform set_config('request.jwt.claim.role', p_role, false);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), false);
  perform set_config('request.jwt.claims',
    case when p_uid is null then '{}' else '{"sub":"' || p_uid::text || '"}' end, false);
  execute format('set local role %I', p_role);
  begin
    execute p_stmt into res;
  exception when others then
    res := 'ERR:' || sqlerrm || ' [' || sqlstate || ']';
  end;
  reset role;
  return coalesce(res, 'NULL');
end;
$$;

create or replace function pg_temp.expect_err(p_result text, p_needle text, p_label text)
returns void
language plpgsql
as $$
begin
  if p_result not like 'ERR:%' then
    raise exception '% FAILED: expected a refusal containing "%" but the call SUCCEEDED: %',
      p_label, p_needle, left(p_result, 200);
  end if;
  if p_result not like '%' || p_needle || '%' then
    raise exception '% FAILED: refused for the wrong reason (wanted "%"): %', p_label, p_needle, p_result;
  end if;
end;
$$;

create or replace function pg_temp.expect_ok(p_result text, p_label text)
returns jsonb
language plpgsql
as $$
begin
  if p_result like 'ERR:%' then
    raise exception '% FAILED: the call was refused: %', p_label, p_result;
  end if;
  return p_result::jsonb;
end;
$$;

do $cycles$
declare
  own constant uuid := 'a1a1a1a1-0000-4000-8000-000000000001';
  tre constant uuid := 'a1a1a1a1-0000-4000-8000-000000000002';
  mb1 constant uuid := 'a1a1a1a1-0000-4000-8000-000000000003';
  mb2 constant uuid := 'a1a1a1a1-0000-4000-8000-000000000004';
  out constant uuid := 'a1a1a1a1-0000-4000-8000-000000000005';
  group_a uuid;
  group_b uuid;
  cycle_id uuid;
  r text;
  j jsonb;
begin
  -- Fixtures. Owner provisions group A; the others are added as members. The
  -- outsider provisions their own group B.
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', own::text, false);
  perform set_config('request.jwt.claims', '{"sub":"' || own::text || '"}', false);
  set local role authenticated;
  group_a := (public.sened_ledger_provision_group_v1('Cycle test equb A') ->> 'groupId')::uuid;
  reset role;
  perform set_config('request.jwt.claim.sub', out::text, false);
  perform set_config('request.jwt.claims', '{"sub":"' || out::text || '"}', false);
  set local role authenticated;
  group_b := (public.sened_ledger_provision_group_v1('Cycle test equb B') ->> 'groupId')::uuid;
  reset role;
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (group_a, own, tre, 'treasurer', 'active'),
    (group_a, own, mb1, 'member', 'active'),
    (group_a, own, mb2, 'member', 'active');

  -- CYCLE 1. The owner creates a cycle. The pot is the contribution times the
  -- active members, computed in the database, not typed.
  j := pg_temp.expect_ok(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 4, 1000, null, %L)::text',
    group_a, 'Meskerem equb', '1000.00', 'cyc-create-1')), 'CYCLE 1');
  cycle_id := (j -> 'cycle' ->> 'cycleId')::uuid;
  if j ->> 'replayed' <> 'false'
     or j -> 'cycle' ->> 'potAmount' <> '4000.00'
     or j -> 'cycle' ->> 'contributionAmount' <> '1000.00'
     or (j -> 'cycle' ->> 'totalRounds')::int <> 4
     or (j -> 'cycle' ->> 'nextRound')::int <> 1
     or (j -> 'cycle' ->> 'reserveRatioBps')::int <> 1000 then
    raise exception 'CYCLE 1 FAILED: unexpected cycle %', j;
  end if;

  -- CYCLE 2. Idempotent: the same key replays; the same key with different
  -- terms is a conflict, never a silent second cycle.
  j := pg_temp.expect_ok(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 4, 1000, null, %L)::text',
    group_a, 'Meskerem equb', '1000.00', 'cyc-create-1')), 'CYCLE 2');
  if j ->> 'replayed' <> 'true' or (j -> 'cycle' ->> 'cycleId')::uuid <> cycle_id then
    raise exception 'CYCLE 2 FAILED: the retry did not replay: %', j;
  end if;
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 4, 1000, null, %L)::text',
    group_a, 'Meskerem equb', '2000.00', 'cyc-create-1')), 'draw_idempotency_conflict', 'CYCLE 2b');
  if (select count(*) from public.draw_cycles where group_id = group_a and idempotency_key = 'cyc-create-1') <> 1 then
    raise exception 'CYCLE 2 FAILED: a second cycle was created';
  end if;

  -- CYCLE 3. Role refusal: a plain member, an outsider (owner of another group),
  -- and anon cannot create a cycle in group A. A treasurer can.
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 2, 1000, null, %L)::text',
    group_a, 'x', '10.00', 'cyc-mb')), 'draw_forbidden', 'CYCLE 3 member');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 1, 1000, null, %L)::text',
    group_a, 'x', '10.00', 'cyc-out')), 'draw_forbidden', 'CYCLE 3 outsider');
  perform pg_temp.expect_err(pg_temp.call_as(null, 'anon', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 1, 1000, null, %L)::text',
    group_a, 'x', '10.00', 'cyc-anon')), 'permission denied', 'CYCLE 3 anon');
  perform pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 2, 500, null, %L)::text',
    group_a, 'Tikimt equb', '250.50', 'cyc-tre')), 'CYCLE 3 treasurer');
  if exists (select 1 from public.draw_cycles where group_id = group_a and idempotency_key in ('cyc-mb', 'cyc-out', 'cyc-anon')) then
    raise exception 'CYCLE 3 FAILED: a refused call still created a cycle';
  end if;

  -- CYCLE 4. Bad terms are refused: more rounds than members, a non-positive or
  -- sub-cent contribution, a blank name, an out-of-range reserve.
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 5, 1000, null, %L)::text',
    group_a, 'too long', '100.00', 'cyc-bad-1')), 'draw_cycle_rounds_exceed_members', 'CYCLE 4 rounds');
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 2, 1000, null, %L)::text',
    group_a, 'zero', '0', 'cyc-bad-2')), 'draw_invalid_request', 'CYCLE 4 zero');
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 2, 1000, null, %L)::text',
    group_a, 'sub-cent', '10.001', 'cyc-bad-3')), 'draw_invalid_request', 'CYCLE 4 sub-cent');
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 2, 1000, null, %L)::text',
    group_a, '   ', '10.00', 'cyc-bad-4')), 'draw_invalid_request', 'CYCLE 4 blank');
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 2, 3334, null, %L)::text',
    group_a, 'reserve', '10.00', 'cyc-bad-5')), 'draw_invalid_request', 'CYCLE 4 reserve');

  -- CYCLE 5. Reading. Any member lists cycles and reads one; an outsider is
  -- refused on both (cross-group isolation), and cannot tell a real cycle from
  -- an invented one.
  j := pg_temp.expect_ok(pg_temp.call_as(mb2, 'authenticated', format(
    'select public.list_draw_cycles_v1(%L)::text', group_a)), 'CYCLE 5 list');
  if jsonb_array_length(j) <> 2 then
    raise exception 'CYCLE 5 FAILED: a member should see both cycles, saw %', jsonb_array_length(j);
  end if;
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.list_draw_cycles_v1(%L)::text', group_a)), 'draw_forbidden', 'CYCLE 5 outsider list');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.get_draw_cycle_v1(%L)::text', cycle_id)), 'draw_forbidden', 'CYCLE 5 outsider get');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.get_draw_cycle_v1(%L)::text', 'a1a1a1a1-0000-4000-8000-0000000000ff')), 'draw_forbidden', 'CYCLE 5 unknown');
  j := pg_temp.expect_ok(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.get_draw_cycle_v1(%L)::text', cycle_id)), 'CYCLE 5 get');
  if jsonb_array_length(j -> 'draws') <> 0 or j -> 'cycle' ->> 'name' <> 'Meskerem equb' then
    raise exception 'CYCLE 5 FAILED: unexpected cycle read %', j;
  end if;
  -- The group B owner sees group B's (empty) list, and none of A's.
  j := pg_temp.expect_ok(pg_temp.call_as(out, 'authenticated', format(
    'select public.list_draw_cycles_v1(%L)::text', group_b)), 'CYCLE 5 own group');
  if jsonb_array_length(j) <> 0 then
    raise exception 'CYCLE 5 FAILED: group B listed cycles it does not own';
  end if;

  perform set_config('sened.test.group_a', group_a::text, false);
  perform set_config('sened.test.group_b', group_b::text, false);
  perform set_config('sened.test.cycle', cycle_id::text, false);
end;
$cycles$;

do $lifecycle$
declare
  own constant uuid := 'a1a1a1a1-0000-4000-8000-000000000001';
  tre constant uuid := 'a1a1a1a1-0000-4000-8000-000000000002';
  mb1 constant uuid := 'a1a1a1a1-0000-4000-8000-000000000003';
  mb2 constant uuid := 'a1a1a1a1-0000-4000-8000-000000000004';
  out constant uuid := 'a1a1a1a1-0000-4000-8000-000000000005';
  group_a constant uuid := current_setting('sened.test.group_a')::uuid;
  group_b constant uuid := current_setting('sened.test.group_b')::uuid;
  cycle_id constant uuid := current_setting('sened.test.cycle')::uuid;
  nonce1 constant text := 'mb1-secret-nonce-0123456789-AAAA';
  nonce2 constant text := 'mb2-secret-nonce-0123456789-BBBB';
  commit_seed constant text := 'treasurer-seed-0123456789-ZZZZ';
  commit_nonce constant text := 'treasurer-commit-nonce-0123456789';
  draw uuid;
  seal1 text;
  seal2 text;
  other_seal text;
  participants jsonb;
  member_digest text;
  commitment text;
  roster_digest constant text := repeat('9', 64);
  winner jsonb;
  j jsonb;
  r text;
  stmt text;
  opened jsonb;
begin
  -- STATE 1. Opening a draw: a plain member and an outsider cannot; the owner
  -- can. The draw id is created by the server and starts in SEALING.
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.open_draw_v1(%L, null, %L)::text', cycle_id, 'open-mb')), 'draw_forbidden', 'STATE 1 member');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.open_draw_v1(%L, null, %L)::text', cycle_id, 'open-out')), 'draw_forbidden', 'STATE 1 outsider');
  j := pg_temp.expect_ok(pg_temp.call_as(own, 'authenticated', format(
    'select public.open_draw_v1(%L, null, %L)::text', cycle_id, 'open-r1')), 'STATE 1 owner');
  draw := (j -> 'session' ->> 'drawId')::uuid;
  if j ->> 'replayed' <> 'false'
     or j -> 'session' ->> 'state' <> 'sealing'
     or (j -> 'session' ->> 'round')::int <> 1
     or jsonb_array_length(j -> 'session' -> 'eligible') <> 4
     or jsonb_array_length(j -> 'session' -> 'seals') <> 0 then
    raise exception 'STATE 1 FAILED: unexpected new draw %', j;
  end if;

  -- STATE 2. Opening again continues the same draw (same key or a new key), and
  -- a round out of order is refused.
  j := pg_temp.expect_ok(pg_temp.call_as(own, 'authenticated', format(
    'select public.open_draw_v1(%L, null, %L)::text', cycle_id, 'open-r1')), 'STATE 2 replay');
  if (j -> 'session' ->> 'drawId')::uuid <> draw or j ->> 'replayed' <> 'true' then
    raise exception 'STATE 2 FAILED: the same key did not replay %', j;
  end if;
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_v1(%L, null, %L)::text', cycle_id, 'open-r1-again')), 'STATE 2 new key');
  if (j -> 'session' ->> 'drawId')::uuid <> draw then
    raise exception 'STATE 2 FAILED: a second sealing draw was created for the same round';
  end if;
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.open_draw_v1(%L, 2, %L)::text', cycle_id, 'open-r2-early')), 'draw_round_out_of_order', 'STATE 2 order');

  -- NONCE 1. A nonce is refused before the commitment exists, whatever it is.
  seal1 := public.sened_draw_member_seal_hash(draw, mb1, nonce1);
  seal2 := public.sened_draw_member_seal_hash(draw, mb2, nonce2);
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce1)), 'draw_nonce_too_early', 'NONCE 1');
  if exists (select 1 from public.draw_nonces where draw_id = draw) then
    raise exception 'NONCE 1 FAILED: a nonce was stored before the commit';
  end if;

  -- SEAL 1. A commit with no seal at all is refused.
  participants := (
    select jsonb_agg(jsonb_build_object(
      'memberId', e.member_id, 'displayName', 'Member ' || left(e.member_id::text, 8),
      'contributionAmount', '1000.00',
      'ticket', public.sened_draw_ticket(group_a, cycle_id, e.member_id)) order by e.member_id::text)
    from public.sened_draw_eligible_members(group_a, cycle_id, 1) as e(member_id));
  member_digest := public.sened_draw_member_set_digest(draw, jsonb_build_array(
    jsonb_build_object('memberId', mb1, 'sealed', seal1),
    jsonb_build_object('memberId', mb2, 'sealed', seal2)));
  commitment := public.sened_draw_commit_hash_v3(
    group_a, cycle_id, 1, draw, roster_digest, commit_nonce, member_digest, commit_seed);
  stmt := format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, commitment, commit_nonce, roster_digest, member_digest, participants, 'commit-r1', 'v3');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', stmt), 'draw_member_commitment_missing', 'SEAL 1');

  -- SEAL 2. Members seal for THEMSELVES: the function has no member argument, and
  -- the row is stored under the caller's own uid.
  if exists (
    select 1 from pg_proc where proname = 'submit_draw_seal_v1' and proargnames::text like '%member%'
  ) or exists (
    select 1 from pg_proc where proname = 'submit_draw_nonce_v1' and proargnames::text like '%member%'
  ) then
    raise exception 'SEAL 2 FAILED: a seal or nonce function takes a member id from the caller';
  end if;
  j := pg_temp.expect_ok(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, seal1)), 'SEAL 2 mb1');
  if (j ->> 'memberId')::uuid <> mb1 or j ->> 'replaced' <> 'false' then
    raise exception 'SEAL 2 FAILED: unexpected seal result %', j;
  end if;
  perform pg_temp.expect_ok(pg_temp.call_as(mb2, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, seal2)), 'SEAL 2 mb2');
  if (select count(*) from public.draw_seals where draw_id = draw and member_id = mb1 and sealed = seal1) <> 1
     or (select count(*) from public.draw_seals where draw_id = draw and member_id = mb2 and sealed = seal2) <> 1
     or (select count(*) from public.draw_seals where draw_id = draw) <> 2 then
    raise exception 'SEAL 2 FAILED: seals were not stored under the callers';
  end if;

  -- SEAL 3. An outsider, a malformed seal, and anon are refused; nothing stored.
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, repeat('a', 64))), 'draw_forbidden', 'SEAL 3 outsider');
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, 'not-a-hash')), 'draw_invalid_request', 'SEAL 3 malformed');
  perform pg_temp.expect_err(pg_temp.call_as(null, 'anon', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, repeat('a', 64))), 'permission denied', 'SEAL 3 anon');
  if (select count(*) from public.draw_seals where draw_id = draw) <> 2 then
    raise exception 'SEAL 3 FAILED: a refused seal was stored';
  end if;

  -- SEAL 4. While sealing, a member may replace their own seal (lost device);
  -- an identical seal is a no-op. Nobody can write to the seal table directly.
  other_seal := public.sened_draw_member_seal_hash(draw, mb1, 'mb1-replacement-nonce-0123456789');
  j := pg_temp.expect_ok(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, other_seal)), 'SEAL 4 replace');
  if j ->> 'replaced' <> 'true' then raise exception 'SEAL 4 FAILED: replace not reported %', j; end if;
  j := pg_temp.expect_ok(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, seal1)), 'SEAL 4 restore');
  if (select sealed from public.draw_seals where draw_id = draw and member_id = mb1) <> seal1 then
    raise exception 'SEAL 4 FAILED: the original seal was not restored';
  end if;
  perform pg_temp.expect_err(pg_temp.call_as(mb2, 'authenticated', format(
    'insert into public.draw_seals (draw_id, member_id, sealed) values (%L, %L, %L)', draw, mb1, repeat('b', 64))),
    'permission denied', 'SEAL 4 direct insert');

  -- SEAL 5. Seals are visible to the group as hashes, and to nobody outside it.
  r := pg_temp.call_as(mb2, 'authenticated', format(
    'select count(*)::text from public.draw_seals where draw_id = %L', draw));
  if r <> '2' then raise exception 'SEAL 5 FAILED: a member should see 2 seal hashes, saw %', r; end if;
  r := pg_temp.call_as(out, 'authenticated', format(
    'select count(*)::text from public.draw_seals where draw_id = %L', draw));
  if r <> '0' then raise exception 'SEAL 5 FAILED: an outsider saw % seal rows', r; end if;
  j := pg_temp.expect_ok(pg_temp.call_as(mb2, 'authenticated', format(
    'select public.get_draw_session_v1(%L)::text', draw)), 'SEAL 5 session');
  if jsonb_array_length(j -> 'seals') <> 2 or j ->> 'state' <> 'sealing' then
    raise exception 'SEAL 5 FAILED: unexpected session view %', j;
  end if;
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.get_draw_session_v1(%L)::text', draw)), 'draw_forbidden', 'SEAL 5 outsider session');

  -- COMMIT 1. Only an owner/treasurer commits; the roster is not typed.
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', stmt), 'draw_forbidden', 'COMMIT 1 member');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', stmt), 'draw_forbidden', 'COMMIT 1 outsider');
  perform pg_temp.expect_err(pg_temp.call_as(null, 'anon', stmt), 'permission denied', 'COMMIT 1 anon');
  -- The client-seals commit is not callable by clients any more.
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_v1(%L, %L, 1, %L, %L, %L, %L, %L, %L::jsonb, %L::jsonb, 4000.00, 4, 1000, %L, now(), %L)::text',
    group_a, cycle_id, draw, commitment, commit_nonce, roster_digest, member_digest,
    jsonb_build_array(jsonb_build_object('memberId', mb1, 'sealed', seal1)), participants, 'legacy-key', 'v3')),
    'permission denied', 'COMMIT 1 legacy commit_draw_v1');

  -- COMMIT 2. A roster the caller typed is refused: a member missing, a ticket
  -- swapped, a different contribution. Nothing is written.
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, commitment, commit_nonce, roster_digest, member_digest, participants - 0, 'commit-bad-1', 'v3')),
    'draw_roster_mismatch', 'COMMIT 2 missing member');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, commitment, commit_nonce, roster_digest, member_digest,
    jsonb_set(participants, '{0,ticket}', to_jsonb(repeat('0', 64))), 'commit-bad-2', 'v3')),
    'draw_roster_mismatch', 'COMMIT 2 swapped ticket');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, commitment, commit_nonce, roster_digest, member_digest,
    jsonb_set(participants, '{1,contributionAmount}', to_jsonb('5000.00'::text)), 'commit-bad-3', 'v3')),
    'draw_roster_mismatch', 'COMMIT 2 changed contribution');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, commitment, commit_nonce, roster_digest, member_digest,
    participants || jsonb_build_array(jsonb_build_object('memberId', out, 'displayName', 'x',
      'contributionAmount', '1000.00', 'ticket', public.sened_draw_ticket(group_a, cycle_id, out))),
    'commit-bad-4', 'v3')),
    'draw_roster_mismatch', 'COMMIT 2 outsider added');

  -- COMMIT 3. A digest over seals other than the stored ones is refused, and so
  -- is a grindable v2 commitment. The caller cannot choose the sealed set.
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, commitment, commit_nonce, roster_digest,
    public.sened_draw_member_set_digest(draw, jsonb_build_array(
      jsonb_build_object('memberId', mb1, 'sealed', seal1),
      jsonb_build_object('memberId', tre, 'sealed', repeat('7', 64)))),
    participants, 'commit-bad-5', 'v3')),
    'draw_member_commitment_mismatch', 'COMMIT 3 forged sealed set');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, commitment, commit_nonce, roster_digest, member_digest, participants, 'commit-bad-6', 'v2')),
    'draw_protocol_version_unsupported', 'COMMIT 3 v2');
  if exists (select 1 from public.draw_commitments where draw_id = draw) then
    raise exception 'COMMIT 3 FAILED: a refused commit left a commitment behind';
  end if;

  -- COMMIT 4. The honest commit by the treasurer. The sealed set is the stored
  -- seals and the terms are the cycle's, neither supplied by the caller. (A
  -- committer holding the only seal is refused: see the SOLO check below.)
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', stmt), 'COMMIT 4');
  if j ->> 'replayed' <> 'false'
     or j -> 'round' ->> 'state' <> 'committed'
     or j -> 'round' -> 'commitment' ->> 'potAmount' <> '4000.00'
     or (j -> 'round' -> 'commitment' ->> 'totalRounds')::int <> 4
     or (j -> 'round' -> 'commitment' ->> 'reserveRatioBps')::int <> 1000
     or jsonb_array_length(j -> 'round' -> 'commitment' -> 'memberCommitments') <> 2
     or j -> 'round' -> 'commitment' ->> 'protocolVersion' <> 'v3' then
    raise exception 'COMMIT 4 FAILED: unexpected commit result %', j;
  end if;
  if (select member_commitments from public.draw_commitments where draw_id = draw)
     <> jsonb_build_array(
          jsonb_build_object('memberId', mb2, 'sealed', seal2),
          jsonb_build_object('memberId', mb1, 'sealed', seal1))
     and (select member_commitments from public.draw_commitments where draw_id = draw)
     <> jsonb_build_array(
          jsonb_build_object('memberId', mb1, 'sealed', seal1),
          jsonb_build_object('memberId', mb2, 'sealed', seal2)) then
    raise exception 'COMMIT 4 FAILED: the committed set is not the stored seals';
  end if;

  -- STATE 3. COMMITTED: seals are closed, a retry replays, a different commit
  -- for the same draw is refused.
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, other_seal)), 'draw_already_committed', 'STATE 3 late seal');
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', stmt), 'STATE 3 replay');
  if j ->> 'replayed' <> 'true' then raise exception 'STATE 3 FAILED: the commit retry did not replay'; end if;
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, repeat('1', 64), commit_nonce, roster_digest, member_digest, participants, 'commit-other', 'v3')),
    'draw_already_committed', 'STATE 3 second commit');
  if (select state from (select public.sened_draw_state(draw) as state) s) <> 'committed' then
    raise exception 'STATE 3 FAILED: the draw is not committed';
  end if;

  -- NONCE 2. Only the caller's own committed seal counts: a wrong nonce, another
  -- member's nonce, a member who did not seal, an outsider and anon are refused.
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, 'mb1-WRONG-nonce-0123456789-AAAA')),
    'draw_member_commitment_mismatch', 'NONCE 2 wrong nonce');
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce2)),
    'draw_member_commitment_mismatch', 'NONCE 2 another member''s nonce');
  perform pg_temp.expect_err(pg_temp.call_as(own, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, 'owner-never-sealed-0123456789')),
    'draw_member_commitment_missing', 'NONCE 2 never sealed');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce1)), 'draw_forbidden', 'NONCE 2 outsider');
  perform pg_temp.expect_err(pg_temp.call_as(null, 'anon', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce1)), 'permission denied', 'NONCE 2 anon');
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, 'short')), 'draw_invalid_request', 'NONCE 2 malformed');
  if exists (select 1 from public.draw_nonces where draw_id = draw) then
    raise exception 'NONCE 2 FAILED: a refused nonce was stored';
  end if;

  -- NONCE 3. NO ONE CAN READ A STORED NONCE BEFORE THE REVEAL IS REQUESTED.
  -- mb1 releases; then every role that could plausibly look - the member, a
  -- fellow member, the treasurer, the owner, an outsider, anon - tries.
  j := pg_temp.expect_ok(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce1)), 'NONCE 3 release');
  if (j ->> 'memberId')::uuid <> mb1 or j ->> 'released' <> 'true' or j ->> 'replayed' <> 'false' then
    raise exception 'NONCE 3 FAILED: unexpected release result %', j;
  end if;
  j := pg_temp.expect_ok(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce1)), 'NONCE 3 idempotent');
  if j ->> 'replayed' <> 'true' then raise exception 'NONCE 3 FAILED: a repeat was not a replay'; end if;
  if (select count(*) from public.draw_nonces where draw_id = draw) <> 1 then
    raise exception 'NONCE 3 FAILED: a repeat stored a second row';
  end if;
  foreach r in array array[mb1::text, mb2::text, tre::text, own::text, out::text] loop
    perform pg_temp.expect_err(pg_temp.call_as(r::uuid, 'authenticated',
      'select count(*)::text from public.draw_nonces'), 'permission denied', 'NONCE 3 select as ' || left(r, 12));
    perform pg_temp.expect_err(pg_temp.call_as(r::uuid, 'authenticated', format(
      'select nonce from public.draw_nonces where draw_id = %L', draw)), 'permission denied', 'NONCE 3 column as ' || left(r, 12));
  end loop;
  perform pg_temp.expect_err(pg_temp.call_as(null, 'anon',
    'select count(*)::text from public.draw_nonces'), 'permission denied', 'NONCE 3 anon');
  -- Nothing the group can read contains a nonce text.
  foreach r in array array[mb1::text, mb2::text, tre::text, own::text] loop
    if pg_temp.call_as(r::uuid, 'authenticated', format('select public.get_draw_session_v1(%L)::text', draw)) like '%' || nonce1 || '%'
       or pg_temp.call_as(r::uuid, 'authenticated', format('select public.get_draw_cycle_v1(%L)::text', cycle_id)) like '%' || nonce1 || '%'
       or pg_temp.call_as(r::uuid, 'authenticated', format('select public.get_draw_v1(%L)::text', draw)) like '%' || nonce1 || '%'
       or pg_temp.call_as(r::uuid, 'authenticated', format('select public.list_draw_cycle_v1(%L)::text', cycle_id)) like '%' || nonce1 || '%'
       or pg_temp.call_as(r::uuid, 'authenticated', format('select count(*)::text from public.draw_reveal_openings where draw_id = %L', draw)) <> '0' then
      raise exception 'NONCE 3 FAILED: a stored nonce is readable by % before the reveal', r;
    end if;
  end loop;
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.get_draw_session_v1(%L)::text', draw)), 'NONCE 3 session');
  if not (j -> 'nonces') @> jsonb_build_array(jsonb_build_object('memberId', mb1, 'released', true))
     or not (j -> 'nonces') @> jsonb_build_array(jsonb_build_object('memberId', mb2, 'released', false)) then
    raise exception 'NONCE 3 FAILED: progress should show mb1 released and mb2 not: %', j -> 'nonces';
  end if;

  -- REVEAL 1. The treasurer asks for the reveal. Refused: a plain member; the
  -- wrong seed (nothing leaks); a missing nonce (mb2 has not released yet).
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, commit_seed)), 'draw_forbidden', 'REVEAL 1 member');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, commit_seed)), 'draw_forbidden', 'REVEAL 1 outsider');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, 'a-junk-seed-0123456789-qqqq')),
    'draw_commitment_mismatch', 'REVEAL 1 junk seed');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, commit_seed)),
    'draw_member_commitment_missing', 'REVEAL 1 missing nonce');
  if exists (select 1 from public.draw_reveal_openings where draw_id = draw) then
    raise exception 'REVEAL 1 FAILED: a refused request published an opening';
  end if;

  -- REVEAL 2. reveal_draw_v1 on a session-backed draw needs the published
  -- opening: without one it is refused, whatever nonces the caller supplies.
  winner := public.sened_draw_ordered_participant(participants, 0);
  stmt := format(
    'select public.reveal_draw_v1(%L, %L, %L, %L, %L::jsonb, %L, %L, 0, %L, %L, 3600.00, 400.00, now())::text',
    draw, commit_seed, commitment, member_digest,
    jsonb_build_array(
      jsonb_build_object('memberId', mb1, 'nonce', nonce1),
      jsonb_build_object('memberId', mb2, 'nonce', nonce2)),
    repeat('7', 64), repeat('8', 64), winner ->> 'memberId', winner ->> 'ticket');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', stmt),
    'draw_member_commitment_missing', 'REVEAL 2 no opening');

  -- REVEAL 3. mb2 releases. Now the request succeeds, returns exactly the stored
  -- nonces, and PUBLISHES them to the group in the same step.
  perform pg_temp.expect_ok(pg_temp.call_as(mb2, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce2)), 'REVEAL 3 mb2 release');
  opened := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, commit_seed)), 'REVEAL 3');
  if opened ->> 'replayed' <> 'false' or opened ->> 'seed' <> commit_seed
     or jsonb_array_length(opened -> 'memberNonces') <> 2
     or not (opened -> 'memberNonces') @> jsonb_build_array(jsonb_build_object('memberId', mb1, 'nonce', nonce1))
     or not (opened -> 'memberNonces') @> jsonb_build_array(jsonb_build_object('memberId', mb2, 'nonce', nonce2)) then
    raise exception 'REVEAL 3 FAILED: unexpected opening %', opened;
  end if;
  r := pg_temp.call_as(mb2, 'authenticated', format(
    'select count(*)::text from public.draw_reveal_openings where draw_id = %L', draw));
  if r <> '1' then raise exception 'REVEAL 3 FAILED: members cannot read the published opening (%)', r; end if;
  r := pg_temp.call_as(out, 'authenticated', format(
    'select count(*)::text from public.draw_reveal_openings where draw_id = %L', draw));
  if r <> '0' then raise exception 'REVEAL 3 FAILED: an outsider can read the opening'; end if;
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, commit_seed)), 'REVEAL 3 replay');
  if j ->> 'replayed' <> 'true' then raise exception 'REVEAL 3 FAILED: the same seed did not replay'; end if;
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, 'another-seed-0123456789-xxxx')),
    'draw_idempotency_conflict', 'REVEAL 3 different seed');
  -- Too late for a nonce now.
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_nonce_v1(%L, %L)::text', draw, nonce1)), 'draw_already_revealed', 'REVEAL 3 late nonce');

  -- REVEAL 4. The reveal can only be the published opening: a different seed or
  -- a nonce set that differs in any entry is refused; the real one is accepted.
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', replace(stmt, commit_seed, 'swapped-seed-0123456789-xxxx')),
    'draw_commitment_mismatch', 'REVEAL 4 swapped seed');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', replace(stmt, nonce2, 'forged-nonce-0123456789-QQQQQQ')),
    'draw_member_commitment_mismatch', 'REVEAL 4 forged nonce');
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', stmt), 'draw_forbidden', 'REVEAL 4 member');
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', stmt), 'REVEAL 4');
  if j ->> 'state' <> 'revealed' or j -> 'reveal' ->> 'winnerMemberId' <> winner ->> 'memberId' then
    raise exception 'REVEAL 4 FAILED: unexpected reveal %', j;
  end if;
  if public.sened_draw_state(draw) <> 'revealed' then
    raise exception 'REVEAL 4 FAILED: the draw is not revealed';
  end if;

  -- STATE 4. After the reveal nothing earlier can be redone.
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', stmt), 'draw_already_revealed', 'STATE 4 re-reveal');
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, commit_seed)), 'draw_already_revealed', 'STATE 4 reopen');
  perform pg_temp.expect_err(pg_temp.call_as(mb1, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, other_seal)), 'draw_already_committed', 'STATE 4 seal');

  -- STATE 5. PAID: the payout goes through the ledger, then is linked.
  declare
    cash_id uuid;
    expense_id uuid;
    posted jsonb;
    entry_id uuid;
  begin
    select id into cash_id from public.ledger_accounts where group_id = group_a and code = 'POT_CASH';
    select id into expense_id from public.ledger_accounts where group_id = group_a and code = 'PAYOUT_EXPENSE';
    perform set_config('request.jwt.claim.sub', own::text, false);
    perform set_config('request.jwt.claims', '{"sub":"' || own::text || '"}', false);
    set local role authenticated;
    posted := public.post_ledger_entry_v1(group_a, 'cycle-payout-r1', now(), 'disbursement', null, null,
      jsonb_build_array(
        jsonb_build_object('accountId', expense_id, 'direction', 'debit', 'amount', '3600.00'),
        jsonb_build_object('accountId', cash_id, 'direction', 'credit', 'amount', '3600.00')));
    reset role;
    entry_id := (posted -> 'entry' ->> 'id')::uuid;
    j := pg_temp.expect_ok(pg_temp.call_as(own, 'authenticated', format(
      'select public.record_draw_payout_v1(%L, %L, %L, 3600.00, 400.00, now())::text',
      draw, entry_id, winner ->> 'memberId')), 'STATE 5 payout');
    if j ->> 'state' <> 'paid' or public.sened_draw_state(draw) <> 'paid' then
      raise exception 'STATE 5 FAILED: the draw is not paid %', j;
    end if;
  end;

  -- ROTATION. Round 2 opens only now that round 1 is revealed, the winner is
  -- not eligible and cannot seal, and the listing shows both draws and states.
  j := pg_temp.expect_ok(pg_temp.call_as(own, 'authenticated', format(
    'select public.open_draw_v1(%L, 2, %L)::text', cycle_id, 'open-r2')), 'ROTATION open');
  if (j -> 'session' ->> 'round')::int <> 2
     or jsonb_array_length(j -> 'session' -> 'eligible') <> 3
     or (j -> 'session' -> 'eligible') @> to_jsonb((winner ->> 'memberId')::text) then
    raise exception 'ROTATION FAILED: round 2 eligibility is wrong %', j -> 'session' -> 'eligible';
  end if;
  perform pg_temp.expect_err(pg_temp.call_as((winner ->> 'memberId')::uuid, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', (j -> 'session' ->> 'drawId')::uuid, repeat('c', 64))),
    'draw_not_eligible', 'ROTATION winner cannot seal');
  j := pg_temp.expect_ok(pg_temp.call_as(mb2, 'authenticated', format(
    'select public.get_draw_cycle_v1(%L)::text', cycle_id)), 'ROTATION list');
  if jsonb_array_length(j -> 'draws') <> 2
     or (j -> 'cycle' ->> 'roundsRevealed')::int <> 1
     or (j -> 'cycle' ->> 'roundsPaid')::int <> 1
     or (j -> 'cycle' ->> 'nextRound')::int <> 2
     or (j -> 'draws' -> 0 ->> 'state') <> 'paid'
     or (j -> 'draws' -> 0 ->> 'winnerMemberId') <> winner ->> 'memberId'
     or (j -> 'draws' -> 1 ->> 'state') <> 'sealing' then
    raise exception 'ROTATION FAILED: unexpected listing %', j;
  end if;

  -- ISOLATION. A manager of another group (group B) can do nothing to group A's
  -- cycle or draw: open, commit, request the reveal, seal, release, read.
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.open_draw_v1(%L, null, %L)::text', cycle_id, 'iso-open')), 'draw_forbidden', 'ISOLATION open');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.open_draw_reveal_v1(%L, %L)::text', draw, commit_seed)), 'draw_forbidden', 'ISOLATION reveal request');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', (j -> 'draws' -> 1 ->> 'drawId')::uuid, repeat('d', 64))),
    'draw_forbidden', 'ISOLATION seal');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    (j -> 'draws' -> 1 ->> 'drawId')::uuid, repeat('1', 64), commit_nonce, roster_digest, member_digest,
    participants, 'iso-commit', 'v3')), 'draw_forbidden', 'ISOLATION commit');
  perform pg_temp.expect_err(pg_temp.call_as(out, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 1, 0, null, %L)::text', group_a, 'iso', '10.00', 'iso-cycle')),
    'draw_forbidden', 'ISOLATION create');
  r := pg_temp.call_as(out, 'authenticated',
    'select ((select count(*) from public.draw_sessions) + (select count(*) from public.draw_seals) + (select count(*) from public.draw_reveal_openings) + (select count(*) from public.draw_cycles where group_id <> ' || quote_literal(group_b) || '))::text');
  if r <> '0' then raise exception 'ISOLATION FAILED: the outsider can read % rows of group A', r; end if;

  -- IMMUTABLE. History cannot be rewritten even by a privileged update.
  begin
    update public.draw_seals set sealed = repeat('f', 64) where draw_id = draw;
    raise exception 'IMMUTABLE FAILED: a seal changed after the commit';
  exception when others then
    if sqlerrm not like '%draw_history_immutable%' then raise; end if;
  end;
  begin
    delete from public.draw_nonces where draw_id = draw;
    raise exception 'IMMUTABLE FAILED: a nonce was deleted';
  exception when others then
    if sqlerrm not like '%draw_history_immutable%' then raise; end if;
  end;
  begin
    update public.draw_reveal_openings set seed = 'x' where draw_id = draw;
    raise exception 'IMMUTABLE FAILED: an opening changed';
  exception when others then
    if sqlerrm not like '%draw_history_immutable%' then raise; end if;
  end;
  begin
    update public.draw_sessions set round = 3 where draw_id = draw;
    raise exception 'IMMUTABLE FAILED: a session changed';
  exception when others then
    if sqlerrm not like '%draw_history_immutable%' then raise; end if;
  end;

  perform set_config('sened.test.group_a', group_a::text, false);
end;
$lifecycle$;

-- A committer who holds the only seal is refused: with other members eligible, at
-- least one seal must come from somebody else.
do $solo$
declare
  own constant uuid := 'a1a1a1a1-0000-4000-8000-000000000001';
  tre constant uuid := 'a1a1a1a1-0000-4000-8000-000000000002';
  group_a constant uuid := current_setting('sened.test.group_a')::uuid;
  cycle_id uuid;
  draw uuid;
  j jsonb;
  seal text;
  participants jsonb;
  digest text;
begin
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 2, 0, null, %L)::text',
    group_a, 'Solo-seal cycle', '100.00', 'cyc-solo')), 'SOLO create');
  cycle_id := (j -> 'cycle' ->> 'cycleId')::uuid;
  j := pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.open_draw_v1(%L, null, %L)::text', cycle_id, 'open-solo')), 'SOLO open');
  draw := (j -> 'session' ->> 'drawId')::uuid;
  seal := public.sened_draw_member_seal_hash(draw, tre, 'treasurer-own-nonce-0123456789');
  perform pg_temp.expect_ok(pg_temp.call_as(tre, 'authenticated', format(
    'select public.submit_draw_seal_v1(%L, %L)::text', draw, seal)), 'SOLO seal');
  participants := (
    select jsonb_agg(jsonb_build_object(
      'memberId', e.member_id, 'displayName', 'M', 'contributionAmount', '100.00',
      'ticket', public.sened_draw_ticket(group_a, cycle_id, e.member_id)) order by e.member_id::text)
    from public.sened_draw_eligible_members(group_a, cycle_id, 1) as e(member_id));
  digest := public.sened_draw_member_set_digest(draw, jsonb_build_array(jsonb_build_object('memberId', tre, 'sealed', seal)));
  perform pg_temp.expect_err(pg_temp.call_as(tre, 'authenticated', format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, now(), %L)::text',
    draw, repeat('2', 64), 'solo-commit-nonce-0123456789', repeat('3', 64), digest, participants, 'commit-solo', 'v3')),
    'draw_member_commitment_missing', 'SOLO committer holding the only seal');
  if exists (select 1 from public.draw_commitments where draw_id = draw) then
    raise exception 'SOLO FAILED: the commit was accepted';
  end if;
end;
$solo$;

-- Parity with the TypeScript engine. The same literals are asserted in
-- test/draw.sql-parity.test.ts against the real engine, so a change to either
-- side's canonical encoding fails one of the two.
do $parity$
begin
  if public.sened_draw_member_seal_hash(
       'dddddddd-0000-4000-8000-0000000000d1', '44444444-4444-4444-8444-444444444444',
       'nonce-one-0123456789-abcdef'
     ) <> '8cfcb97d951fb4cea06db44c7fe86b4f273689a95eaf65732d83aa5288a5b3cb' then
    raise exception 'PARITY 1 FAILED: the member seal hash differs from the TypeScript engine';
  end if;
  if public.sened_draw_member_set_digest(
       'dddddddd-0000-4000-8000-0000000000d1',
       jsonb_build_array(
         jsonb_build_object('memberId', '44444444-4444-4444-8444-444444444444',
           'sealed', '8cfcb97d951fb4cea06db44c7fe86b4f273689a95eaf65732d83aa5288a5b3cb'),
         jsonb_build_object('memberId', '22222222-2222-4222-8222-222222222222',
           'sealed', 'c9e33496edfcb517ab3e593fcef93050c92adfb99a09650e1e5a4582dbd5e7af'))
     ) <> '339c57dc558400ed5953ada9573a443af7a518f00bf770c49f4b8edc7091cf69' then
    raise exception 'PARITY 2 FAILED: the member set digest differs from the TypeScript engine';
  end if;
  if public.sened_draw_commit_hash_v3(
       'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 2,
       'dddddddd-0000-4000-8000-0000000000d1', repeat('ab', 32), 'commit-nonce-0123456789',
       '339c57dc558400ed5953ada9573a443af7a518f00bf770c49f4b8edc7091cf69',
       'seed-value-0123456789-xyz'
     ) <> 'ce2934b0af978095526e317c3d13b37072517f55c1e827324ac4efb7c6a9f7bb' then
    raise exception 'PARITY 3 FAILED: the commitment hash differs from the TypeScript engine';
  end if;
  if public.sened_draw_ticket(
       'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1',
       '44444444-4444-4444-8444-444444444444'
     ) <> 'acefb395ef8dcf1dee8a4830e74686ffd5318cddac32a121fca7e30ca837d518' then
    raise exception 'PARITY 4 FAILED: the ticket differs from the TypeScript engine';
  end if;
end;
$parity$;

-- Arity and grants: the class of defect that made the bank migration unappliable.
do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text)',
    'public.list_draw_cycles_v1(uuid)',
    'public.get_draw_cycle_v1(uuid)',
    'public.open_draw_v1(uuid, integer, text, text)',
    'public.get_draw_session_v1(uuid)',
    'public.submit_draw_seal_v1(uuid, text)',
    'public.submit_draw_nonce_v1(uuid, text)',
    'public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text)',
    'public.open_draw_reveal_v1(uuid, text)'
  ] loop
    if not has_function_privilege('authenticated', fn, 'EXECUTE') then
      raise exception 'GRANTS FAILED: authenticated cannot execute %', fn;
    end if;
    if has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception 'GRANTS FAILED: anon can execute %', fn;
    end if;
  end loop;
  foreach fn in array array[
    'public.sened_draw_member_seal_hash(uuid, uuid, text)',
    'public.sened_draw_member_set_digest(uuid, jsonb)',
    'public.sened_draw_commit_hash_v3(uuid, uuid, integer, uuid, text, text, text, text)',
    'public.sened_draw_ticket(uuid, uuid, uuid)',
    'public.sened_draw_eligible_members(uuid, uuid, integer)',
    'public.sened_draw_session_view(uuid)'
  ] loop
    if has_function_privilege('authenticated', fn, 'EXECUTE') or has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception 'GRANTS FAILED: the internal helper % is callable by a client role', fn;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.draw_nonces', 'SELECT')
     or has_table_privilege('anon', 'public.draw_nonces', 'SELECT')
     or has_table_privilege('authenticated', 'public.draw_nonces', 'INSERT') then
    raise exception 'GRANTS FAILED: a client role has a privilege on draw_nonces';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.draw_nonces'::regclass) then
    raise exception 'GRANTS FAILED: draw_nonces has no row level security';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'draw_nonces') then
    raise exception 'GRANTS FAILED: draw_nonces has a policy, so some role could read it';
  end if;
end;
$grants$;

select 'ALL DRAW CYCLE AND SEAL CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Ledger entry provenance (20261006100000_ledger_entry_provenance.sql)
--
-- A member must be able to learn that ANOTHER member's contribution was bank
-- verified, without the intents table being opened to them and without any
-- form of the provider reference leaving the database. Checks that the
-- SECURITY DEFINER read function (a) returns provenance only for VERIFIED
-- intents linked to an entry, with exactly the six safe fields, (b) is scoped
-- to group membership (an outsider is refused, another group's id returns
-- nothing), (c) never returns a reference, HMAC or ciphertext, (d) leaves the
-- intents table unreadable to members, (e) is not callable by anon, and that
-- the backfill links only a matching, unlinked VERIFIED intent and is
-- idempotent. Runs in a transaction that is rolled back.
-- ---------------------------------------------------------------------------
reset role;
begin;
select set_config('request.jwt.claim.sub', '', true);

do $prov$
declare
  owner_uid  constant text := '11111111-1111-4111-8111-111111111111';
  other_uid  constant text := '22222222-2222-4222-8222-222222222222';
  viewer_uid constant text := '33333333-3333-4333-8333-333333333333';
  outsider   constant text := '44444444-4444-4444-8444-444444444444';
  group_p    uuid;
  group_q    uuid;
  cash_p     uuid;
  income_p   uuid;
  tenant_p   uuid;
  binding_p  uuid := 'cccccccc-0000-4000-8000-0000000000e1';
  e_bank     uuid;
  e_pending  uuid;
  e_manual   uuid;
  e_orphan   uuid;
  e_other    uuid;
  result     jsonb;
  n          bigint;
  secret_ref constant text := repeat('9', 64);
begin
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  group_p := (public.sened_ledger_provision_group_v1('Provenance equb') ->> 'groupId')::uuid;
  perform set_config('request.jwt.claim.sub', other_uid, true);
  group_q := (public.sened_ledger_provision_group_v1('Other provenance equb') ->> 'groupId')::uuid;
  select tenant_id into tenant_p from public.ledger_groups where id = group_p;
  select id into cash_p from public.ledger_accounts where group_id = group_p and code = 'POT_CASH';
  select id into income_p from public.ledger_accounts where group_id = group_p and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role)
  values (group_p, tenant_p, viewer_uid::uuid, 'member');

  -- Five entries in group P. Only e_bank and e_orphan have bank-style keys.
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  e_bank := (public.post_ledger_entry_v1(group_p, 'bank-verified-prov-1', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_p, 'direction', 'debit', 'amount', '25.00'),
                      jsonb_build_object('accountId', income_p, 'direction', 'credit', 'amount', '25.00'))) -> 'entry' ->> 'id')::uuid;
  e_pending := (public.post_ledger_entry_v1(group_p, 'bank-verified-prov-2', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_p, 'direction', 'debit', 'amount', '30.00'),
                      jsonb_build_object('accountId', income_p, 'direction', 'credit', 'amount', '30.00'))) -> 'entry' ->> 'id')::uuid;
  e_manual := (public.post_ledger_entry_v1(group_p, 'manual-prov-3', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_p, 'direction', 'debit', 'amount', '40.00'),
                      jsonb_build_object('accountId', income_p, 'direction', 'credit', 'amount', '40.00'))) -> 'entry' ->> 'id')::uuid;
  e_orphan := (public.post_ledger_entry_v1(group_p, 'bank-verified-prov-4', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_p, 'direction', 'debit', 'amount', '50.00'),
                      jsonb_build_object('accountId', income_p, 'direction', 'credit', 'amount', '50.00'))) -> 'entry' ->> 'id')::uuid;
  e_other := (public.post_ledger_entry_v1(group_p, 'bank-verified-prov-5', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_p, 'direction', 'debit', 'amount', '60.00'),
                      jsonb_build_object('accountId', income_p, 'direction', 'credit', 'amount', '60.00'))) -> 'entry' ->> 'id')::uuid;

  -- Superuser fixtures: a binding and four intents owned by the group owner.
  reset role;
  insert into public.bank_account_bindings (id,user_id,tenant_id,group_id,ledger_account_id,provider,account_label,account_fingerprint_hmac,sender_fingerprint_hmac,receiver_fingerprint_hmac)
  values (binding_p, owner_uid::uuid, tenant_p, group_p, cash_p, 'cbe', 'P', repeat('a',64), repeat('b',64), repeat('c',64));
  insert into public.bank_verification_intents (id,user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at)
  values
    ('dddddddd-0000-4000-8000-0000000000e1', owner_uid::uuid, tenant_p, group_p, binding_p, cash_p, 'cbe', secret_ref,       'prov-1', repeat('e',64), 25.00, 'inbound', now()),
    ('dddddddd-0000-4000-8000-0000000000e2', owner_uid::uuid, tenant_p, group_p, binding_p, cash_p, 'cbe', repeat('8',64),    'prov-2', repeat('e',64), 30.00, 'inbound', now()),
    ('dddddddd-0000-4000-8000-0000000000e4', owner_uid::uuid, tenant_p, group_p, binding_p, cash_p, 'cbe', repeat('7',64),    'prov-4', repeat('e',64), 50.00, 'inbound', now()),
    -- same key as e_other's entry but a different amount: must never be linked by the backfill
    ('dddddddd-0000-4000-8000-0000000000e5', owner_uid::uuid, tenant_p, group_p, binding_p, cash_p, 'cbe', repeat('6',64),    'prov-5', repeat('e',64), 61.00, 'inbound', now());
  -- e1: verified and linked (the normal path). e2: still pending, no link.
  -- e4 and e5: verified but never linked (the post succeeded, the result was not stored).
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('1',64), verified_at = '2026-10-06 09:00:05.123+00',
      ledger_entry_id = e_bank
  where id = 'dddddddd-0000-4000-8000-0000000000e1';
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('2',64), verified_at = now()
  where id = 'dddddddd-0000-4000-8000-0000000000e4';
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('3',64), verified_at = now()
  where id = 'dddddddd-0000-4000-8000-0000000000e5';

  -- ---- A plain member (not the payer) reads provenance for the group --------
  perform set_config('request.jwt.claim.sub', viewer_uid, true);
  set local role authenticated;
  result := public.get_ledger_entry_provenance_v1(group_p, array[e_bank, e_pending, e_manual, e_orphan, e_other]);
  if jsonb_array_length(result) <> 1 then
    raise exception 'PROVENANCE 1 FAILED: expected exactly the linked verified entry, got %', result;
  end if;
  if (result -> 0 ->> 'entryId')::uuid <> e_bank
     or result -> 0 ->> 'verificationId' <> 'dddddddd-0000-4000-8000-0000000000e1'
     or result -> 0 ->> 'provider' <> 'cbe'
     or result -> 0 ->> 'memberUserId' <> owner_uid
     or result -> 0 ->> 'verifiedAt' <> '2026-10-06T09:00:05.123Z' then
    raise exception 'PROVENANCE 2 FAILED: wrong content %', result;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(result -> 0) k)
     is distinct from array['entryId','memberUserId','provider','referenceMasked','verificationId','verifiedAt'] then
    raise exception 'PROVENANCE 3 FAILED: unexpected fields %', result -> 0;
  end if;
  -- no form of the stored reference or evidence is in the response
  if result::text like '%' || secret_ref || '%' or result::text like '%' || repeat('f',64) || '%'
     or result::text like '%' || repeat('1',64) || '%' or replace(result::text, 'referenceMasked', '') ~* '(hmac|ciphertext|reference|fingerprint|idempotency)' then
    raise exception 'PROVENANCE 4 FAILED: the response leaks reference material: %', result;
  end if;

  -- an empty or null id list is empty, not an error; more than 500 is refused
  if public.get_ledger_entry_provenance_v1(group_p, array[]::uuid[]) <> '[]'::jsonb
     or public.get_ledger_entry_provenance_v1(group_p, null) <> '[]'::jsonb then
    raise exception 'PROVENANCE 5 FAILED: empty input was not an empty result';
  end if;
  begin
    perform public.get_ledger_entry_provenance_v1(group_p, (select array_agg(gen_random_uuid()) from generate_series(1, 501)));
    raise exception 'PROVENANCE 6 FAILED: 501 ids were accepted';
  exception when sqlstate '22023' then null;
  end;

  -- the member still cannot read the intents table directly
  if has_table_privilege('authenticated', 'public.bank_verification_intents', 'SELECT') then
    raise exception 'PROVENANCE 7 FAILED: authenticated can select bank_verification_intents';
  end if;
  begin
    perform 1 from public.bank_verification_intents limit 1;
    raise exception 'PROVENANCE 8 FAILED: a member read the intents table';
  exception when insufficient_privilege then null;
  end;

  -- ---- Isolation -------------------------------------------------------------
  -- An outsider to group P is refused outright.
  perform set_config('request.jwt.claim.sub', outsider, true);
  begin
    perform public.get_ledger_entry_provenance_v1(group_p, array[e_bank]);
    raise exception 'PROVENANCE 9 FAILED: an outsider read group P provenance';
  exception when sqlstate '42501' then null;
  end;
  -- The owner of another group asking for group P's entry under THEIR group gets nothing.
  perform set_config('request.jwt.claim.sub', other_uid, true);
  if public.get_ledger_entry_provenance_v1(group_q, array[e_bank]) <> '[]'::jsonb then
    raise exception 'PROVENANCE 10 FAILED: group Q saw group P provenance';
  end if;
  -- ...and is refused when naming group P.
  begin
    perform public.get_ledger_entry_provenance_v1(group_p, array[e_bank]);
    raise exception 'PROVENANCE 11 FAILED: the other group owner read group P provenance';
  exception when sqlstate '42501' then null;
  end;
  -- No identity at all.
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.get_ledger_entry_provenance_v1(group_p, array[e_bank]);
    raise exception 'PROVENANCE 12 FAILED: an anonymous caller read provenance';
  exception when sqlstate '28000' then null;
  end;

  reset role;
  if has_function_privilege('anon', 'public.get_ledger_entry_provenance_v1(uuid, uuid[])', 'EXECUTE') then
    raise exception 'PROVENANCE 13 FAILED: anon can execute the provenance function';
  end if;
  if not has_function_privilege('authenticated', 'public.get_ledger_entry_provenance_v1(uuid, uuid[])', 'EXECUTE') then
    raise exception 'PROVENANCE 14 FAILED: authenticated cannot execute the provenance function';
  end if;

  -- ---- Backfill (the migration's UPDATE, run again over fixtures it has not seen) ----
  -- e4 matches (same group, key, actor, type, debit amount) and is linked;
  -- e5's amount differs from its entry, so it stays unlinked; e1 is untouched.
  update public.bank_verification_intents intent_row
  set ledger_entry_id = entry_row.id
  from public.ledger_entries entry_row
  where intent_row.state = 'VERIFIED'
    and intent_row.ledger_entry_id is null
    and entry_row.group_id = intent_row.group_id
    and entry_row.idempotency_key = 'bank-verified-' || intent_row.idempotency_key
    and entry_row.actor_id = intent_row.user_id
    and entry_row.entry_type = case intent_row.direction when 'inbound' then 'contribution' else 'disbursement' end
    and exists (
      select 1 from public.ledger_entry_postings posting_row
      where posting_row.entry_id = entry_row.id and posting_row.direction = 'debit' and posting_row.amount = intent_row.amount
    );
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'BACKFILL 1 FAILED: expected 1 intent linked, got %', n; end if;
  if (select ledger_entry_id from public.bank_verification_intents where id = 'dddddddd-0000-4000-8000-0000000000e4') is distinct from e_orphan then
    raise exception 'BACKFILL 2 FAILED: the matching intent was not linked to its entry';
  end if;
  if (select ledger_entry_id from public.bank_verification_intents where id = 'dddddddd-0000-4000-8000-0000000000e5') is not null then
    raise exception 'BACKFILL 3 FAILED: a mismatched amount was linked';
  end if;
  if (select ledger_entry_id from public.bank_verification_intents where id = 'dddddddd-0000-4000-8000-0000000000e2') is not null then
    raise exception 'BACKFILL 4 FAILED: a PENDING intent was linked';
  end if;

  -- The backfilled link is then visible to a member.
  perform set_config('request.jwt.claim.sub', viewer_uid, true);
  set local role authenticated;
  if jsonb_array_length(public.get_ledger_entry_provenance_v1(group_p, array[e_bank, e_orphan])) <> 2 then
    raise exception 'BACKFILL 5 FAILED: the backfilled entry has no provenance';
  end if;
  reset role;
end;
$prov$;
rollback;
select 'ALL LEDGER PROVENANCE CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Ledger balances (20261007100000_ledger_balances.sql)
--
-- get_ledger_balances_v1 replaces "sum the entries list" for the home screen and
-- /draw, so it has to be exactly the sum of the postings, in one consistent
-- snapshot, and visible only to the group's members. Checks that (a) every
-- account's balance equals an independently computed sum of its postings, to
-- the cent, in debit-positive form, including a non-round amount, a
-- disbursement, a correction and a ledger of more than 100 entries (the old
-- cap), (b) debits equal credits overall, so the balances net to zero across
-- accounts, (c) the head sequence and entry count are the chain head's and the
-- entries' own, and the balances are the balances AT that head, (d) a fresh
-- group lists every account at 0.00 with head 0, (e) posting moves head, count
-- and the two affected balances by exactly the posted amount, (f) members of the
-- group (owner and plain member) can read it, an outsider, another group's
-- owner and an anonymous caller are refused, and anon cannot execute it, and
-- (g) the result carries exactly the documented keys. Runs in a transaction
-- that is rolled back.
-- ---------------------------------------------------------------------------
reset role;
begin;
select set_config('request.jwt.claim.sub', '', true);

do $bal$
declare
  owner_uid  constant text := '11111111-1111-4111-8111-111111111111';
  other_uid  constant text := '22222222-2222-4222-8222-222222222222';
  viewer_uid constant text := '33333333-3333-4333-8333-333333333333';
  outsider   constant text := '44444444-4444-4444-8444-444444444444';
  group_b    uuid;
  group_c    uuid;
  tenant_b   uuid;
  cash_b     uuid;
  income_b   uuid;
  expense_b  uuid;
  e_first    uuid;
  result     jsonb;
  later      jsonb;
  n          bigint;
  head_seq   bigint;
  expected   numeric;
  got        numeric;
  shift      numeric;
  acct       record;
  i          int;
begin
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  group_b := (public.sened_ledger_provision_group_v1('Balances equb') ->> 'groupId')::uuid;
  perform set_config('request.jwt.claim.sub', other_uid, true);
  group_c := (public.sened_ledger_provision_group_v1('Empty balances equb') ->> 'groupId')::uuid;
  select tenant_id into tenant_b from public.ledger_groups where id = group_b;
  select id into cash_b from public.ledger_accounts where group_id = group_b and code = 'POT_CASH';
  select id into income_b from public.ledger_accounts where group_id = group_b and code = 'CONTRIBUTION_INCOME';
  select id into expense_b from public.ledger_accounts where group_id = group_b and code = 'PAYOUT_EXPENSE';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role)
  values (group_b, tenant_b, viewer_uid::uuid, 'member');

  -- ---- A fresh group: head 0, every account listed at 0.00 --------------------
  perform set_config('request.jwt.claim.sub', other_uid, true);
  result := public.get_ledger_balances_v1(group_c);
  if result ->> 'headSequence' <> '0' or result ->> 'entryCount' <> '0' then
    raise exception 'BALANCES 1 FAILED: an empty group reported head % count %', result ->> 'headSequence', result ->> 'entryCount';
  end if;
  select count(*) into n from public.ledger_accounts where group_id = group_c;
  if jsonb_array_length(result -> 'balances') <> n or n = 0 then
    raise exception 'BALANCES 2 FAILED: an empty group did not list all % accounts', n;
  end if;
  if exists (select 1 from jsonb_array_elements(result -> 'balances') b where b ->> 'balance' <> '0.00') then
    raise exception 'BALANCES 3 FAILED: an empty group has a balance that is not exactly 0.00';
  end if;
  if result ->> 'groupId' <> group_c::text then
    raise exception 'BALANCES 3b FAILED: the group id is not echoed';
  end if;

  -- ---- Fixtures: round, non-round, disbursement, correction, then 120 more ----
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  e_first := (public.post_ledger_entry_v1(group_b, 'bal-1', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_b, 'direction', 'debit', 'amount', '25.00'),
                      jsonb_build_object('accountId', income_b, 'direction', 'credit', 'amount', '25.00'))) -> 'entry' ->> 'id')::uuid;
  perform public.post_ledger_entry_v1(group_b, 'bal-2', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_b, 'direction', 'debit', 'amount', '1234567890123.45'),
                      jsonb_build_object('accountId', income_b, 'direction', 'credit', 'amount', '1234567890123.45')));
  perform public.post_ledger_entry_v1(group_b, 'bal-3', now(), 'disbursement', null, null,
    jsonb_build_array(jsonb_build_object('accountId', expense_b, 'direction', 'debit', 'amount', '100.25'),
                      jsonb_build_object('accountId', cash_b, 'direction', 'credit', 'amount', '100.25')));
  perform public.post_ledger_entry_v1(group_b, 'bal-4', now(), 'correction', e_first, 'Wrong amount recorded',
    jsonb_build_array(jsonb_build_object('accountId', income_b, 'direction', 'debit', 'amount', '25.00'),
                      jsonb_build_object('accountId', cash_b, 'direction', 'credit', 'amount', '25.00')));
  for i in 1..120 loop
    perform public.post_ledger_entry_v1(group_b, 'bal-bulk-' || i, now(), 'contribution', null, null,
      jsonb_build_array(jsonb_build_object('accountId', cash_b, 'direction', 'debit', 'amount', '0.07'),
                        jsonb_build_object('accountId', income_b, 'direction', 'credit', 'amount', '0.07')));
  end loop;

  -- ---- (a) every balance is the independent sum of its postings --------------
  result := public.get_ledger_balances_v1(group_b);
  for acct in
    select a.id, a.code, a.account_type
    from public.ledger_accounts a where a.group_id = group_b
  loop
    select coalesce(sum(case p.direction when 'debit' then p.amount else -p.amount end), 0) into expected
    from public.ledger_entry_postings p where p.group_id = group_b and p.account_id = acct.id;
    select (b ->> 'balance')::numeric into got
    from jsonb_array_elements(result -> 'balances') b where (b ->> 'accountId')::uuid = acct.id;
    if got is null or got <> expected then
      raise exception 'BALANCES 4 FAILED: % balance % <> sum of postings %', acct.code, got, expected;
    end if;
    if (select b ->> 'balance' from jsonb_array_elements(result -> 'balances') b where (b ->> 'accountId')::uuid = acct.id)
       <> to_char(expected, 'FM9999999999999999999990.00') then
      raise exception 'BALANCES 5 FAILED: % balance is not rendered as an exact two-decimal string', acct.code;
    end if;
    if (select b ->> 'accountType' from jsonb_array_elements(result -> 'balances') b where (b ->> 'accountId')::uuid = acct.id)
       <> acct.account_type then
      raise exception 'BALANCES 6 FAILED: % reports the wrong account type', acct.code;
    end if;
  end loop;

  -- Known value on the pot: 25.00 + 1234567890123.45 - 100.25 - 25.00 + 120 * 0.07 = 1234567890031.60.
  if (select b ->> 'balance' from jsonb_array_elements(result -> 'balances') b where b ->> 'code' = 'POT_CASH') <> '1234567890031.60' then
    raise exception 'BALANCES 7 FAILED: POT_CASH is %', (select b ->> 'balance' from jsonb_array_elements(result -> 'balances') b where b ->> 'code' = 'POT_CASH');
  end if;
  -- Debit-positive for every type: the income account is negative, the expense account positive.
  if (select (b ->> 'balance')::numeric from jsonb_array_elements(result -> 'balances') b where b ->> 'code' = 'CONTRIBUTION_INCOME') >= 0 then
    raise exception 'BALANCES 8 FAILED: the income account is not credit-negative';
  end if;
  if (select b ->> 'balance' from jsonb_array_elements(result -> 'balances') b where b ->> 'code' = 'PAYOUT_EXPENSE') <> '100.25' then
    raise exception 'BALANCES 9 FAILED: the expense account is not debit-positive';
  end if;

  -- ---- (b) debits = credits: the balances net to zero across accounts --------
  select coalesce(sum((b ->> 'balance')::numeric), 0) into got from jsonb_array_elements(result -> 'balances') b;
  if got <> 0 then raise exception 'BALANCES 10 FAILED: balances net to % across accounts, not 0', got; end if;
  if (select sum(amount) from public.ledger_entry_postings where group_id = group_b and direction = 'debit')
     <> (select sum(amount) from public.ledger_entry_postings where group_id = group_b and direction = 'credit') then
    raise exception 'BALANCES 11 FAILED: total debits differ from total credits';
  end if;

  -- ---- (c) head and count are the chain's own, and the balances are AT that head ----
  select last_sequence into head_seq from public.ledger_group_heads where group_id = group_b;
  if (result ->> 'headSequence')::bigint <> head_seq then
    raise exception 'BALANCES 12 FAILED: headSequence % <> chain head %', result ->> 'headSequence', head_seq;
  end if;
  select count(*) into n from public.ledger_entries where group_id = group_b;
  if (result ->> 'entryCount')::bigint <> n or n <= 100 then
    raise exception 'BALANCES 13 FAILED: entryCount % vs % entries (must exceed the old 100 cap)', result ->> 'entryCount', n;
  end if;
  if (select max(sequence) from public.ledger_entries where group_id = group_b) <> head_seq then
    raise exception 'BALANCES 14 FAILED: the head is not the newest entry';
  end if;
  -- Balances recomputed from only the entries up to the reported head equal the reported balances.
  for acct in select a.id, a.code from public.ledger_accounts a where a.group_id = group_b loop
    select coalesce(sum(case p.direction when 'debit' then p.amount else -p.amount end), 0) into expected
    from public.ledger_entry_postings p
    join public.ledger_entries e on e.id = p.entry_id and e.group_id = p.group_id
    where p.group_id = group_b and p.account_id = acct.id and e.sequence <= (result ->> 'headSequence')::bigint;
    select (b ->> 'balance')::numeric into got
    from jsonb_array_elements(result -> 'balances') b where (b ->> 'accountId')::uuid = acct.id;
    if got <> expected then raise exception 'BALANCES 15 FAILED: % is not the balance at the reported head', acct.code; end if;
  end loop;

  -- ---- (e) one more entry moves head, count and exactly two balances by the amount ----
  perform public.post_ledger_entry_v1(group_b, 'bal-after', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_b, 'direction', 'debit', 'amount', '10.10'),
                      jsonb_build_object('accountId', income_b, 'direction', 'credit', 'amount', '10.10')));
  later := public.get_ledger_balances_v1(group_b);
  if (later ->> 'headSequence')::bigint <> head_seq + 1 or (later ->> 'entryCount')::bigint <> n + 1 then
    raise exception 'BALANCES 16 FAILED: head/count did not advance by one';
  end if;
  for acct in select a.id, a.code from public.ledger_accounts a where a.group_id = group_b loop
    select (b ->> 'balance')::numeric into got from jsonb_array_elements(later -> 'balances') b where (b ->> 'accountId')::uuid = acct.id;
    select (b ->> 'balance')::numeric into expected from jsonb_array_elements(result -> 'balances') b where (b ->> 'accountId')::uuid = acct.id;
    shift := case acct.code when 'POT_CASH' then 10.10 when 'CONTRIBUTION_INCOME' then -10.10 else 0 end;
    if got - expected <> shift then
      raise exception 'BALANCES 17 FAILED: % moved by % after a 10.10 contribution', acct.code, got - expected;
    end if;
  end loop;

  -- ---- (g) exactly the documented keys ----------------------------------------
  if (select array_agg(k order by k) from jsonb_object_keys(later) k) <> array['balances','entryCount','groupId','headSequence'] then
    raise exception 'BALANCES 18 FAILED: unexpected top-level keys';
  end if;
  if exists (
    select 1 from jsonb_array_elements(later -> 'balances') b
    where (select array_agg(k order by k) from jsonb_object_keys(b) k) <> array['accountId','accountType','balance','code','name']
  ) then
    raise exception 'BALANCES 19 FAILED: unexpected per-account keys';
  end if;

  -- ---- (f) access: members read; outsiders, other owners and anonymous callers are refused ----
  perform set_config('request.jwt.claim.sub', viewer_uid, true);
  set local role authenticated;
  if public.get_ledger_balances_v1(group_b) ->> 'headSequence' <> later ->> 'headSequence' then
    raise exception 'BALANCES 20 FAILED: a plain member did not read the same snapshot';
  end if;
  reset role;

  perform set_config('request.jwt.claim.sub', owner_uid, true);
  set local role authenticated;
  if public.get_ledger_balances_v1(group_b) ->> 'entryCount' <> later ->> 'entryCount' then
    raise exception 'BALANCES 21 FAILED: the owner did not read the same snapshot';
  end if;
  reset role;

  perform set_config('request.jwt.claim.sub', outsider, true);
  set local role authenticated;
  begin
    perform public.get_ledger_balances_v1(group_b);
    raise exception 'BALANCES 22 FAILED: an outsider read group B balances';
  exception when sqlstate '42501' then null;
  end;
  reset role;

  -- Another group's owner is refused for group B, and an unknown group is refused identically.
  perform set_config('request.jwt.claim.sub', other_uid, true);
  set local role authenticated;
  begin
    perform public.get_ledger_balances_v1(group_b);
    raise exception 'BALANCES 23 FAILED: another group''s owner read group B balances';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform public.get_ledger_balances_v1('eeeeeeee-0000-4000-8000-00000000dead');
    raise exception 'BALANCES 24 FAILED: an unknown group did not raise';
  exception when sqlstate '42501' then null;
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.get_ledger_balances_v1(group_b);
    raise exception 'BALANCES 25 FAILED: an anonymous caller read balances';
  exception when sqlstate '28000' then null;
  end;
  reset role;

  if has_function_privilege('anon', 'public.get_ledger_balances_v1(uuid)', 'EXECUTE') then
    raise exception 'BALANCES 26 FAILED: anon can execute the balances function';
  end if;
  if has_function_privilege('public', 'public.get_ledger_balances_v1(uuid)', 'EXECUTE') then
    raise exception 'BALANCES 27 FAILED: PUBLIC can execute the balances function';
  end if;
  if not has_function_privilege('authenticated', 'public.get_ledger_balances_v1(uuid)', 'EXECUTE') then
    raise exception 'BALANCES 28 FAILED: authenticated cannot execute the balances function';
  end if;
end;
$bal$;
rollback;
select 'ALL LEDGER BALANCES CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Masked bank reference display (20261008100000_bank_reference_display.sql)
--
-- The verified badge shows "••••2F42". Checks that (a) the CHECK constraint
-- accepts only the masked shape - four bullets then 1-4 printable ASCII
-- characters - so a full reference, a 5-character tail, an unmasked value, a
-- value with surrounding text or a trailing newline can never be stored, while
-- NULL and a well-formed mask can, (b) the create RPC stores the display it is
-- given, still works with the original ten arguments (display NULL), refuses an
-- unmasked display with bank_invalid_request, and replays idempotently without
-- changing the stored display, (c) there is exactly one create function (an
-- overload would be ambiguous to PostgREST), still executable by authenticated
-- and not by anon, (d) the intent response exposes the display and no other
-- reference material changes, (e) a plain group member reads the masked value
-- through the provenance function, a verified intent with no display yields
-- null, and the plaintext reference, its HMAC and its ciphertext appear in
-- neither response. Runs in a transaction that is rolled back.
-- ---------------------------------------------------------------------------
reset role;
begin;
select set_config('request.jwt.claim.sub', '', true);

do $refd$
declare
  owner_uid  constant text := '11111111-1111-4111-8111-111111111111';
  viewer_uid constant text := '33333333-3333-4333-8333-333333333333';
  group_r    uuid;
  tenant_r   uuid;
  cash_r     uuid;
  income_r   uuid;
  binding_r  uuid := 'cccccccc-0000-4000-8000-0000000000f1';
  mask       constant text := U&'\2022\2022\2022\20222F42';
  full_ref   constant text := 'FT26280ABCD2F42';
  full_hmac  constant text := repeat('d', 64);
  res        jsonb;
  res2       jsonb;
  v_id       uuid;
  v_id2      uuid;
  entry_1    uuid;
  entry_2    uuid;
  prov       jsonb;
  occurred_1 timestamptz;
  n          int;
begin
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  group_r := (public.sened_ledger_provision_group_v1('Reference display equb') ->> 'groupId')::uuid;
  select tenant_id into tenant_r from public.ledger_groups where id = group_r;
  select id into cash_r from public.ledger_accounts where group_id = group_r and code = 'POT_CASH';
  select id into income_r from public.ledger_accounts where group_id = group_r and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role)
  values (group_r, tenant_r, viewer_uid::uuid, 'member');
  reset role;
  insert into public.bank_account_bindings (id,user_id,tenant_id,group_id,ledger_account_id,provider,account_label,account_fingerprint_hmac,sender_fingerprint_hmac,receiver_fingerprint_hmac)
  values (binding_r, owner_uid::uuid, tenant_r, group_r, cash_r, 'telebirr', 'R', repeat('a',64), repeat('b',64), repeat('c',64));

  -- ---- (a) the CHECK constraint ----------------------------------------------
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'bank_verification_intents'
                   and column_name = 'reference_display' and is_nullable = 'YES' and data_type = 'text') then
    raise exception 'REFDISPLAY 1 FAILED: reference_display is missing or not a nullable text column';
  end if;
  -- Every case below inserts a fresh row; each refused one must name the constraint.
  declare
    bad text;
    i int := 0;
  begin
    foreach bad in array array[
      full_ref,                                  -- the full reference
      'TXN2F42',                                 -- no bullets
      U&'\2022\2022\2022\2022',                -- bullets, nothing visible
      U&'\2022\2022\2022\202212345',           -- 5 visible characters
      U&'\2022\2022\2022\2022AB' || E'\n',     -- trailing newline
      U&'\2022\2022\2022AB',                    -- three bullets only
      U&'\2022\2022\2022\2022\2022AB',          -- five bullets
      'x' || U&'\2022\2022\2022\2022AB',        -- text before the bullets
      U&'\2022\2022\2022\2022A B',              -- a space in the tail
      U&'\2022\2022\2022\2022\00E9A',            -- non-ASCII in the tail
      '',                                        -- empty
      repeat('9', 64)                            -- looks like an HMAC
    ] loop
      i := i + 1;
      begin
        insert into public.bank_verification_intents (user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at,reference_display)
        values (owner_uid::uuid, tenant_r, group_r, binding_r, cash_r, 'telebirr', repeat(to_hex(i), 64), 'refd-bad-' || i, repeat('e',64), 5.00, 'inbound', now(), bad);
        raise exception 'REFDISPLAY 2 FAILED: the value at position % was stored: %', i, bad;
      exception when check_violation then
        if sqlerrm not like '%bank_intents_reference_display_masked%' then
          raise exception 'REFDISPLAY 2 FAILED: position % refused by the wrong constraint: %', i, sqlerrm;
        end if;
      end;
    end loop;
  end;
  insert into public.bank_verification_intents (user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at,reference_display)
  values
    (owner_uid::uuid, tenant_r, group_r, binding_r, cash_r, 'telebirr', repeat('1', 64), 'refd-ok-null', repeat('e',64), 5.00, 'inbound', now(), null),
    (owner_uid::uuid, tenant_r, group_r, binding_r, cash_r, 'telebirr', repeat('2', 64), 'refd-ok-1', repeat('e',64), 5.00, 'inbound', now(), U&'\2022\2022\2022\2022F'),
    (owner_uid::uuid, tenant_r, group_r, binding_r, cash_r, 'telebirr', repeat('3', 64), 'refd-ok-4', repeat('e',64), 5.00, 'inbound', now(), mask);

  -- ---- (c) one create function, correct grants ---------------------------------
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'create_bank_verification_intent_v1';
  if n <> 1 then
    raise exception 'REFDISPLAY 3 FAILED: % create_bank_verification_intent_v1 overloads exist, expected 1', n;
  end if;
  if has_function_privilege('anon', 'public.create_bank_verification_intent_v1(uuid, text, text, text, text, numeric, text, text, timestamptz, text, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.create_bank_verification_intent_v1(uuid, text, text, text, text, numeric, text, text, timestamptz, text, text)', 'EXECUTE') then
    raise exception 'REFDISPLAY 4 FAILED: anon or PUBLIC can execute the create function';
  end if;
  if not has_function_privilege('authenticated', 'public.create_bank_verification_intent_v1(uuid, text, text, text, text, numeric, text, text, timestamptz, text, text)', 'EXECUTE') then
    raise exception 'REFDISPLAY 5 FAILED: authenticated cannot execute the create function';
  end if;

  -- ---- (b) the create RPC ------------------------------------------------------
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  set local role authenticated;
  -- with a display
  res := public.create_bank_verification_intent_v1(
    binding_r, 'telebirr', full_hmac, 'Y2lwaGVydGV4dC1ub3QtYS1yZWFsLW9uZQ==', 'v1', 100.00, 'ETB',
    'inbound', now(), 'refd-rpc-1', mask);
  v_id := (res -> 'intent' ->> 'verificationId')::uuid;
  reset role;
  select occurred_at into occurred_1 from public.bank_verification_intents where id = v_id;
  set local role authenticated;
  if res -> 'intent' ->> 'referenceDisplay' is distinct from mask or (res ->> 'replayed')::boolean then
    raise exception 'REFDISPLAY 6 FAILED: the display was not stored or returned: %', res;
  end if;
  -- the original ten arguments still work and store NULL
  res2 := public.create_bank_verification_intent_v1(
    binding_r, 'telebirr', repeat('7', 64), 'Y2lwaGVydGV4dC1ub3QtYS1yZWFsLXR3bw==', 'v1', 101.00, 'ETB',
    'inbound', now(), 'refd-rpc-2');
  v_id2 := (res2 -> 'intent' ->> 'verificationId')::uuid;
  if not (res2 -> 'intent') ? 'referenceDisplay' or res2 -> 'intent' -> 'referenceDisplay' <> 'null'::jsonb then
    raise exception 'REFDISPLAY 7 FAILED: an intent created without a display did not report null: %', res2;
  end if;
  -- an unmasked display is refused before anything is written
  begin
    perform public.create_bank_verification_intent_v1(
      binding_r, 'telebirr', repeat('6', 64), 'Y2lwaGVydGV4dA==', 'v1', 102.00, 'ETB',
      'inbound', now(), 'refd-rpc-3', full_ref);
    raise exception 'REFDISPLAY 8 FAILED: the RPC accepted a full reference as the display';
  exception when others then
    if sqlerrm like 'REFDISPLAY%' then raise; end if;
    if sqlerrm not like '%bank_invalid_request%' then
      raise exception 'REFDISPLAY 8 FAILED: refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  -- replay: same key and payload, a different display is ignored
  res := public.create_bank_verification_intent_v1(
    binding_r, 'telebirr', full_hmac, 'Y2lwaGVydGV4dC1ub3QtYS1yZWFsLW9uZQ==', 'v1', 100.00, 'ETB',
    'inbound', occurred_1, 'refd-rpc-1',
    U&'\2022\2022\2022\2022ZZZZ');
  reset role;
  if res ->> 'replayed' <> 'true' then
    raise exception 'REFDISPLAY 9 FAILED: expected a replay, got %', res;
  end if;
  if (select reference_display from public.bank_verification_intents where id = v_id) <> mask
     or res -> 'intent' ->> 'referenceDisplay' <> mask then
    raise exception 'REFDISPLAY 10 FAILED: a replay changed the stored display';
  end if;
  -- the get RPC (owner) reports it too
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  set local role authenticated;
  if public.get_bank_verification_intent_v1(v_id) ->> 'referenceDisplay' is distinct from mask then
    raise exception 'REFDISPLAY 11 FAILED: get_bank_verification_intent_v1 does not report the display';
  end if;
  reset role;

  -- ---- (e) provenance returns it to a plain member ----------------------------
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  entry_1 := (public.post_ledger_entry_v1(group_r, 'bank-verified-refd-rpc-1', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_r, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_r, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  entry_2 := (public.post_ledger_entry_v1(group_r, 'bank-verified-refd-rpc-2', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_r, 'direction', 'debit', 'amount', '101.00'),
                      jsonb_build_object('accountId', income_r, 'direction', 'credit', 'amount', '101.00'))) -> 'entry' ->> 'id')::uuid;
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('4',64), verified_at = now(), ledger_entry_id = entry_1
  where id = v_id;
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('5',64), verified_at = now(), ledger_entry_id = entry_2
  where id = v_id2;
  perform set_config('request.jwt.claim.sub', viewer_uid, true);
  set local role authenticated;
  prov := public.get_ledger_entry_provenance_v1(group_r, array[entry_1, entry_2]);
  reset role;
  if jsonb_array_length(prov) <> 2 then
    raise exception 'REFDISPLAY 12 FAILED: expected two provenance rows, got %', prov;
  end if;
  if (select r ->> 'referenceMasked' from jsonb_array_elements(prov) r where (r ->> 'entryId')::uuid = entry_1) is distinct from mask then
    raise exception 'REFDISPLAY 13 FAILED: the member did not receive the masked reference: %', prov;
  end if;
  if (select r -> 'referenceMasked' from jsonb_array_elements(prov) r where (r ->> 'entryId')::uuid = entry_2) <> 'null'::jsonb then
    raise exception 'REFDISPLAY 14 FAILED: a verified intent with no display did not yield null: %', prov;
  end if;
  if prov::text like '%' || full_ref || '%' or prov::text like '%' || full_hmac || '%'
     or prov::text like '%Y2lwaGVydGV4dC1ub3QtYS1yZWFsLW9uZQ%' or prov::text like '%ABCD%' then
    raise exception 'REFDISPLAY 15 FAILED: provenance leaks reference material: %', prov;
  end if;
  if res::text like '%' || full_ref || '%' then
    raise exception 'REFDISPLAY 16 FAILED: the intent response contains the full reference';
  end if;

  -- ---- (f) backfill helpers: service_role only, shape-checked, never overwrite ----
  if has_function_privilege('authenticated', 'public.list_bank_reference_display_backfill_v1(uuid, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.list_bank_reference_display_backfill_v1(uuid, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.set_bank_reference_display_v1(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_bank_reference_display_v1(uuid, text)', 'EXECUTE') then
    raise exception 'REFDISPLAY 17 FAILED: a backfill helper is executable by authenticated or anon';
  end if;
  if not has_function_privilege('service_role', 'public.list_bank_reference_display_backfill_v1(uuid, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.set_bank_reference_display_v1(uuid, text)', 'EXECUTE') then
    raise exception 'REFDISPLAY 18 FAILED: service_role cannot execute a backfill helper';
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
  -- the pending list holds exactly the rows with no display, with the five sealed-reference fields
  res := public.list_bank_reference_display_backfill_v1(null, 500);
  if exists (select 1 from jsonb_array_elements(res) r where (r ->> 'verificationId')::uuid = v_id) then
    raise exception 'REFDISPLAY 19 FAILED: a row that already has a display was listed';
  end if;
  if not exists (select 1 from jsonb_array_elements(res) r where (r ->> 'verificationId')::uuid = v_id2) then
    raise exception 'REFDISPLAY 20 FAILED: a row without a display was not listed';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys((select r from jsonb_array_elements(res) r limit 1)) k)
     is distinct from array['ciphertext','hmac','keyVersion','provider','verificationId'] then
    raise exception 'REFDISPLAY 21 FAILED: unexpected fields in the pending list: %', res -> 0;
  end if;
  -- limit is honoured, keyset paging moves forward, and nonsense limits are clamped, not errors
  if jsonb_array_length(public.list_bank_reference_display_backfill_v1(null, 1)) <> 1
     or jsonb_array_length(public.list_bank_reference_display_backfill_v1(null, 0)) <> 1
     or jsonb_array_length(public.list_bank_reference_display_backfill_v1(null, null)) < 1 then
    raise exception 'REFDISPLAY 22 FAILED: the limit was not honoured or clamped';
  end if;
  if jsonb_array_length(public.list_bank_reference_display_backfill_v1('ffffffff-ffff-4fff-8fff-ffffffffffff', 10)) <> 0 then
    raise exception 'REFDISPLAY 23 FAILED: paging past the last id returned rows';
  end if;
  -- the setter writes a mask once, never overwrites, refuses anything unmasked
  if public.set_bank_reference_display_v1(v_id2, U&'\2022\2022\2022\2022ABCD') is not true then
    raise exception 'REFDISPLAY 24 FAILED: the setter did not write to a row with no display';
  end if;
  if public.set_bank_reference_display_v1(v_id2, U&'\2022\2022\2022\2022WXYZ') is not false then
    raise exception 'REFDISPLAY 25 FAILED: the setter overwrote an existing display';
  end if;
  if public.set_bank_reference_display_v1(gen_random_uuid(), mask) is not false then
    raise exception 'REFDISPLAY 26 FAILED: the setter reported a write for an unknown id';
  end if;
  begin
    perform public.set_bank_reference_display_v1(v_id2, full_ref);
    raise exception 'REFDISPLAY 27 FAILED: the setter accepted a full reference';
  exception when others then
    if sqlerrm like 'REFDISPLAY%' then raise; end if;
    if sqlerrm not like '%bank_invalid_request%' then
      raise exception 'REFDISPLAY 27 FAILED: refused for the wrong reason: %', sqlerrm;
    end if;
  end;
  begin
    perform public.set_bank_reference_display_v1(v_id2, null);
    raise exception 'REFDISPLAY 28 FAILED: the setter accepted null';
  exception when others then
    if sqlerrm like 'REFDISPLAY%' then raise; end if;
  end;
  reset role;
  if (select reference_display from public.bank_verification_intents where id = v_id2) <> U&'\2022\2022\2022\2022ABCD' then
    raise exception 'REFDISPLAY 29 FAILED: the stored display is not the one written first';
  end if;
  -- and now the backfilled row shows up in provenance for a member
  perform set_config('request.jwt.claim.sub', viewer_uid, true);
  set local role authenticated;
  prov := public.get_ledger_entry_provenance_v1(group_r, array[entry_2]);
  reset role;
  if prov -> 0 ->> 'referenceMasked' is distinct from U&'\2022\2022\2022\2022ABCD' then
    raise exception 'REFDISPLAY 30 FAILED: a backfilled display is not visible through provenance: %', prov;
  end if;
end;
$refd$;
rollback;
select 'ALL BANK REFERENCE DISPLAY CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Member attire (20261009100000_member_attire.sql)
--
-- A member chooses their own avatar attire (none | gabi | netela); group members
-- read each other's choice through list_group_members_v1. Checks that (a) the
-- default is none, (b) a member sets only their OWN value - the function has no
-- user argument and the identity is auth.uid() - and the other member's value
-- does not move, (c) every active member reads everyone's value through the
-- members list, which keeps exactly its documented keys plus attire, (d) setting
-- the same value again reports changed = false, (e) an unknown value or null is
-- refused as ledger_invalid_request, and the table CHECK refuses one written
-- directly, (f) an outsider, an anonymous caller and an inactive member can
-- neither set nor (outsider) read, with ledger_forbidden, and (g) anon cannot
-- execute the setter. Runs in a transaction that is rolled back.
-- ---------------------------------------------------------------------------
reset role;
begin;
select set_config('request.jwt.claim.sub', '', true);

do $attire$
declare
  owner_uid  constant text := '11111111-1111-4111-8111-111111111111';
  viewer_uid constant text := '33333333-3333-4333-8333-333333333333';
  outsider   constant text := '44444444-4444-4444-8444-444444444444';
  group_a    uuid;
  tenant_a   uuid;
  res        jsonb;
  members    jsonb;
begin
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  group_a := (public.sened_ledger_provision_group_v1('Attire equb') ->> 'groupId')::uuid;
  select tenant_id into tenant_a from public.ledger_groups where id = group_a;
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role)
  values (group_a, tenant_a, viewer_uid::uuid, 'member');

  -- (a) default none, and the function takes no user argument
  if exists (select 1 from public.ledger_group_memberships where group_id = group_a and attire <> 'none') then
    raise exception 'ATTIRE 1 FAILED: the default is not none';
  end if;
  if (select proargnames from pg_proc where proname = 'sened_ledger_set_member_attire_v1')
     is distinct from array['requested_group_id','requested_attire'] then
    raise exception 'ATTIRE 2 FAILED: the setter takes an unexpected argument';
  end if;

  -- (b) the owner sets their own; the member's stays none
  set local role authenticated;
  res := public.sened_ledger_set_member_attire_v1(group_a, 'gabi');
  if res ->> 'attire' <> 'gabi' or (res ->> 'changed')::boolean is not true or (res ->> 'groupId')::uuid <> group_a then
    raise exception 'ATTIRE 3 FAILED: unexpected result %', res;
  end if;
  res := public.sened_ledger_set_member_attire_v1(group_a, 'gabi');
  if (res ->> 'changed')::boolean is not false then
    raise exception 'ATTIRE 4 FAILED: setting the same value reported a change: %', res;
  end if;
  reset role;
  if (select attire from public.ledger_group_memberships where group_id = group_a and user_id = owner_uid::uuid) <> 'gabi'
     or (select attire from public.ledger_group_memberships where group_id = group_a and user_id = viewer_uid::uuid) <> 'none' then
    raise exception 'ATTIRE 5 FAILED: the owner''s choice moved the wrong row';
  end if;

  -- (c) the member reads the owner's value through the members list, and sets their own
  perform set_config('request.jwt.claim.sub', viewer_uid, true);
  set local role authenticated;
  members := public.list_group_members_v1(group_a);
  if (select r ->> 'attire' from jsonb_array_elements(members) r where r ->> 'userId' = owner_uid) <> 'gabi'
     or (select r ->> 'attire' from jsonb_array_elements(members) r where r ->> 'userId' = viewer_uid) <> 'none' then
    raise exception 'ATTIRE 6 FAILED: the members list does not carry each member''s attire: %', members;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(members -> 0) k)
     is distinct from array['attire','email','joinedAt','role','userId'] then
    raise exception 'ATTIRE 7 FAILED: unexpected member keys %', members -> 0;
  end if;
  res := public.sened_ledger_set_member_attire_v1(group_a, 'netela');
  if res ->> 'attire' <> 'netela' then
    raise exception 'ATTIRE 8 FAILED: the member could not set their own attire: %', res;
  end if;
  reset role;
  if (select attire from public.ledger_group_memberships where group_id = group_a and user_id = owner_uid::uuid) <> 'gabi' then
    raise exception 'ATTIRE 9 FAILED: a member changed the owner''s attire';
  end if;

  -- (e) invalid values
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_attire_v1(group_a, 'female');
    raise exception 'ATTIRE 10 FAILED: an unknown attire was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.sened_ledger_set_member_attire_v1(group_a, null);
    raise exception 'ATTIRE 11 FAILED: null was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.sened_ledger_set_member_attire_v1(null, 'gabi');
    raise exception 'ATTIRE 12 FAILED: a null group was accepted';
  exception when sqlstate '22023' then null;
  end;
  reset role;
  begin
    update public.ledger_group_memberships set attire = 'male' where group_id = group_a and user_id = viewer_uid::uuid;
    raise exception 'ATTIRE 13 FAILED: the table accepted an unknown attire';
  exception when check_violation then null;
  end;

  -- (f) an outsider can neither read nor write, whether or not the group exists
  perform set_config('request.jwt.claim.sub', outsider, true);
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_attire_v1(group_a, 'gabi');
    raise exception 'ATTIRE 14 FAILED: an outsider set attire in the group';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform public.sened_ledger_set_member_attire_v1('eeeeeeee-0000-4000-8000-00000000dead', 'gabi');
    raise exception 'ATTIRE 15 FAILED: an unknown group did not raise forbidden';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform public.list_group_members_v1(group_a);
    raise exception 'ATTIRE 16 FAILED: an outsider read the members list';
  exception when sqlstate '42501' then null;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_attire_v1(group_a, 'gabi');
    raise exception 'ATTIRE 17 FAILED: an anonymous caller set attire';
  exception when sqlstate '42501' then null;
  end;
  reset role;

  -- an inactive member is refused too, and keeps the value they had
  update public.ledger_group_memberships set status = 'inactive' where group_id = group_a and user_id = viewer_uid::uuid;
  perform set_config('request.jwt.claim.sub', viewer_uid, true);
  set local role authenticated;
  begin
    perform public.sened_ledger_set_member_attire_v1(group_a, 'none');
    raise exception 'ATTIRE 18 FAILED: an inactive member set attire';
  exception when sqlstate '42501' then null;
  end;
  reset role;
  if (select attire from public.ledger_group_memberships where group_id = group_a and user_id = viewer_uid::uuid) <> 'netela' then
    raise exception 'ATTIRE 19 FAILED: an inactive member''s value changed';
  end if;

  -- (g) grants
  if has_function_privilege('anon', 'public.sened_ledger_set_member_attire_v1(uuid, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.sened_ledger_set_member_attire_v1(uuid, text)', 'EXECUTE') then
    raise exception 'ATTIRE 20 FAILED: anon or PUBLIC can execute the setter';
  end if;
  if not has_function_privilege('authenticated', 'public.sened_ledger_set_member_attire_v1(uuid, text)', 'EXECUTE') then
    raise exception 'ATTIRE 21 FAILED: authenticated cannot execute the setter';
  end if;
end;
$attire$;
rollback;
select 'ALL MEMBER ATTIRE CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Contribution attribution and collateral (20261010100000_contribution_attribution_and_collateral.sql)
--
-- ATTRIBUTION. A manual (cash) contribution has no payer unless an owner or
-- treasurer records one beside the hash-chained entry. Checks that (a) only an
-- owner/treasurer of the group records it - a plain member, an outsider and an
-- anonymous caller are refused, (b) it is refused for a foreign group's entry (the
-- same answer as an absent one), a non-contribution entry, a corrected
-- contribution, a member who is not an ACTIVE member of the group (an outsider and
-- an inactive member), and an entry a verified bank receipt already names (bank
-- provenance wins, for record and for supersede, and the read reports the bank even
-- when a manual row came first), (c) there is ONE attribution per entry (replaying
-- the same one is a replay, a different one is attribution_exists) and a mistake
-- is fixed only by an explicit superseding row with a reason, the history staying
-- a single line, (d) the table is append-only (update, delete and truncate are
-- refused, a client role cannot write it, the unique indexes hold against a direct
-- insert) and a row's own invariants hold for ANY writer (trigger), (e) the
-- entry's hash and the chain head are untouched, (f) the read function returns the
-- effective attribution with its documented keys to any member and refuses an
-- outsider, and (g) grants.
--
-- COLLATERAL. Checks that (a) only an owner/treasurer proposes, for a member who
-- actually won a round of THAT cycle with rounds left, with an active guarantor
-- who is not the winner, (b) the guarantee needs the GUARANTOR'S OWN consent: an
-- owner, a treasurer, the winner and an outsider cannot accept or decline for them,
-- and the trigger refuses a directly inserted accepted event by anyone else,
-- (c) the state is derived from append-only events (accepted once, ending once,
-- release and supersede carry a reason, replays are replays, terminal states do
-- not reopen), (d) nothing moves money (entries and the chain head are
-- unchanged), and (e) the DEFAULT DERIVATION: for each winner and each later round,
-- met / flagged / not_due follow the documented rule - a draw opened with no
-- qualifying attributed contribution is flagged, a contribution recorded before the
-- previous reveal does not pay a later round, an amount under the cycle's share does
-- not count, an explicit cycle+round attribution assigns that round, one entry pays
-- one round, bank provenance counts, another cycle's attribution does not, and a
-- corrected contribution stops counting - and nothing about it is stored. Runs in a
-- transaction that is rolled back.
-- ---------------------------------------------------------------------------
reset role;
begin;
select set_config('request.jwt.claim.sub', '', true);

insert into auth.users (id, email) values
  ('55555555-5555-4555-8555-555555555555', 'treasurer-role@example.test'),
  ('66666666-6666-4666-8666-666666666666', 'member-d@example.test'),
  ('77777777-7777-4777-8777-777777777777', 'other-owner@example.test'),
  ('88888888-8888-4888-8888-888888888888', 'inactive@example.test')
on conflict (id) do nothing;

-- Run `p_sql` as `p_uid` (empty = anonymous) under the authenticated role and
-- demand that it fails with exactly this message and SQLSTATE.
create or replace function pg_temp.expect_error(p_uid text, p_sql text, p_msg text, p_state text)
returns void
language plpgsql
as $$
declare
  got_msg text;
  got_state text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  begin
    set local role authenticated;
    execute p_sql;
    reset role;
    raise exception 'no error' using errcode = 'XX999';
  exception when others then
    got_msg := sqlerrm;
    got_state := sqlstate;
  end;
  reset role;
  if got_state = 'XX999' then
    raise exception 'EXPECT FAILED: no error from [%], wanted % %', p_sql, p_state, p_msg;
  end if;
  if got_msg <> p_msg or got_state <> p_state then
    raise exception 'EXPECT FAILED: [%] wanted % %, got % %', p_sql, p_state, p_msg, got_state, got_msg;
  end if;
end;
$$;

-- Run `p_sql` (a select returning jsonb) as `p_uid` and return the result.
create or replace function pg_temp.call_as(p_uid text, p_sql text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  set local role authenticated;
  execute p_sql into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end;
$$;

-- Fixture: a committed and revealed draw won by `p_winner`, as the superuser.
create or replace function pg_temp.fx_reveal(p_group uuid, p_tenant uuid, p_cycle uuid, p_round integer, p_winner uuid, p_actor uuid)
returns timestamptz
language plpgsql
as $$
declare
  draw_uuid uuid := gen_random_uuid();
  revealed timestamptz;
begin
  insert into public.draw_commitments (
    draw_id, group_id, tenant_id, cycle_id, round, commitment, commitment_nonce,
    roster_digest, participants, pot_amount, total_rounds, reserve_ratio_bps, actor_id, idempotency_key
  ) values (
    draw_uuid, p_group, p_tenant, p_cycle, p_round, repeat('a', 64), 'nonce-0123456789abcdef-XYZ',
    repeat('b', 64),
    jsonb_build_array(jsonb_build_object('memberId', p_winner, 'ticket', repeat('c', 64), 'contributionAmount', '100.00')),
    500.00, 4, 1000, p_actor, 'fx-commit-' || draw_uuid::text
  );
  insert into public.draw_reveals (
    draw_id, commitment, seed, transcript_digest, selection_digest, selected_index,
    winner_member_id, winning_ticket, payout_amount, reserve_amount, actor_id
  ) values (
    draw_uuid, repeat('a', 64), 'reveal-seed-0123456789', repeat('f', 64), repeat('a', 64), 0,
    p_winner, repeat('c', 64), 450.00, 50.00, p_actor
  ) returning revealed_at into revealed;
  return revealed;
end;
$$;

-- Fixture: post a contribution of `p_amount` as the group owner (the session user is switched).
create or replace function pg_temp.fx_post(p_group uuid, p_key text, p_amount text, p_cash uuid, p_income uuid)
returns uuid
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  return (public.post_ledger_entry_v1(p_group, p_key, now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', p_cash, 'direction', 'debit', 'amount', p_amount),
                      jsonb_build_object('accountId', p_income, 'direction', 'credit', 'amount', p_amount))) -> 'entry' ->> 'id')::uuid;
end;
$$;

-- Fixture: reverse an entry with a correction, as the group owner.
create or replace function pg_temp.fx_correct(p_group uuid, p_key text, p_entry uuid, p_amount text, p_cash uuid, p_income uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform public.post_ledger_entry_v1(p_group, p_key, now(), 'correction', p_entry,
    'Reversing this payment, recorded in error.',
    jsonb_build_array(jsonb_build_object('accountId', p_cash, 'direction', 'credit', 'amount', p_amount),
                      jsonb_build_object('accountId', p_income, 'direction', 'debit', 'amount', p_amount)));
end;
$$;

do $attr$
declare
  owner_uid  constant text := '11111111-1111-4111-8111-111111111111';
  t_uid      constant text := '55555555-5555-4555-8555-555555555555'; -- treasurer role
  a_uid      constant text := '22222222-2222-4222-8222-222222222222'; -- winner of round 1
  b_uid      constant text := '33333333-3333-4333-8333-333333333333'; -- winner of round 2, guarantor
  c_uid      constant text := '66666666-6666-4666-8666-666666666666'; -- plain member
  h_uid      constant text := '77777777-7777-4777-8777-777777777777'; -- owner of the OTHER group
  i_uid      constant text := '88888888-8888-4888-8888-888888888888'; -- inactive member
  outsider   constant text := '44444444-4444-4444-8444-444444444444';
  group_g    uuid;
  group_h    uuid;
  tenant_g   uuid;
  tenant_h   uuid;
  cash_g     uuid;
  income_g   uuid;
  expense_g  uuid;
  cash_h     uuid;
  income_h   uuid;
  cycle_1    uuid;
  cycle_2    uuid;
  binding_c  uuid := 'cccccccc-0000-4000-8000-0000000000f1';
  binding_b  uuid := 'cccccccc-0000-4000-8000-0000000000f2';
  e1 uuid; e2 uuid; e_dis uuid; e_bank uuid; e_late uuid; e_corr uuid; e_foreign uuid;
  head_before record;
  head_after record;
  hash_before text;
  res jsonb;
  res2 jsonb;
  n bigint;
  msg text;
  guarantee_ab uuid;
  guarantee_ac uuid;
  guarantee_ab2 uuid;
  guarantee_succ uuid;
  entries_before bigint;
  r1 timestamptz;
  r2 timestamptz;
  ea0 uuid; ea1 uuid; ea5 uuid; ea2 uuid; ea3 uuid; ea4 uuid; ea6 uuid; ea7 uuid; eb1 uuid;
  owed jsonb;
  winner_a jsonb;
  winner_b jsonb;
begin
  -- -------------------------------------------------------------------------
  -- Fixtures: group G (owner, treasurer role, A, B, C, an inactive member) and an
  -- unrelated group H.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  group_g := (public.sened_ledger_provision_group_v1('Attribution equb') ->> 'groupId')::uuid;
  perform set_config('request.jwt.claim.sub', h_uid, true);
  group_h := (public.sened_ledger_provision_group_v1('Other attribution equb') ->> 'groupId')::uuid;
  select tenant_id into tenant_g from public.ledger_groups where id = group_g;
  select tenant_id into tenant_h from public.ledger_groups where id = group_h;
  select id into cash_g from public.ledger_accounts where group_id = group_g and code = 'POT_CASH';
  select id into income_g from public.ledger_accounts where group_id = group_g and code = 'CONTRIBUTION_INCOME';
  select id into expense_g from public.ledger_accounts where group_id = group_g and code = 'PAYOUT_EXPENSE';
  select id into cash_h from public.ledger_accounts where group_id = group_h and code = 'POT_CASH';
  select id into income_h from public.ledger_accounts where group_id = group_h and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (group_g, tenant_g, t_uid::uuid, 'treasurer', 'active'),
    (group_g, tenant_g, a_uid::uuid, 'member', 'active'),
    (group_g, tenant_g, b_uid::uuid, 'member', 'active'),
    (group_g, tenant_g, c_uid::uuid, 'member', 'active'),
    (group_g, tenant_g, i_uid::uuid, 'member', 'inactive');

  -- A cycle of 4 rounds at 100.00 per round, started a day ago.
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  cycle_1 := (public.create_draw_cycle_v1(group_g, 'Cycle one', 100.00, 4, 1000, now() - interval '1 day', 'attr-cycle-1') -> 'cycle' ->> 'cycleId')::uuid;
  cycle_2 := (public.create_draw_cycle_v1(group_g, 'Cycle two', 100.00, 4, 1000, now() - interval '1 day', 'attr-cycle-2') -> 'cycle' ->> 'cycleId')::uuid;

  -- Entries. e1/e2 cash contributions; e_dis a disbursement; e_bank and e_late get
  -- bank provenance; e_corr is later reversed; e_foreign lives in group H.
  e1 := (public.post_ledger_entry_v1(group_g, 'attr-e1', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e2 := (public.post_ledger_entry_v1(group_g, 'attr-e2', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e_dis := (public.post_ledger_entry_v1(group_g, 'attr-dis', now(), 'disbursement', null, null,
    jsonb_build_array(jsonb_build_object('accountId', expense_g, 'direction', 'debit', 'amount', '10.00'),
                      jsonb_build_object('accountId', cash_g, 'direction', 'credit', 'amount', '10.00'))) -> 'entry' ->> 'id')::uuid;
  e_bank := (public.post_ledger_entry_v1(group_g, 'bank-verified-attr-1', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e_late := (public.post_ledger_entry_v1(group_g, 'attr-late', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e_corr := (public.post_ledger_entry_v1(group_g, 'attr-corr', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  perform public.post_ledger_entry_v1(group_g, 'attr-corr-fix', now(), 'correction', e_corr,
    'Entered twice by mistake, reversing it.',
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'credit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'debit', 'amount', '100.00')));
  perform set_config('request.jwt.claim.sub', h_uid, true);
  e_foreign := (public.post_ledger_entry_v1(group_h, 'attr-foreign', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_h, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_h, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;

  -- Bank provenance: a binding, one verified intent linked to e_bank, one verified
  -- but not yet linked to e_late (linked LATER, after a manual attribution exists).
  insert into public.bank_account_bindings (id,user_id,tenant_id,group_id,ledger_account_id,provider,account_label,account_fingerprint_hmac,sender_fingerprint_hmac,receiver_fingerprint_hmac)
  values
    (binding_c, c_uid::uuid, tenant_g, group_g, cash_g, 'cbe', 'C', repeat('a',64), repeat('b',64), repeat('c',64)),
    (binding_b, b_uid::uuid, tenant_g, group_g, cash_g, 'cbe', 'B', repeat('d',64), repeat('e',64), repeat('f',64));
  insert into public.bank_verification_intents (id,user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at)
  values
    ('dddddddd-0000-4000-8000-0000000000f1', c_uid::uuid, tenant_g, group_g, binding_c, cash_g, 'cbe', repeat('9',64), 'attr-bank-1', repeat('e',64), 100.00, 'inbound', now()),
    ('dddddddd-0000-4000-8000-0000000000f2', b_uid::uuid, tenant_g, group_g, binding_b, cash_g, 'cbe', repeat('8',64), 'attr-bank-2', repeat('e',64), 100.00, 'inbound', now());
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('1',64), verified_at = '2026-10-10 09:00:05.123+00',
      ledger_entry_id = e_bank
  where id = 'dddddddd-0000-4000-8000-0000000000f1';
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('2',64), verified_at = '2026-10-10 09:05:00+00'
  where id = 'dddddddd-0000-4000-8000-0000000000f2';

  select last_sequence, last_hash into head_before from public.ledger_group_heads where group_id = group_g;
  select entry_hash into hash_before from public.ledger_entries where id = e1;
  select count(*) into entries_before from public.ledger_entries where group_id = group_g;

  -- =========================================================================
  -- ATTRIBUTION: who may record
  -- =========================================================================
  perform pg_temp.expect_error(c_uid,    format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error('',       format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(a_uid,    format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', gen_random_uuid(), e1, a_uid), 'ledger_forbidden', '42501');
  if (select count(*) from public.ledger_entry_attributions) <> 0 then
    raise exception 'ATTRIBUTION 1 FAILED: a refused caller left a row behind';
  end if;

  -- The treasurer-role member records e1 -> A (a cash payment): source treasurer.
  res := pg_temp.call_as(t_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid));
  if (res ->> 'replayed')::boolean is not false
     or res -> 'attribution' ->> 'source' <> 'treasurer'
     or res -> 'attribution' ->> 'memberUserId' <> a_uid
     or res -> 'attribution' ->> 'recordedBy' <> t_uid
     or (res -> 'attribution' ->> 'revision')::int <> 1
     or res -> 'attribution' ->> 'entryId' <> e1::text
     or res -> 'attribution' -> 'cycleId' <> 'null'::jsonb
     or res -> 'attribution' -> 'round' <> 'null'::jsonb then
    raise exception 'ATTRIBUTION 2 FAILED: unexpected result %', res;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(res -> 'attribution') k)
     is distinct from array['channel','cycleId','entryId','memberUserId','note','reason','recordedAt','recordedBy','revision','round','source'] then
    raise exception 'ATTRIBUTION 3 FAILED: unexpected keys %', res -> 'attribution';
  end if;

  -- =========================================================================
  -- ATTRIBUTION: what may be attributed, and to whom
  -- =========================================================================
  -- another group's entry reads as absent (from either side)
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e_foreign, a_uid), 'ledger_entry_not_found', 'P0002');
  perform pg_temp.expect_error(h_uid,     format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_h, e1, a_uid), 'ledger_entry_not_found', 'P0002');
  perform pg_temp.expect_error(h_uid,     format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid), 'ledger_forbidden', '42501');
  -- not a contribution
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e_dis, a_uid), 'attribution_not_contribution', '22023');
  -- a member who is not in this group, and one who is inactive
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e2, outsider), 'ledger_member_not_found', 'P0002');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e2, i_uid), 'ledger_member_not_found', 'P0002');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e2, h_uid), 'ledger_member_not_found', 'P0002');
  -- a reversed contribution
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e_corr, a_uid), 'attribution_entry_corrected', 'P0001');
  -- argument shape: a round needs a cycle; the cycle must be this group's; round within the cycle
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,2)', group_g, e2, a_uid), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,%L,5)', group_g, e2, a_uid, cycle_1), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,%L,1)', group_g, e2, a_uid, gen_random_uuid()), 'ledger_cycle_not_found', 'P0002');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,null)', group_g, e2), 'ledger_invalid_request', '22023');
  -- bank provenance wins: record and supersede are both refused on e_bank
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e_bank, a_uid), 'attribution_bank_verified', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e_bank, a_uid, 'Trying to override a bank verification'), 'attribution_bank_verified', 'P0001');

  -- =========================================================================
  -- ATTRIBUTION: one per entry, supersede with a reason
  -- =========================================================================
  res2 := pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid));
  if (res2 ->> 'replayed')::boolean is not true then
    raise exception 'ATTRIBUTION 4 FAILED: the same attribution again was not a replay: %', res2;
  end if;
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, b_uid), 'attribution_exists', 'P0001');
  if (select count(*) from public.ledger_entry_attributions where entry_id = e1) <> 1 then
    raise exception 'ATTRIBUTION 5 FAILED: more than one row for an entry after refusals and a replay';
  end if;
  -- supersede: needs a reason of 10..1000 characters, and something to supersede
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, b_uid, 'too short'), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,null)', group_g, e1, b_uid), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e2, b_uid, 'Nothing to supersede here'), 'attribution_not_found', 'P0002');
  perform pg_temp.expect_error(c_uid,     format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, b_uid, 'A plain member cannot supersede'), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, a_uid, 'Same payer again changes nothing'), 'attribution_unchanged', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, outsider, 'Outsider is not a member here'), 'ledger_member_not_found', 'P0002');
  res := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, b_uid, 'Receipt book shows B paid, not A'));
  if (res ->> 'replayed')::boolean is not false
     or res -> 'attribution' ->> 'memberUserId' <> b_uid
     or (res -> 'attribution' ->> 'revision')::int <> 2
     or res -> 'attribution' ->> 'reason' <> 'Receipt book shows B paid, not A'
     or res -> 'attribution' ->> 'recordedBy' <> owner_uid then
    raise exception 'ATTRIBUTION 6 FAILED: unexpected superseding result %', res;
  end if;
  res2 := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, b_uid, 'Receipt book shows B paid, not A'));
  if (res2 ->> 'replayed')::boolean is not true then
    raise exception 'ATTRIBUTION 7 FAILED: the same supersede again was not a replay: %', res2;
  end if;
  -- the original row is still there, untouched, and the history is one line of two
  if (select count(*) from public.ledger_entry_attributions where entry_id = e1) <> 2
     or (select member_user_id from public.ledger_entry_attributions where entry_id = e1 and supersedes_id is null) <> a_uid::uuid
     or (select recorded_by from public.ledger_entry_attributions where entry_id = e1 and supersedes_id is null) <> t_uid::uuid then
    raise exception 'ATTRIBUTION 8 FAILED: the original attribution was not preserved';
  end if;
  -- a second supersede must target the new tip, so history stays linear
  res := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,%L,2)', group_g, e1, b_uid, 'Payment was for round two of cycle one', cycle_1));
  if (res -> 'attribution' ->> 'revision')::int <> 3 or (res -> 'attribution' ->> 'round')::int <> 2
     or res -> 'attribution' ->> 'cycleId' <> cycle_1::text then
    raise exception 'ATTRIBUTION 9 FAILED: unexpected third revision %', res;
  end if;
  if (select count(*) from public.ledger_entry_attributions where supersedes_id is null and entry_id = e1) <> 1 then
    raise exception 'ATTRIBUTION 10 FAILED: more than one root for an entry';
  end if;

  -- =========================================================================
  -- ATTRIBUTION: bank provenance wins on the read, even when a manual row came first
  -- =========================================================================
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e_late, a_uid));
  -- later the bank link appears: intent f2 (member B) is linked to e_late
  update public.bank_verification_intents set ledger_entry_id = e_late where id = 'dddddddd-0000-4000-8000-0000000000f2';
  res := pg_temp.call_as(a_uid, format('select public.get_ledger_entry_attributions_v1(%L, array[%L,%L,%L,%L,%L,%L]::uuid[])', group_g, e1, e2, e_dis, e_bank, e_late, e_corr));
  if jsonb_array_length(res) <> 3 then
    raise exception 'ATTRIBUTION 11 FAILED: expected e1, e_bank and e_late only, got %', res;
  end if;
  if (select r ->> 'source' from jsonb_array_elements(res) r where r ->> 'entryId' = e_bank::text) <> 'bank_verification'
     or (select r ->> 'memberUserId' from jsonb_array_elements(res) r where r ->> 'entryId' = e_bank::text) <> c_uid
     or (select r ->> 'recordedAt' from jsonb_array_elements(res) r where r ->> 'entryId' = e_bank::text) <> '2026-10-10T09:00:05.123Z' then
    raise exception 'ATTRIBUTION 12 FAILED: the bank-verified entry is not reported as bank verified: %', res;
  end if;
  if (select r ->> 'source' from jsonb_array_elements(res) r where r ->> 'entryId' = e_late::text) <> 'bank_verification'
     or (select r ->> 'memberUserId' from jsonb_array_elements(res) r where r ->> 'entryId' = e_late::text) <> b_uid then
    raise exception 'ATTRIBUTION 13 FAILED: a manual row outranked a later bank link: %', res;
  end if;
  if (select r ->> 'source' from jsonb_array_elements(res) r where r ->> 'entryId' = e1::text) <> 'treasurer'
     or (select r ->> 'memberUserId' from jsonb_array_elements(res) r where r ->> 'entryId' = e1::text) <> b_uid then
    raise exception 'ATTRIBUTION 14 FAILED: the current manual attribution is not the tip: %', res;
  end if;
  -- and a supersede on e_late is now refused too
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e_late, c_uid, 'Bank link appeared afterwards'), 'attribution_bank_verified', 'P0001');
  -- the read is for members only, and group-scoped
  perform pg_temp.expect_error(outsider, format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_g, e1), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(h_uid,    format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_g, e1), 'ledger_forbidden', '42501');
  if pg_temp.call_as(h_uid, format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_h, e1)) <> '[]'::jsonb then
    raise exception 'ATTRIBUTION 15 FAILED: another group''s call returned this group''s attribution';
  end if;
  if pg_temp.call_as(c_uid, format('select public.get_ledger_entry_attributions_v1(%L, array[]::uuid[])', group_g)) <> '[]'::jsonb
     or pg_temp.call_as(c_uid, format('select public.get_ledger_entry_attributions_v1(%L, null)', group_g)) <> '[]'::jsonb then
    raise exception 'ATTRIBUTION 16 FAILED: empty input was not an empty result';
  end if;
  perform pg_temp.expect_error(c_uid, format('select public.get_ledger_entry_attributions_v1(%L, (select array_agg(gen_random_uuid()) from generate_series(1, 501)))', group_g), 'ledger_invalid_request', '22023');

  -- =========================================================================
  -- ATTRIBUTION: append-only, and invariants for ANY writer
  -- =========================================================================
  begin
    update public.ledger_entry_attributions set member_user_id = c_uid::uuid where entry_id = e1;
    raise exception 'ATTRIBUTION 17 FAILED: an attribution was updated';
  exception when others then
    if sqlerrm <> 'attribution_history_immutable' then raise exception 'ATTRIBUTION 17 FAILED: %', sqlerrm; end if;
  end;
  begin
    delete from public.ledger_entry_attributions where entry_id = e1;
    raise exception 'ATTRIBUTION 18 FAILED: an attribution was deleted';
  exception when others then
    if sqlerrm <> 'attribution_history_immutable' then raise exception 'ATTRIBUTION 18 FAILED: %', sqlerrm; end if;
  end;
  begin
    truncate public.ledger_entry_attributions;
    raise exception 'ATTRIBUTION 19 FAILED: the table was truncated';
  exception when others then
    if sqlerrm <> 'attribution_history_immutable' then raise exception 'ATTRIBUTION 19 FAILED: %', sqlerrm; end if;
  end;
  -- a second root, or a second successor, is refused by the unique indexes
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by)
    values (e1, group_g, tenant_g, a_uid::uuid, owner_uid::uuid);
    raise exception 'ATTRIBUTION 20 FAILED: a second root was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, supersedes_id, reason)
    select e1, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, root.id, 'A second successor of the root row'
    from public.ledger_entry_attributions root where root.entry_id = e1 and root.supersedes_id is null;
    raise exception 'ATTRIBUTION 21 FAILED: a second successor was accepted';
  exception when unique_violation then null;
  end;
  -- a superseding row needs a reason of the right length
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, supersedes_id, reason)
    select e1, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, tip.id, 'short'
    from public.ledger_entry_attributions tip where tip.entry_id = e1 and tip.round = 2;
    raise exception 'ATTRIBUTION 22 FAILED: a superseding row without a proper reason was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, round)
    values (e2, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, 2);
    raise exception 'ATTRIBUTION 23 FAILED: a round without a cycle was accepted';
  exception when check_violation then null;
  end;
  -- the trigger holds the rules for a writer that skips the RPC
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by)
    values (e_dis, group_g, tenant_g, a_uid::uuid, owner_uid::uuid);
    raise exception 'ATTRIBUTION 24 FAILED: a disbursement was attributed directly';
  exception when others then
    if sqlerrm <> 'attribution_not_contribution' then raise exception 'ATTRIBUTION 24 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by)
    values (e2, group_g, tenant_g, a_uid::uuid, c_uid::uuid);
    raise exception 'ATTRIBUTION 25 FAILED: a plain member recorded an attribution directly';
  exception when others then
    if sqlerrm <> 'ledger_forbidden' then raise exception 'ATTRIBUTION 25 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by)
    values (e2, group_g, tenant_g, outsider::uuid, owner_uid::uuid);
    raise exception 'ATTRIBUTION 26 FAILED: a non-member was attributed directly';
  exception when others then
    if sqlerrm <> 'ledger_member_not_found' then raise exception 'ATTRIBUTION 26 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by)
    values (e_bank, group_g, tenant_g, a_uid::uuid, owner_uid::uuid);
    raise exception 'ATTRIBUTION 27 FAILED: a bank-verified entry was attributed directly';
  exception when others then
    if sqlerrm <> 'attribution_bank_verified' then raise exception 'ATTRIBUTION 27 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by)
    values (e_foreign, group_g, tenant_g, a_uid::uuid, owner_uid::uuid);
    raise exception 'ATTRIBUTION 28 FAILED: another group''s entry was attributed under this group';
  exception when others then
    -- the trigger finds no such contribution in THIS group (the composite foreign key says the same later)
    if sqlerrm <> 'attribution_not_contribution' then raise exception 'ATTRIBUTION 28 FAILED: %', sqlerrm; end if;
  end;
  -- a client role cannot write the table; a member can read it, an outsider sees nothing
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  set local role authenticated;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by)
    values (e2, group_g, tenant_g, a_uid::uuid, owner_uid::uuid);
    raise exception 'ATTRIBUTION 29 FAILED: authenticated inserted directly';
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', c_uid, true);
  set local role authenticated;
  select count(*) into n from public.ledger_entry_attributions;
  reset role;
  if n <> 4 then
    raise exception 'ATTRIBUTION 30 FAILED: a member sees % attribution rows, expected 4', n;
  end if;
  perform set_config('request.jwt.claim.sub', outsider, true);
  set local role authenticated;
  select count(*) into n from public.ledger_entry_attributions;
  reset role;
  if n <> 0 then
    raise exception 'ATTRIBUTION 31 FAILED: an outsider sees % attribution rows', n;
  end if;

  -- =========================================================================
  -- ATTRIBUTION: the hash-chained entry is untouched
  -- =========================================================================
  select last_sequence, last_hash into head_after from public.ledger_group_heads where group_id = group_g;
  if head_after.last_sequence <> head_before.last_sequence or head_after.last_hash <> head_before.last_hash
     or (select entry_hash from public.ledger_entries where id = e1) <> hash_before
     or (select count(*) from public.ledger_entries where group_id = group_g) <> entries_before then
    raise exception 'ATTRIBUTION 32 FAILED: attributing moved the ledger chain';
  end if;

  -- =========================================================================
  -- ATTRIBUTION: grants
  -- =========================================================================
  if has_function_privilege('anon', 'public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_ledger_entry_attributions_v1(uuid, uuid[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_effective_attribution(uuid, uuid)', 'EXECUTE') then
    raise exception 'ATTRIBUTION 33 FAILED: a function is executable by a role that must not have it';
  end if;
  if not has_function_privilege('authenticated', 'public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_ledger_entry_attributions_v1(uuid, uuid[])', 'EXECUTE') then
    raise exception 'ATTRIBUTION 34 FAILED: authenticated cannot execute an attribution RPC';
  end if;

  -- =========================================================================
  -- COLLATERAL: the derivation timeline
  --
  --   eA0  A pays and the treasurer attributes it                    (before round 1's reveal)
  --   R1   round 1 revealed: A wins
  --   draw for round 2 opened  -> A owes round 2 (flagged: nothing since R1), 3 and 4 not due
  --   eA1  A pays 100.00, attributed                                  -> round 2 met
  --   eA5  A pays 100.00 again, attributed                            (unused: round 3 is not due yet)
  --   R2   round 2 revealed: B wins
  --   draw for round 3 opened -> A: round 3 flagged (eA2 is under the share, eA5 was recorded
  --        before R2). B: nothing yet, flagged
  --   eB1  B pays by bank (verified)                                   -> B round 3 met by bank provenance
  --   eA2  A pays 50.00 attributed                                     -> still under the share
  --   eA3  explicit cycle 1 round 4                                    -> A round 4 met although not due
  --   eA6  attributed to ANOTHER cycle                                 -> does not count
  --   eA4  A pays 100.00 attributed                                    -> A round 3 met (oldest eligible)
  --   correct eA4                                                      -> A round 3 flagged again
  --   eA7  A pays 100.00                                               -> A round 3 met again
  -- =========================================================================
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  ea0 := pg_temp.fx_post(group_g, 'col-ea0', '100.00', cash_g, income_g);
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, ea0, a_uid));
  perform pg_sleep(0.02);
  reset role;
  r1 := pg_temp.fx_reveal(group_g, tenant_g, cycle_1, 1, a_uid::uuid, owner_uid::uuid);
  perform pg_sleep(0.02);

  -- before any draw for round 2 is opened nothing is due, so nothing is flagged
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  if (res ->> 'flaggedCount')::int <> 0 or jsonb_array_length(res -> 'winners') <> 1
     or (res -> 'winners' -> 0 ->> 'memberId') <> a_uid or (res -> 'winners' -> 0 ->> 'round')::int <> 1
     or (res ->> 'nextRound')::int <> 2 or (res ->> 'reserveRetained') <> '50.00'
     or (res ->> 'contributionAmount') <> '100.00' or (res ->> 'totalRounds')::int <> 4 then
    raise exception 'COLLATERAL 1 FAILED: unexpected view before round 2 opens: %', res;
  end if;
  if (select array_agg(s ->> 'status' order by (s ->> 'round')::int) from jsonb_array_elements(res -> 'winners' -> 0 -> 'owed') s)
     is distinct from array['not_due','not_due','not_due'] then
    raise exception 'COLLATERAL 2 FAILED: rounds with no opened draw are not "not_due": %', res -> 'winners' -> 0 -> 'owed';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(res) k)
     is distinct from array['contributionAmount','cycleId','eligibleCount','flaggedCount','groupId','nextRound','potAmount','reserveRatioBps','reserveRetained','startedAt','totalRounds','winners'] then
    raise exception 'COLLATERAL 3 FAILED: unexpected top-level keys %', res;
  end if;

  -- open round 2
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  perform public.open_draw_v1(cycle_1, 2, 'col-open-2');
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  owed := res -> 'winners' -> 0 -> 'owed';
  if (res ->> 'flaggedCount')::int <> 1
     or owed -> 0 ->> 'status' <> 'flagged' or (owed -> 0 ->> 'round')::int <> 2
     or owed -> 0 -> 'dueAt' = 'null'::jsonb or owed -> 0 -> 'entryId' <> 'null'::jsonb
     or owed -> 1 ->> 'status' <> 'not_due' or owed -> 2 ->> 'status' <> 'not_due' then
    raise exception 'COLLATERAL 4 FAILED: a due round with no contribution after the win is not flagged (eA0 was before R1): %', res;
  end if;

  ea1 := pg_temp.fx_post(group_g, 'col-ea1', '100.00', cash_g, income_g);
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  if (res ->> 'flaggedCount')::int <> 1 then
    raise exception 'COLLATERAL 5 FAILED: an entry nobody attributed met an obligation: %', res;
  end if;
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, ea1, a_uid));
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  owed := res -> 'winners' -> 0 -> 'owed';
  if (res ->> 'flaggedCount')::int <> 0 or owed -> 0 ->> 'status' <> 'met'
     or owed -> 0 ->> 'source' <> 'treasurer' or (owed -> 0 ->> 'entryId')::uuid <> ea1 then
    raise exception 'COLLATERAL 6 FAILED: attributing the payment did not clear the flag (derived, not stored): %', res;
  end if;
  -- an extra payment recorded before the next reveal cannot pay a later round
  ea5 := pg_temp.fx_post(group_g, 'col-ea5', '100.00', cash_g, income_g);
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, ea5, a_uid));
  perform pg_sleep(0.02);
  reset role;
  r2 := pg_temp.fx_reveal(group_g, tenant_g, cycle_1, 2, b_uid::uuid, owner_uid::uuid);
  perform pg_sleep(0.02);
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  perform public.open_draw_v1(cycle_1, 3, 'col-open-3');
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  select w into winner_b from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = b_uid;
  if (select array_agg(s ->> 'status' order by (s ->> 'round')::int) from jsonb_array_elements(winner_a -> 'owed') s)
       is distinct from array['met','flagged','not_due']
     or (select array_agg(s ->> 'status' order by (s ->> 'round')::int) from jsonb_array_elements(winner_b -> 'owed') s)
       is distinct from array['flagged','not_due']
     or (res ->> 'flaggedCount')::int <> 2 or (res ->> 'reserveRetained') <> '100.00' or (res ->> 'nextRound')::int <> 3 then
    raise exception 'COLLATERAL 7 FAILED: a payment recorded before the previous reveal paid a later round, or the flags are wrong: %', res;
  end if;
  if (winner_a -> 'owed' -> 0 ->> 'entryId')::uuid <> ea1 then
    raise exception 'COLLATERAL 8 FAILED: round 2 was not paid by the oldest eligible entry: %', winner_a;
  end if;

  -- B pays by bank (verified, linked): counts by provenance, not by treasurer attribution
  eb1 := pg_temp.fx_post(group_g, 'bank-verified-col-eb1', '100.00', cash_g, income_g);
  insert into public.bank_verification_intents (id,user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at)
  values ('dddddddd-0000-4000-8000-0000000000f3', b_uid::uuid, tenant_g, group_g, binding_b, cash_g, 'cbe', repeat('7',64), 'attr-bank-3', repeat('e',64), 100.00, 'inbound', now());
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('3',64), verified_at = now(), ledger_entry_id = eb1
  where id = 'dddddddd-0000-4000-8000-0000000000f3';
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_b from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = b_uid;
  if winner_b -> 'owed' -> 0 ->> 'status' <> 'met' or winner_b -> 'owed' -> 0 ->> 'source' <> 'bank_verification'
     or (winner_b -> 'owed' -> 0 ->> 'entryId')::uuid <> eb1 then
    raise exception 'COLLATERAL 9 FAILED: a bank-verified contribution did not meet the round: %', winner_b;
  end if;

  -- 50.00 is under the cycle's 100.00 share: it does not count
  ea2 := pg_temp.fx_post(group_g, 'col-ea2', '50.00', cash_g, income_g);
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, ea2, a_uid));
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  if winner_a -> 'owed' -> 1 ->> 'status' <> 'flagged' then
    raise exception 'COLLATERAL 10 FAILED: an under-share contribution met the round: %', winner_a;
  end if;
  -- attributed to ANOTHER cycle: does not count here
  ea6 := pg_temp.fx_post(group_g, 'col-ea6', '100.00', cash_g, income_g);
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,%L,1)', group_g, ea6, a_uid, cycle_2));
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  if winner_a -> 'owed' -> 1 ->> 'status' <> 'flagged' then
    raise exception 'COLLATERAL 11 FAILED: an entry attributed to another cycle met this cycle''s round: %', winner_a;
  end if;
  -- an explicit cycle+round attribution assigns that round (here a round not yet due)
  ea3 := pg_temp.fx_post(group_g, 'col-ea3', '100.00', cash_g, income_g);
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,%L,4)', group_g, ea3, a_uid, cycle_1));
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  if (select array_agg(s ->> 'status' order by (s ->> 'round')::int) from jsonb_array_elements(winner_a -> 'owed') s)
       is distinct from array['met','flagged','met']
     or (winner_a -> 'owed' -> 2 ->> 'entryId')::uuid <> ea3 then
    raise exception 'COLLATERAL 12 FAILED: the explicit round assignment is wrong: %', winner_a;
  end if;
  -- the first unrounded entry recorded after R2 pays round 3 (one entry, one round)
  ea4 := pg_temp.fx_post(group_g, 'col-ea4', '100.00', cash_g, income_g);
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, ea4, a_uid));
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  if (select array_agg(s ->> 'status' order by (s ->> 'round')::int) from jsonb_array_elements(winner_a -> 'owed') s)
       is distinct from array['met','met','met']
     or (winner_a -> 'owed' -> 1 ->> 'entryId')::uuid <> ea4
     or (res ->> 'flaggedCount')::int <> 0 then
    raise exception 'COLLATERAL 13 FAILED: the post-R2 contribution did not meet round 3 (or paid twice): %', res;
  end if;
  -- a correction stops a contribution counting: derived again, flagged again
  perform pg_temp.fx_correct(group_g, 'col-ea4-fix', ea4, '100.00', cash_g, income_g);
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  if winner_a -> 'owed' -> 1 ->> 'status' <> 'flagged' then
    raise exception 'COLLATERAL 14 FAILED: a reversed contribution still counted: %', winner_a;
  end if;
  ea7 := pg_temp.fx_post(group_g, 'col-ea7', '100.00', cash_g, income_g);
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, ea7, a_uid));
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  if winner_a -> 'owed' -> 1 ->> 'status' <> 'met' or (winner_a -> 'owed' -> 1 ->> 'entryId')::uuid <> ea7 then
    raise exception 'COLLATERAL 15 FAILED: a replacement payment did not meet round 3: %', winner_a;
  end if;
  -- nothing about any of this was stored
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name in ('draw_collateral_guarantees', 'draw_collateral_guarantee_events')
        and column_name in ('status', 'state', 'flagged', 'paid')) <> 0 then
    raise exception 'COLLATERAL 16 FAILED: a stored status column exists';
  end if;
  -- the view is for members of the group only
  perform pg_temp.expect_error(outsider, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(h_uid,    format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(owner_uid, format('select public.get_draw_cycle_collateral_v1(%L)', gen_random_uuid()), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error('', format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1), 'collateral_forbidden', '42501');
  -- cycle 2 has no reveals: no winners, nothing flagged
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_2));
  if jsonb_array_length(res -> 'winners') <> 0 or (res ->> 'flaggedCount')::int <> 0 or (res ->> 'nextRound')::int <> 1 then
    raise exception 'COLLATERAL 17 FAILED: an untouched cycle is not empty: %', res;
  end if;

  -- =========================================================================
  -- COLLATERAL: guarantees. A wins round 1; B wins round 2.
  -- =========================================================================
  select count(*) into entries_before from public.ledger_entries where group_id = group_g;
  select last_sequence, last_hash into head_before from public.ledger_group_heads where group_id = group_g;

  -- who may propose
  perform pg_temp.expect_error(c_uid,    format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(a_uid,    format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(h_uid,    format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error('',       format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', gen_random_uuid(), a_uid, b_uid), 'collateral_forbidden', '42501');
  -- what may be proposed
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, c_uid, b_uid), 'collateral_winner_not_found', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_2, a_uid, b_uid), 'collateral_winner_not_found', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, a_uid), 'collateral_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,null)', cycle_1, a_uid), 'collateral_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, outsider), 'collateral_member_not_found', 'P0002');
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, i_uid), 'collateral_member_not_found', 'P0002');
  if (select count(*) from public.draw_collateral_guarantees) <> 0 then
    raise exception 'COLLATERAL 18 FAILED: a refused proposal left a row';
  end if;

  res := pg_temp.call_as(t_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid));
  guarantee_ab := (res -> 'guarantee' ->> 'guaranteeId')::uuid;
  if (res ->> 'replayed')::boolean is not false
     or res -> 'guarantee' ->> 'state' <> 'proposed'
     or res -> 'guarantee' ->> 'winnerMemberId' <> a_uid or res -> 'guarantee' ->> 'guarantorMemberId' <> b_uid
     or res -> 'guarantee' ->> 'proposedBy' <> t_uid or res -> 'guarantee' ->> 'stateBy' <> t_uid
     or res -> 'guarantee' -> 'acceptedAt' <> 'null'::jsonb then
    raise exception 'COLLATERAL 19 FAILED: unexpected proposal %', res;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(res -> 'guarantee') k)
     is distinct from array['acceptedAt','cycleId','guaranteeId','guarantorMemberId','proposedAt','proposedBy','reason','state','stateAt','stateBy','successorGuaranteeId','winnerMemberId'] then
    raise exception 'COLLATERAL 20 FAILED: unexpected guarantee keys %', res -> 'guarantee';
  end if;
  res2 := pg_temp.call_as(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid));
  if (res2 ->> 'replayed')::boolean is not true or (res2 -> 'guarantee' ->> 'guaranteeId')::uuid <> guarantee_ab then
    raise exception 'COLLATERAL 21 FAILED: proposing the same guarantee again was not a replay: %', res2;
  end if;
  res := pg_temp.call_as(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, c_uid));
  guarantee_ac := (res -> 'guarantee' ->> 'guaranteeId')::uuid;

  -- THE GUARANTOR'S OWN CONSENT
  perform pg_temp.expect_error(owner_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(t_uid,     format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(a_uid,     format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(c_uid,     format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(outsider,  format('select public.respond_collateral_guarantee_v1(%L, false)', guarantee_ab), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error('',        format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(b_uid,     format('select public.respond_collateral_guarantee_v1(%L, true)', gen_random_uuid()), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(b_uid,     format('select public.respond_collateral_guarantee_v1(%L, null)', guarantee_ab), 'collateral_invalid_request', '22023');
  if public.sened_collateral_guarantee_state(guarantee_ab) <> 'proposed' then
    raise exception 'COLLATERAL 22 FAILED: someone other than the guarantor changed the state';
  end if;
  -- the trigger holds this for a writer that skips the RPC
  begin
    insert into public.draw_collateral_guarantee_events (guarantee_id, group_id, event_type, actor_id)
    values (guarantee_ab, group_g, 'accepted', owner_uid::uuid);
    raise exception 'COLLATERAL 23 FAILED: an accepted event written by the owner was accepted';
  exception when others then
    if sqlerrm <> 'collateral_forbidden' then raise exception 'COLLATERAL 23 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.draw_collateral_guarantee_events (guarantee_id, group_id, event_type, actor_id, reason)
    values (guarantee_ab, group_g, 'declined', t_uid::uuid, null);
    raise exception 'COLLATERAL 24 FAILED: a declined event written by the treasurer was accepted';
  exception when others then
    if sqlerrm <> 'collateral_forbidden' then raise exception 'COLLATERAL 24 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.draw_collateral_guarantees (group_id, tenant_id, cycle_id, winner_member_id, guarantor_member_id, proposed_by)
    values (group_g, tenant_g, cycle_1, c_uid::uuid, b_uid::uuid, owner_uid::uuid);
    raise exception 'COLLATERAL 25 FAILED: a guarantee for a non-winner was accepted directly';
  exception when others then
    if sqlerrm <> 'collateral_winner_not_found' then raise exception 'COLLATERAL 25 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.draw_collateral_guarantees (group_id, tenant_id, cycle_id, winner_member_id, guarantor_member_id, proposed_by)
    values (group_g, tenant_g, cycle_1, a_uid::uuid, a_uid::uuid, owner_uid::uuid);
    raise exception 'COLLATERAL 26 FAILED: a self-guarantee was accepted directly';
  exception when check_violation then null;
  end;
  begin
    insert into public.draw_collateral_guarantees (group_id, tenant_id, cycle_id, winner_member_id, guarantor_member_id, proposed_by)
    values (group_g, tenant_g, cycle_1, a_uid::uuid, b_uid::uuid, c_uid::uuid);
    raise exception 'COLLATERAL 27 FAILED: a proposal by a plain member was accepted directly';
  exception when others then
    if sqlerrm <> 'collateral_forbidden' then raise exception 'COLLATERAL 27 FAILED: %', sqlerrm; end if;
  end;

  -- B accepts in their own session
  res := pg_temp.call_as(b_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab));
  if (res ->> 'replayed')::boolean is not false or res -> 'guarantee' ->> 'state' <> 'accepted'
     or res -> 'guarantee' ->> 'stateBy' <> b_uid or res -> 'guarantee' -> 'acceptedAt' = 'null'::jsonb then
    raise exception 'COLLATERAL 28 FAILED: unexpected acceptance %', res;
  end if;
  res2 := pg_temp.call_as(b_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab));
  if (res2 ->> 'replayed')::boolean is not true then
    raise exception 'COLLATERAL 29 FAILED: accepting twice was not a replay: %', res2;
  end if;
  perform pg_temp.expect_error(b_uid, format('select public.respond_collateral_guarantee_v1(%L, false)', guarantee_ab), 'collateral_state_conflict', 'P0001');
  -- C declines (with and without a reason), once
  res := pg_temp.call_as(c_uid, format('select public.respond_collateral_guarantee_v1(%L, false, %L)', guarantee_ac, 'I cannot take this on'));
  if res -> 'guarantee' ->> 'state' <> 'declined' or res -> 'guarantee' ->> 'reason' <> 'I cannot take this on' then
    raise exception 'COLLATERAL 30 FAILED: unexpected decline %', res;
  end if;
  perform pg_temp.expect_error(c_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ac), 'collateral_state_conflict', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.release_collateral_guarantee_v1(%L, %L)', guarantee_ac, 'Releasing something already declined'), 'collateral_state_conflict', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ac, t_uid, 'Replacing something already declined'), 'collateral_state_conflict', 'P0001');

  -- release: a reason is required; the guarantor or an owner/treasurer may; a plain member may not
  perform pg_temp.expect_error(b_uid, format('select public.release_collateral_guarantee_v1(%L, %L)', guarantee_ab, 'short'), 'collateral_invalid_request', '22023');
  perform pg_temp.expect_error(c_uid, format('select public.release_collateral_guarantee_v1(%L, %L)', guarantee_ab, 'A plain member cannot release this'), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(a_uid, format('select public.release_collateral_guarantee_v1(%L, %L)', guarantee_ab, 'The winner cannot release their guarantor'), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.release_collateral_guarantee_v1(%L, %L)', guarantee_ab, 'An outsider cannot release this'), 'collateral_forbidden', '42501');
  res := pg_temp.call_as(b_uid, format('select public.release_collateral_guarantee_v1(%L, %L)', guarantee_ab, 'I can no longer vouch for this member'));
  if res -> 'guarantee' ->> 'state' <> 'released' or res -> 'guarantee' ->> 'stateBy' <> b_uid
     or res -> 'guarantee' -> 'acceptedAt' = 'null'::jsonb then
    raise exception 'COLLATERAL 31 FAILED: unexpected release %', res;
  end if;
  res2 := pg_temp.call_as(owner_uid, format('select public.release_collateral_guarantee_v1(%L, %L)', guarantee_ab, 'Treasurer confirms the release'));
  if (res2 ->> 'replayed')::boolean is not true then
    raise exception 'COLLATERAL 32 FAILED: releasing twice was not a replay: %', res2;
  end if;
  perform pg_temp.expect_error(b_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab), 'collateral_state_conflict', 'P0001');

  -- a released guarantee does not block a fresh one; supersede names its successor
  res := pg_temp.call_as(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, a_uid, b_uid));
  guarantee_ab2 := (res -> 'guarantee' ->> 'guaranteeId')::uuid;
  if guarantee_ab2 = guarantee_ab or (res ->> 'replayed')::boolean is not false then
    raise exception 'COLLATERAL 33 FAILED: a released guarantee blocked a fresh proposal: %', res;
  end if;
  perform pg_temp.call_as(b_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_ab2));
  perform pg_temp.expect_error(c_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, c_uid, 'A plain member cannot replace a guarantor'), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(b_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, c_uid, 'The guarantor cannot replace themselves'), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, b_uid, 'Same guarantor changes nothing here'), 'collateral_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, a_uid, 'The winner cannot guarantee themselves'), 'collateral_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, c_uid, 'short'), 'collateral_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, outsider, 'Outsider is not an active member'), 'collateral_member_not_found', 'P0002');
  res := pg_temp.call_as(owner_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, c_uid, 'B moved away, C will vouch instead'));
  guarantee_succ := (res -> 'guarantee' ->> 'guaranteeId')::uuid;
  if res -> 'superseded' ->> 'state' <> 'superseded'
     or (res -> 'superseded' ->> 'successorGuaranteeId')::uuid <> guarantee_succ
     or res -> 'guarantee' ->> 'state' <> 'proposed' or res -> 'guarantee' ->> 'guarantorMemberId' <> c_uid
     or res -> 'guarantee' ->> 'winnerMemberId' <> a_uid or (res ->> 'replayed')::boolean is not false then
    raise exception 'COLLATERAL 34 FAILED: unexpected supersede %', res;
  end if;
  res2 := pg_temp.call_as(owner_uid, format('select public.supersede_collateral_guarantee_v1(%L, %L, %L)', guarantee_ab2, c_uid, 'B moved away, C will vouch instead'));
  if (res2 ->> 'replayed')::boolean is not true or (res2 -> 'guarantee' ->> 'guaranteeId')::uuid <> guarantee_succ then
    raise exception 'COLLATERAL 35 FAILED: repeating the supersede was not a replay: %', res2;
  end if;
  -- the replacement still needs the new guarantor's own consent
  perform pg_temp.expect_error(owner_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_succ), 'collateral_forbidden', '42501');
  perform pg_temp.expect_error(b_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_succ), 'collateral_forbidden', '42501');
  perform pg_temp.call_as(c_uid, format('select public.respond_collateral_guarantee_v1(%L, true)', guarantee_succ));

  -- the derived view carries every guarantee, with its state, under the winner
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = a_uid;
  if jsonb_array_length(winner_a -> 'guarantees') <> 4
     or (select array_agg(g ->> 'state' order by g ->> 'proposedAt', g ->> 'guaranteeId') from jsonb_array_elements(winner_a -> 'guarantees') g) is null
     or (select count(*) from jsonb_array_elements(winner_a -> 'guarantees') g where g ->> 'state' = 'accepted') <> 1
     or (select count(*) from jsonb_array_elements(winner_a -> 'guarantees') g where g ->> 'state' = 'declined') <> 1
     or (select count(*) from jsonb_array_elements(winner_a -> 'guarantees') g where g ->> 'state' = 'released') <> 1
     or (select count(*) from jsonb_array_elements(winner_a -> 'guarantees') g where g ->> 'state' = 'superseded') <> 1 then
    raise exception 'COLLATERAL 36 FAILED: the view does not carry each guarantee with its derived state: %', winner_a -> 'guarantees';
  end if;

  -- last round: a winner of the final round has nothing left to guarantee
  reset role;
  perform pg_temp.fx_reveal(group_g, tenant_g, cycle_1, 3, c_uid::uuid, owner_uid::uuid);
  perform pg_temp.fx_reveal(group_g, tenant_g, cycle_1, 4, t_uid::uuid, owner_uid::uuid);
  perform pg_temp.expect_error(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, t_uid, b_uid), 'collateral_no_remaining_rounds', 'P0001');
  res := pg_temp.call_as(owner_uid, format('select public.propose_collateral_guarantee_v1(%L,%L,%L)', cycle_1, c_uid, b_uid));
  if res -> 'guarantee' ->> 'state' <> 'proposed' then
    raise exception 'COLLATERAL 37 FAILED: a round-3 winner (one round left) could not be guaranteed: %', res;
  end if;
  res := pg_temp.call_as(c_uid, format('select public.get_draw_cycle_collateral_v1(%L)', cycle_1));
  if (res ->> 'nextRound') is not null and res -> 'nextRound' <> 'null'::jsonb then
    raise exception 'COLLATERAL 38 FAILED: a finished cycle still has a next round: %', res;
  end if;
  select w into winner_a from jsonb_array_elements(res -> 'winners') w where w ->> 'memberId' = t_uid;
  if jsonb_array_length(winner_a -> 'owed') <> 0 then
    raise exception 'COLLATERAL 39 FAILED: the final-round winner owes rounds: %', winner_a;
  end if;

  -- append-only
  begin
    update public.draw_collateral_guarantee_events set reason = 'edited' where guarantee_id = guarantee_ab;
    raise exception 'COLLATERAL 40 FAILED: an event was updated';
  exception when others then
    if sqlerrm <> 'collateral_history_immutable' then raise exception 'COLLATERAL 40 FAILED: %', sqlerrm; end if;
  end;
  begin
    delete from public.draw_collateral_guarantee_events where guarantee_id = guarantee_ab;
    raise exception 'COLLATERAL 41 FAILED: an event was deleted';
  exception when others then
    if sqlerrm <> 'collateral_history_immutable' then raise exception 'COLLATERAL 41 FAILED: %', sqlerrm; end if;
  end;
  begin
    update public.draw_collateral_guarantees set guarantor_member_id = c_uid::uuid where id = guarantee_ab;
    raise exception 'COLLATERAL 42 FAILED: a guarantee was updated';
  exception when others then
    if sqlerrm <> 'collateral_history_immutable' then raise exception 'COLLATERAL 42 FAILED: %', sqlerrm; end if;
  end;
  begin
    delete from public.draw_collateral_guarantees where id = guarantee_ab;
    raise exception 'COLLATERAL 43 FAILED: a guarantee was deleted';
  exception when others then
    if sqlerrm <> 'collateral_history_immutable' then raise exception 'COLLATERAL 43 FAILED: %', sqlerrm; end if;
  end;
  set constraints all immediate;
  begin
    truncate public.draw_collateral_guarantee_events;
    raise exception 'COLLATERAL 44 FAILED: the events table was truncated';
  exception when others then
    if sqlerrm <> 'collateral_history_immutable' then raise exception 'COLLATERAL 44 FAILED: %', sqlerrm; end if;
  end;
  -- a second accepted event, and a second ending, are refused by the indexes
  begin
    insert into public.draw_collateral_guarantee_events (guarantee_id, group_id, event_type, actor_id)
    values (guarantee_succ, group_g, 'accepted', c_uid::uuid);
    raise exception 'COLLATERAL 45 FAILED: a second accepted event was accepted';
  exception when others then
    if sqlerrm <> 'collateral_state_conflict' then raise exception 'COLLATERAL 45 FAILED: %', sqlerrm; end if;
  end;
  begin
    insert into public.draw_collateral_guarantee_events (guarantee_id, group_id, event_type, actor_id, reason)
    values (guarantee_ab2, group_g, 'released', owner_uid::uuid, 'Releasing a guarantee that was superseded');
    raise exception 'COLLATERAL 45 FAILED: an ended guarantee was released';
  exception when others then
    if sqlerrm <> 'collateral_state_conflict' then raise exception 'COLLATERAL 45 FAILED: %', sqlerrm; end if;
  end;
  -- client roles cannot write the tables; members read them, an outsider cannot
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  set local role authenticated;
  begin
    insert into public.draw_collateral_guarantee_events (guarantee_id, group_id, event_type, actor_id)
    values (guarantee_succ, group_g, 'accepted', owner_uid::uuid);
    raise exception 'COLLATERAL 46 FAILED: authenticated wrote an event directly';
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', c_uid, true);
  set local role authenticated;
  select count(*) into n from public.draw_collateral_guarantee_events;
  reset role;
  if n < 5 then
    raise exception 'COLLATERAL 47 FAILED: a member cannot read the events (%)', n;
  end if;
  perform set_config('request.jwt.claim.sub', outsider, true);
  set local role authenticated;
  select count(*) into n from public.draw_collateral_guarantee_events;
  if n <> 0 or (select count(*) from public.draw_collateral_guarantees) <> 0 then
    raise exception 'COLLATERAL 48 FAILED: an outsider reads guarantee rows';
  end if;
  reset role;

  -- ADVISORY ONLY: no guarantee operation touched the ledger
  select last_sequence, last_hash into head_after from public.ledger_group_heads where group_id = group_g;
  if head_after.last_sequence <> head_before.last_sequence or head_after.last_hash <> head_before.last_hash
     or (select count(*) from public.ledger_entries where group_id = group_g) <> entries_before then
    raise exception 'COLLATERAL 49 FAILED: a guarantee operation changed the ledger';
  end if;

  -- grants
  if has_function_privilege('anon', 'public.propose_collateral_guarantee_v1(uuid, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('public', 'public.respond_collateral_guarantee_v1(uuid, boolean, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.release_collateral_guarantee_v1(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.supersede_collateral_guarantee_v1(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_draw_cycle_collateral_v1(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_collateral_member_entries(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_collateral_guarantee_state(uuid)', 'EXECUTE') then
    raise exception 'COLLATERAL 50 FAILED: a function is executable by a role that must not have it';
  end if;
  if not has_function_privilege('authenticated', 'public.propose_collateral_guarantee_v1(uuid, uuid, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.respond_collateral_guarantee_v1(uuid, boolean, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.release_collateral_guarantee_v1(uuid, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.supersede_collateral_guarantee_v1(uuid, uuid, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_draw_cycle_collateral_v1(uuid)', 'EXECUTE') then
    raise exception 'COLLATERAL 51 FAILED: authenticated cannot execute a collateral RPC';
  end if;
end;
$attr$;

-- ---------------------------------------------------------------------------
-- CONTRIBUTION GRID AND GATE (migration 20261011100000)
--
-- GRID. get_draw_cycle_contributions_v1 derives met / flagged / not_due for EVERY
-- member and EVERY round, on read, with the same qualifying-contribution rules as the
-- collateral view. Checks: nothing is due before a draw is opened; a non-winner's
-- rounds are met / flagged / not_due as documented; a bank-verified payment counts by
-- provenance; an amount under the share does not; late payments clear the earliest
-- unmet round of a non-winner; an explicit cycle+round attribution assigns its round
-- (even one not due); another cycle's attribution is ignored; a reversal clears `met`;
-- a winner's post-win payment never clears a pre-win round (explicit attribution does);
-- and a winner's output in get_draw_cycle_collateral_v1 equals both the grid and a
-- verbatim copy of the pre-migration derivation.
--
-- GATE. off / warn / block at creation (default off, also for rows that predate the
-- column); a change by owner/treasurer only, with a reason, as an append-only event;
-- open_draw_v1 refuses under `block` while an active member has a flagged round before
-- the round being opened, unless an owner/treasurer gives a 10..1000 character reason,
-- which is recorded (who, when, reason, which rounds) append-only; `warn` allows;
-- `off` computes nothing; an outsider and a plain member are refused everywhere;
-- the tables are append-only and read-only to clients.
-- ---------------------------------------------------------------------------
-- The attribution checks above ended with `set constraints all immediate`; ledger entries and
-- their postings are written in separate statements, so deferral is restored for this section.
set constraints all deferred;

create or replace function pg_temp.grid_cell(p_res jsonb, p_member uuid, p_round integer)
returns text
language sql
as $$
  select c ->> 'status'
  from jsonb_array_elements(p_res -> 'members') m, jsonb_array_elements(m -> 'cells') c
  where m ->> 'memberId' = p_member::text and (c ->> 'round')::int = p_round;
$$;

create or replace function pg_temp.grid_cell_json(p_res jsonb, p_member uuid, p_round integer)
returns jsonb
language sql
as $$
  select c
  from jsonb_array_elements(p_res -> 'members') m, jsonb_array_elements(m -> 'cells') c
  where m ->> 'memberId' = p_member::text and (c ->> 'round')::int = p_round;
$$;

-- All of one member's statuses as 'met,flagged,not_due,...' in round order.
create or replace function pg_temp.grid_row(p_res jsonb, p_member uuid)
returns text
language sql
as $$
  select string_agg(c ->> 'status', ',' order by (c ->> 'round')::int)
  from jsonb_array_elements(p_res -> 'members') m, jsonb_array_elements(m -> 'cells') c
  where m ->> 'memberId' = p_member::text;
$$;

-- Post a contribution as `p_owner` and (optionally) attribute it to `p_member`.
create or replace function pg_temp.fx_pay(
  p_owner uuid, p_group uuid, p_key text, p_amount text, p_cash uuid, p_income uuid,
  p_member uuid default null, p_cycle uuid default null, p_round integer default null
)
returns uuid
language plpgsql
as $$
declare
  entry_uuid uuid;
begin
  perform set_config('request.jwt.claim.sub', p_owner::text, true);
  entry_uuid := (public.post_ledger_entry_v1(p_group, p_key, now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', p_cash, 'direction', 'debit', 'amount', p_amount),
                      jsonb_build_object('accountId', p_income, 'direction', 'credit', 'amount', p_amount))) -> 'entry' ->> 'id')::uuid;
  if p_member is not null then
    perform public.record_ledger_entry_attribution_v1(p_group, entry_uuid, p_member, p_cycle, p_round);
  end if;
  return entry_uuid;
end;
$$;

create or replace function pg_temp.fx_reverse(p_owner uuid, p_group uuid, p_key text, p_entry uuid, p_amount text, p_cash uuid, p_income uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_owner::text, true);
  perform public.post_ledger_entry_v1(p_group, p_key, now(), 'correction', p_entry,
    'Reversing this payment, recorded in error.',
    jsonb_build_array(jsonb_build_object('accountId', p_cash, 'direction', 'credit', 'amount', p_amount),
                      jsonb_build_object('accountId', p_income, 'direction', 'debit', 'amount', p_amount)));
end;
$$;

-- Like expect_error, but returns the DETAIL of the error (as jsonb when it parses).
create or replace function pg_temp.expect_error_detail(p_uid text, p_sql text, p_msg text, p_state text)
returns jsonb
language plpgsql
as $$
declare
  got_msg text;
  got_state text;
  got_detail text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  begin
    set local role authenticated;
    execute p_sql;
    reset role;
    raise exception 'no error' using errcode = 'XX999';
  exception when others then
    get stacked diagnostics got_detail = pg_exception_detail;
    got_msg := sqlerrm;
    got_state := sqlstate;
  end;
  reset role;
  if got_state = 'XX999' then
    raise exception 'EXPECT FAILED: no error from [%], wanted % %', p_sql, p_state, p_msg;
  end if;
  if got_msg <> p_msg or got_state <> p_state then
    raise exception 'EXPECT FAILED: [%] wanted % %, got % %', p_sql, p_state, p_msg, got_state, got_msg;
  end if;
  return got_detail::jsonb;
end;
$$;

-- A verbatim copy of the pre-migration derivation of one winner's owed rounds
-- (get_draw_cycle_collateral_v1 as of 20261010100000), for the unchanged-output check.
create or replace function pg_temp.legacy_owed(p_cycle_id uuid, p_member uuid, p_win_round integer, p_total integer)
returns jsonb
language plpgsql
as $$
declare
  owed jsonb := '[]'::jsonb;
  used uuid[] := array[]::uuid[];
  round_no integer;
  due_at timestamptz;
  prev_at timestamptz;
  found_entry uuid;
  found_source text;
  status text;
begin
  for round_no in (p_win_round + 1) .. p_total loop
    select min(opened.at_time) into due_at
    from (
      select s.opened_at as at_time from public.draw_sessions s
      where s.cycle_id = p_cycle_id and s.round = round_no
      union all
      select cm2.committed_at from public.draw_commitments cm2
      where cm2.cycle_id = p_cycle_id and cm2.round = round_no
    ) opened;
    select min(rv2.revealed_at) into prev_at
    from public.draw_commitments cm3
    join public.draw_reveals rv2 on rv2.draw_id = cm3.draw_id
    where cm3.cycle_id = p_cycle_id and cm3.round = round_no - 1;

    found_entry := null;
    found_source := null;
    select c.entry_id, c.source into found_entry, found_source
    from public.sened_collateral_member_entries(p_cycle_id, p_member) c
    where c.round = round_no
    order by c.recorded_at, c.entry_id
    limit 1;
    if found_entry is null and due_at is not null and prev_at is not null then
      select c.entry_id, c.source into found_entry, found_source
      from public.sened_collateral_member_entries(p_cycle_id, p_member) c
      where c.round is null
        and c.recorded_at > prev_at
        and c.entry_id <> all (used)
      order by c.recorded_at, c.entry_id
      limit 1;
      if found_entry is not null then
        used := used || found_entry;
      end if;
    end if;
    if found_entry is not null then
      status := 'met';
    elsif due_at is not null then
      status := 'flagged';
    else
      status := 'not_due';
    end if;
    owed := owed || jsonb_build_array(jsonb_build_object(
      'round', round_no,
      'status', status,
      'dueAt', case when due_at is null then null else public.sened_ts_iso(due_at) end,
      'entryId', found_entry,
      'source', found_source
    ));
  end loop;
  return owed;
end;
$$;

insert into auth.users (id, email) values
  ('aaaaaaaa-1000-4000-8000-000000000001', 'grid-owner@example.test'),
  ('aaaaaaaa-1000-4000-8000-000000000002', 'grid-a@example.test'),
  ('aaaaaaaa-1000-4000-8000-000000000003', 'grid-b@example.test'),
  ('aaaaaaaa-1000-4000-8000-000000000004', 'grid-c@example.test'),
  ('aaaaaaaa-2000-4000-8000-000000000001', 'gate-owner@example.test'),
  ('aaaaaaaa-2000-4000-8000-000000000002', 'gate-treasurer@example.test'),
  ('aaaaaaaa-2000-4000-8000-000000000003', 'gate-r@example.test'),
  ('aaaaaaaa-2000-4000-8000-000000000004', 'gate-s@example.test')
on conflict (id) do nothing;

do $grid$
declare
  go constant uuid := 'aaaaaaaa-1000-4000-8000-000000000001';
  ga constant uuid := 'aaaaaaaa-1000-4000-8000-000000000002';
  gb constant uuid := 'aaaaaaaa-1000-4000-8000-000000000003';
  gc constant uuid := 'aaaaaaaa-1000-4000-8000-000000000004';
  outsider constant text := '44444444-4444-4444-8444-444444444444';
  grp uuid; tnt uuid; cash uuid; income uuid;
  k uuid; k2 uuid;
  binding_b uuid := 'cccccccc-0000-4000-8000-0000000000a2';
  res jsonb; res2 jsonb; res3 jsonb;
  w jsonb;
  n bigint;
  ea1 uuid; eb1 uuid; eo50 uuid; ea2 uuid; ec1 uuid; eb2 uuid; eo3 uuid; ebx uuid;
  eo4 uuid; eo5 uuid; eo6 uuid; eb3 uuid;
  head_a record; head_b record;
  legacy jsonb;
  cell jsonb;
begin
  -- Fixtures: group with owner O and members A, B, C (four active members).
  perform set_config('request.jwt.claim.sub', go::text, true);
  grp := (public.sened_ledger_provision_group_v1('Grid equb') ->> 'groupId')::uuid;
  select tenant_id into tnt from public.ledger_groups where id = grp;
  select id into cash from public.ledger_accounts where group_id = grp and code = 'POT_CASH';
  select id into income from public.ledger_accounts where group_id = grp and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (grp, tnt, ga, 'member', 'active'),
    (grp, tnt, gb, 'member', 'active'),
    (grp, tnt, gc, 'member', 'active');

  k := (pg_temp.call_as(go::text, format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 4, 1000, now() - interval ''1 day'', %L)', grp, 'Grid cycle', '100.00', 'grid-k')) -> 'cycle' ->> 'cycleId')::uuid;
  k2 := (pg_temp.call_as(go::text, format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 4, 1000, now() - interval ''1 day'', %L)', grp, 'Grid other cycle', '100.00', 'grid-k2')) -> 'cycle' ->> 'cycleId')::uuid;

  -- =========================================================================
  -- GRID 1-3: nothing is due before a draw is opened; shape; access
  -- =========================================================================
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if (select array_agg(key order by key) from jsonb_object_keys(res) key)
     is distinct from array['contributionAmount','contributionGate','cycleId','flaggedCount','gateEvents','groupId','members','nextRound','overrides','rounds','startedAt','totalRounds'] then
    raise exception 'GRID 1 FAILED: unexpected top-level keys %', res;
  end if;
  if jsonb_array_length(res -> 'members') <> 4 or jsonb_array_length(res -> 'rounds') <> 4
     or (res ->> 'flaggedCount')::int <> 0 or (res ->> 'contributionGate') <> 'off'
     or (res ->> 'nextRound')::int <> 1 or (res ->> 'contributionAmount') <> '100.00' or (res ->> 'totalRounds')::int <> 4
     or jsonb_array_length(res -> 'gateEvents') <> 0 or jsonb_array_length(res -> 'overrides') <> 0 then
    raise exception 'GRID 2 FAILED: unexpected grid before any draw is opened: %', res;
  end if;
  if (select count(*) from jsonb_array_elements(res -> 'members') m, jsonb_array_elements(m -> 'cells') c where c ->> 'status' <> 'not_due') <> 0
     or (select count(*) from jsonb_array_elements(res -> 'members') m, jsonb_array_elements(m -> 'cells') c) <> 16 then
    raise exception 'GRID 3 FAILED: a round is not "not_due" before its draw is opened: %', res;
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(res -> 'members' -> 0) key)
       is distinct from array['active','cells','memberId','winRound']
     or (select array_agg(key order by key) from jsonb_object_keys(res -> 'members' -> 0 -> 'cells' -> 0) key)
       is distinct from array['entryId','round','source','status']
     or (select array_agg(key order by key) from jsonb_object_keys(res -> 'rounds' -> 0) key)
       is distinct from array['dueAt','revealedAt','round'] then
    raise exception 'GRID 4 FAILED: unexpected member, cell or round keys: %', res;
  end if;
  perform pg_temp.expect_error(outsider, format('select public.get_draw_cycle_contributions_v1(%L)', k), 'draw_forbidden', '42501');
  perform pg_temp.expect_error('', format('select public.get_draw_cycle_contributions_v1(%L)', k), 'draw_forbidden', '42501');
  perform pg_temp.expect_error(go::text, format('select public.get_draw_cycle_contributions_v1(%L)', gen_random_uuid()), 'draw_forbidden', '42501');

  -- =========================================================================
  -- GRID 5-: round 1 opened. Every member owes it, winner or not.
  -- =========================================================================
  perform pg_temp.call_as(go::text, format('select public.open_draw_v1(%L, null, %L)', k, 'grid-open-1'));
  res := pg_temp.call_as(ga::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if (res ->> 'flaggedCount')::int <> 4
     or pg_temp.grid_row(res, go) <> 'flagged,not_due,not_due,not_due'
     or pg_temp.grid_row(res, gc) <> 'flagged,not_due,not_due,not_due'
     or (res -> 'rounds' -> 0 -> 'dueAt') = 'null'::jsonb or (res -> 'rounds' -> 1 -> 'dueAt') <> 'null'::jsonb then
    raise exception 'GRID 5 FAILED: round 1 is not flagged for every member once its draw is open: %', res;
  end if;

  ea1 := pg_temp.fx_pay(go, grp, 'grid-ea1', '100.00', cash, income, ga);
  eo50 := pg_temp.fx_pay(go, grp, 'grid-eo50', '50.00', cash, income, go);
  eb1 := pg_temp.fx_pay(go, grp, 'bank-verified-grid-eb1', '100.00', cash, income);
  insert into public.bank_account_bindings (id,user_id,tenant_id,group_id,ledger_account_id,provider,account_label,account_fingerprint_hmac,sender_fingerprint_hmac,receiver_fingerprint_hmac)
  values (binding_b, gb, tnt, grp, cash, 'cbe', 'GB', repeat('1',64), repeat('2',64), repeat('3',64));
  insert into public.bank_verification_intents (id,user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at)
  values ('dddddddd-0000-4000-8000-0000000000a1', gb, tnt, grp, binding_b, cash, 'cbe', repeat('5',64), 'grid-bank-1', repeat('e',64), 100.00, 'inbound', now());
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('4',64), verified_at = now(), ledger_entry_id = eb1
  where id = 'dddddddd-0000-4000-8000-0000000000a1';
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, ga) <> 'met,not_due,not_due,not_due'
     or (pg_temp.grid_cell_json(res, ga, 1) ->> 'source') <> 'treasurer' or (pg_temp.grid_cell_json(res, ga, 1) ->> 'entryId')::uuid <> ea1
     or pg_temp.grid_row(res, gb) <> 'met,not_due,not_due,not_due'
     or (pg_temp.grid_cell_json(res, gb, 1) ->> 'source') <> 'bank_verification' or (pg_temp.grid_cell_json(res, gb, 1) ->> 'entryId')::uuid <> eb1 THEN
    raise exception 'GRID 6 FAILED: a treasurer-attributed or a bank-verified payment did not meet round 1: %', res;
  end if;
  if pg_temp.grid_row(res, go) <> 'flagged,not_due,not_due,not_due' or pg_temp.grid_row(res, gc) <> 'flagged,not_due,not_due,not_due'
     or (res ->> 'flaggedCount')::int <> 2 then
    raise exception 'GRID 7 FAILED: an under-share payment, or no payment, did not leave round 1 flagged: %', res;
  end if;

  -- round 1 revealed: A wins
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, k, 1, ga, go);
  perform pg_sleep(0.02);
  perform pg_temp.call_as(go::text, format('select public.open_draw_v1(%L, 2, %L)', k, 'grid-open-2'));
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, ga) <> 'met,flagged,not_due,not_due'
     or (select (m ->> 'winRound')::int from jsonb_array_elements(res -> 'members') m where m ->> 'memberId' = ga::text) <> 1
     or (select m -> 'winRound' from jsonb_array_elements(res -> 'members') m where m ->> 'memberId' = gb::text) <> 'null'::jsonb
     or (res -> 'rounds' -> 0 ->> 'revealedAt') is null or (res -> 'rounds' -> 1 -> 'revealedAt') <> 'null'::jsonb
     or (res ->> 'nextRound')::int <> 2 then
    raise exception 'GRID 8 FAILED: round 2 is not flagged for the winner and the others, or winRound/revealedAt are wrong: %', res;
  end if;

  -- payments after the reveal
  ea2 := pg_temp.fx_pay(go, grp, 'grid-ea2', '100.00', cash, income, ga);
  ec1 := pg_temp.fx_pay(go, grp, 'grid-ec1', '100.00', cash, income, gc);
  eb2 := pg_temp.fx_pay(go, grp, 'grid-eb2', '100.00', cash, income, gb);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, ga) <> 'met,met,not_due,not_due'
     or (pg_temp.grid_cell_json(res, ga, 2) ->> 'entryId')::uuid <> ea2 then
    raise exception 'GRID 9 FAILED: a winner''s post-win payment did not meet round 2: %', res;
  end if;
  if pg_temp.grid_row(res, gc) <> 'met,flagged,not_due,not_due'
     or (pg_temp.grid_cell_json(res, gc, 1) ->> 'entryId')::uuid <> ec1 then
    raise exception 'GRID 10 FAILED: a non-winner''s late payment did not clear their EARLIEST unmet round (1), leaving round 2 flagged: %', res;
  end if;
  if pg_temp.grid_row(res, gb) <> 'met,met,not_due,not_due'
     or (pg_temp.grid_cell_json(res, gb, 2) ->> 'entryId')::uuid <> eb2 or (pg_temp.grid_cell_json(res, gb, 2) ->> 'source') <> 'treasurer'
     or pg_temp.grid_row(res, go) <> 'flagged,flagged,not_due,not_due'
     or (res ->> 'flaggedCount')::int <> 3 then
    raise exception 'GRID 11 FAILED: round 2 statuses of B / O or the flagged count are wrong: %', res;
  end if;

  -- an explicit cycle+round attribution assigns a round that is not due yet
  eo3 := pg_temp.fx_pay(go, grp, 'grid-eo3', '100.00', cash, income, go, k, 3);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, go) <> 'flagged,flagged,met,not_due'
     or (pg_temp.grid_cell_json(res, go, 3) ->> 'entryId')::uuid <> eo3 then
    raise exception 'GRID 12 FAILED: an explicit cycle+round attribution did not assign round 3 (not yet due): %', res;
  end if;
  -- an attribution naming ANOTHER cycle is ignored here and counts there
  ebx := pg_temp.fx_pay(go, grp, 'grid-ebx', '100.00', cash, income, gb, k2, 1);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  res2 := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k2));
  if pg_temp.grid_row(res, gb) <> 'met,met,not_due,not_due'
     or pg_temp.grid_cell(res2, gb, 1) <> 'met' or (pg_temp.grid_cell_json(res2, gb, 1) ->> 'entryId')::uuid <> ebx
     or pg_temp.grid_cell(res2, ga, 1) <> 'not_due' then
    raise exception 'GRID 13 FAILED: another cycle''s attribution leaked into this cycle (or did not count in its own): % / %', res, res2;
  end if;

  -- a reversal clears `met`
  perform pg_temp.fx_reverse(go, grp, 'grid-eb2-fix', eb2, '100.00', cash, income);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, gb) <> 'met,flagged,not_due,not_due' or (res ->> 'flaggedCount')::int <> 4 then
    raise exception 'GRID 14 FAILED: reversing a payment did not make its round flagged again: %', res;
  end if;
  eb3 := pg_temp.fx_pay(go, grp, 'grid-eb3', '100.00', cash, income, gb);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, gb) <> 'met,met,not_due,not_due' or (pg_temp.grid_cell_json(res, gb, 2) ->> 'entryId')::uuid <> eb3 then
    raise exception 'GRID 15 FAILED: a replacement payment did not meet the round again: %', res;
  end if;

  -- O wins round 2. Their pre-win round 1 is flagged, their win round 2 is flagged.
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, k, 2, go, go);
  perform pg_sleep(0.02);
  perform pg_temp.call_as(go::text, format('select public.open_draw_v1(%L, 3, %L)', k, 'grid-open-3'));
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, go) <> 'flagged,flagged,met,not_due'
     or pg_temp.grid_row(res, ga) <> 'met,met,flagged,not_due'
     or pg_temp.grid_row(res, gb) <> 'met,met,flagged,not_due'
     or pg_temp.grid_row(res, gc) <> 'met,flagged,flagged,not_due' then
    raise exception 'GRID 16 FAILED: grid after round 3 opened is wrong: %', res;
  end if;

  -- POST-WIN FILL (20261013100000, superseding the 20261011100000 "split at the win"). O pays
  -- after winning: round 3 is already met (explicit) and round 4 is not open, so nothing after the
  -- win is due and unmet, and the payment clears O's EARLIEST missed round, round 1.
  perform pg_sleep(0.02);
  eo4 := pg_temp.fx_pay(go, grp, 'grid-eo4', '100.00', cash, income, go);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, go) <> 'met,flagged,met,not_due'
     or (pg_temp.grid_cell_json(res, go, 1) ->> 'entryId')::uuid <> eo4 then
    raise exception 'GRID 17 FAILED: a payment recorded after the member''s win, with nothing after the win due and unmet, did not clear their earliest missed round: %', res;
  end if;
  -- round 3 revealed (B wins), round 4 opened: eo4 was decided at its own time and does not move
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, k, 3, gb, go);
  perform pg_sleep(0.02);
  perform pg_temp.call_as(go::text, format('select public.open_draw_v1(%L, 4, %L)', k, 'grid-open-4'));
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, go) <> 'met,flagged,met,flagged'
     or (pg_temp.grid_cell_json(res, go, 1) ->> 'entryId')::uuid <> eo4 then
    raise exception 'GRID 18 FAILED: a payment recorded before the previous reveal paid round 4, or moved when round 4 opened: %', res;
  end if;
  eo5 := pg_temp.fx_pay(go, grp, 'grid-eo5', '100.00', cash, income, go);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, go) <> 'met,flagged,met,met' or (pg_temp.grid_cell_json(res, go, 4) ->> 'entryId')::uuid <> eo5 then
    raise exception 'GRID 19 FAILED: a post-win payment after the previous reveal did not meet round 4: %', res;
  end if;
  -- an explicit attribution claims round 1; the entry that held it falls to the next missed round
  eo6 := pg_temp.fx_pay(go, grp, 'grid-eo6', '100.00', cash, income, go, k, 1);
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(res, go) <> 'met,met,met,met'
     or (pg_temp.grid_cell_json(res, go, 1) ->> 'entryId')::uuid <> eo6
     or (pg_temp.grid_cell_json(res, go, 2) ->> 'entryId')::uuid <> eo4 then
    raise exception 'GRID 20 FAILED: an explicit attribution did not claim round 1 (or the displaced entry did not clear the next missed round): %', res;
  end if;

  -- =========================================================================
  -- COLLATERAL UNCHANGED: every winner's owed rounds equal the grid's cells for the
  -- rounds after their win AND the verbatim pre-migration derivation.
  -- =========================================================================
  res3 := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_collateral_v1(%L)', k));
  res := pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if jsonb_array_length(res3 -> 'winners') <> 3 then
    raise exception 'COLLATERAL-GRID 1 FAILED: expected three winners: %', res3;
  end if;
  for w in select x from jsonb_array_elements(res3 -> 'winners') x loop
    legacy := pg_temp.legacy_owed(k, (w ->> 'memberId')::uuid, (w ->> 'round')::int, 4);
    if (w -> 'owed') is distinct from legacy then
      raise exception 'COLLATERAL-GRID 2 FAILED: the collateral view of % differs from the pre-migration derivation: % vs %', w ->> 'memberId', w -> 'owed', legacy;
    end if;
    for cell in select y from jsonb_array_elements(w -> 'owed') y loop
      if (cell ->> 'status') <> pg_temp.grid_cell(res, (w ->> 'memberId')::uuid, (cell ->> 'round')::int)
         or (cell -> 'entryId') is distinct from (pg_temp.grid_cell_json(res, (w ->> 'memberId')::uuid, (cell ->> 'round')::int) -> 'entryId')
         or (cell -> 'source') is distinct from (pg_temp.grid_cell_json(res, (w ->> 'memberId')::uuid, (cell ->> 'round')::int) -> 'source') then
        raise exception 'COLLATERAL-GRID 3 FAILED: the grid and the collateral view disagree on % round %: % ', w ->> 'memberId', cell ->> 'round', cell;
      end if;
    end loop;
  end loop;

  -- READ ONLY: reading the grid wrote nothing to the ledger
  select last_sequence, last_hash into head_a from public.ledger_group_heads where group_id = grp;
  perform pg_temp.call_as(gc::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  select last_sequence, last_hash into head_b from public.ledger_group_heads where group_id = grp;
  if head_a.last_sequence <> head_b.last_sequence or head_a.last_hash <> head_b.last_hash then
    raise exception 'GRID 21 FAILED: reading the grid moved the ledger chain';
  end if;
  -- cycle JSON carries the effective policy
  if (pg_temp.call_as(gc::text, format('select public.get_draw_cycle_v1(%L)', k)) -> 'cycle' ->> 'contributionGate') <> 'off'
     or (pg_temp.call_as(gc::text, format('select public.list_draw_cycles_v1(%L)', grp)) -> 0 ->> 'contributionGate') <> 'off' then
    raise exception 'GRID 22 FAILED: the cycle JSON does not carry contributionGate';
  end if;
end;
$grid$;

do $gate$
declare
  gp constant uuid := 'aaaaaaaa-2000-4000-8000-000000000001'; -- owner
  gq constant uuid := 'aaaaaaaa-2000-4000-8000-000000000002'; -- treasurer role
  gr constant uuid := 'aaaaaaaa-2000-4000-8000-000000000003';
  gs constant uuid := 'aaaaaaaa-2000-4000-8000-000000000004';
  outsider constant text := '44444444-4444-4444-8444-444444444444';
  grp uuid; tnt uuid; cash uuid; income uuid;
  c_off uuid; c_warn uuid; c_block uuid; c_legacy uuid;
  res jsonb; detail jsonb; sess uuid; n bigint; who uuid; r integer;
  rows_before bigint;
  ov record;
  ev record;
begin
  perform set_config('request.jwt.claim.sub', gp::text, true);
  grp := (public.sened_ledger_provision_group_v1('Gate equb') ->> 'groupId')::uuid;
  select tenant_id into tnt from public.ledger_groups where id = grp;
  select id into cash from public.ledger_accounts where group_id = grp and code = 'POT_CASH';
  select id into income from public.ledger_accounts where group_id = grp and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (grp, tnt, gq, 'treasurer', 'active'),
    (grp, tnt, gr, 'member', 'active'),
    (grp, tnt, gs, 'member', 'active');

  -- =========================================================================
  -- GATE: choosing the policy at creation
  -- =========================================================================
  perform pg_temp.expect_error(gp::text, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L,%L)', grp, 'x', '100.00', 'gate-bad', 'bogus'), 'draw_invalid_request', 'P0001');
  perform pg_temp.expect_error(gr::text, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L,%L)', grp, 'x', '100.00', 'gate-mem', 'block'), 'draw_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L,%L)', grp, 'x', '100.00', 'gate-out', 'block'), 'draw_forbidden', '42501');
  -- the seven-argument form still works and means "off"
  res := pg_temp.call_as(gp::text, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L)', grp, 'Off cycle', '100.00', 'gate-off'));
  c_off := (res -> 'cycle' ->> 'cycleId')::uuid;
  if res -> 'cycle' ->> 'contributionGate' <> 'off' then
    raise exception 'GATE 1 FAILED: a cycle created without a policy is not off: %', res;
  end if;
  res := pg_temp.call_as(gp::text, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L,%L)', grp, 'Warn cycle', '100.00', 'gate-warn', 'warn'));
  c_warn := (res -> 'cycle' ->> 'cycleId')::uuid;
  if res -> 'cycle' ->> 'contributionGate' <> 'warn' then raise exception 'GATE 2 FAILED: %', res; end if;
  res := pg_temp.call_as(gq::text, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L,%L)', grp, 'Block cycle', '100.00', 'gate-block', 'block'));
  c_block := (res -> 'cycle' ->> 'cycleId')::uuid;
  if res -> 'cycle' ->> 'contributionGate' <> 'block' or (res ->> 'replayed')::boolean then
    raise exception 'GATE 3 FAILED: a treasurer could not create a block cycle: %', res;
  end if;
  res := pg_temp.call_as(gq::text, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L,%L)', grp, 'Block cycle', '100.00', 'gate-block', 'block'));
  if not (res ->> 'replayed')::boolean or (res -> 'cycle' ->> 'cycleId')::uuid <> c_block then
    raise exception 'GATE 4 FAILED: the same creation did not replay: %', res;
  end if;
  perform pg_temp.expect_error(gq::text, format('select public.create_draw_cycle_v1(%L,%L,%L,3,1000,now() - interval ''1 day'',%L,%L)', grp, 'Block cycle', '100.00', 'gate-block', 'off'), 'draw_idempotency_conflict', 'P0001');
  -- a row that predates the column (inserted without it) reads as off
  reset role;
  insert into public.draw_cycles (group_id, tenant_id, name, total_rounds, pot_amount, started_at)
  values (grp, tnt, 'Legacy cycle', 2, 400.00, now() - interval '1 day')
  returning id into c_legacy;
  if public.sened_draw_cycle_gate(c_legacy) <> 'off' or (select contribution_gate from public.draw_cycles where id = c_legacy) <> 'off' then
    raise exception 'GATE 5 FAILED: an existing cycle is not off';
  end if;

  -- =========================================================================
  -- GATE: block
  -- =========================================================================
  res := pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, null, %L)', c_block, 'gate-block-open-1'));
  if res -> 'contributionGate' ->> 'policy' <> 'block' or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 0
     or (res -> 'contributionGate' ->> 'overridden')::boolean then
    raise exception 'GATE 6 FAILED: opening round 1 (nothing before it) was gated: %', res;
  end if;
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, c_block, 1, gr, gp);
  perform pg_sleep(0.02);

  -- blocked: every active member has no payment for round 1
  detail := pg_temp.expect_error_detail(gp::text, format('select public.open_draw_v1(%L, 2, %L)', c_block, 'gate-block-open-2'), 'draw_contribution_gate_blocked', 'P0001');
  if jsonb_array_length(detail) <> 4
     or (select count(*) from jsonb_array_elements(detail) x where (x ->> 'round')::int = 1) <> 4
     or (select array_agg(x ->> 'memberId' order by x ->> 'memberId') from jsonb_array_elements(detail) x)
        is distinct from array[gp::text, gq::text, gr::text, gs::text] then
    raise exception 'GATE 7 FAILED: the block does not list who/which rounds: %', detail;
  end if;
  select count(*) into n from public.draw_sessions where cycle_id = c_block and round = 2;
  if n <> 0 then raise exception 'GATE 8 FAILED: a blocked open created a session'; end if;
  -- the treasurer role is blocked the same way
  perform pg_temp.expect_error_detail(gq::text, format('select public.open_draw_v1(%L, null, %L)', c_block, 'gate-block-open-2b'), 'draw_contribution_gate_blocked', 'P0001');
  -- an override needs a real reason
  perform pg_temp.expect_error(gp::text, format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2c', 'too short'), 'draw_override_reason_invalid', 'P0001');
  perform pg_temp.expect_error(gp::text, format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2c', repeat('x', 1001)), 'draw_override_reason_invalid', 'P0001');
  perform pg_temp.expect_error(gp::text, format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2c', '          '), 'draw_override_reason_invalid', 'P0001');
  -- an override needs the role: a plain member and an outsider are refused first
  perform pg_temp.expect_error(gr::text, format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2d', 'Members agreed to pay on Friday'), 'draw_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2d', 'Members agreed to pay on Friday'), 'draw_forbidden', '42501');
  perform pg_temp.expect_error('', format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2d', 'Members agreed to pay on Friday'), 'draw_forbidden', '28000');
  select count(*) into n from public.draw_contribution_gate_overrides where cycle_id = c_block;
  if n <> 0 then raise exception 'GATE 9 FAILED: a refused override was recorded'; end if;

  -- a valid override opens the draw and is recorded
  res := pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2e', '  Members agreed to pay on Friday  '));
  sess := (res -> 'session' ->> 'drawId')::uuid;
  if (res ->> 'replayed')::boolean or not (res -> 'contributionGate' ->> 'overridden')::boolean
     or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 4 then
    raise exception 'GATE 10 FAILED: the override did not open the draw: %', res;
  end if;
  select * into ov from public.draw_contribution_gate_overrides where cycle_id = c_block;
  if not found or ov.actor_id <> gp or ov.round <> 2 or ov.draw_id <> sess or ov.reason <> 'Members agreed to pay on Friday'
     or jsonb_array_length(ov.flagged) <> 4 or ov.created_at is null or ov.group_id <> grp then
    raise exception 'GATE 11 FAILED: the override record is wrong: %', row_to_json(ov);
  end if;
  -- replays and continuations do not record again
  perform pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, 2, %L, %L)', c_block, 'gate-block-open-2e', 'Members agreed to pay on Friday'));
  perform pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, null, %L, %L)', c_block, 'gate-block-open-2f', 'Another reason that is long enough'));
  select count(*) into n from public.draw_contribution_gate_overrides where cycle_id = c_block;
  if n <> 1 then raise exception 'GATE 12 FAILED: a replay or a continuation recorded another override (%)', n; end if;
  -- members read the audit trail
  res := pg_temp.call_as(gs::text, format('select public.get_draw_cycle_contributions_v1(%L)', c_block));
  if jsonb_array_length(res -> 'overrides') <> 1 or res -> 'overrides' -> 0 ->> 'reason' <> 'Members agreed to pay on Friday'
     or (res -> 'overrides' -> 0 ->> 'actorId')::uuid <> gp or (res -> 'overrides' -> 0 ->> 'round')::int <> 2
     or jsonb_array_length(res -> 'overrides' -> 0 -> 'flagged') <> 4 or res ->> 'contributionGate' <> 'block' then
    raise exception 'GATE 13 FAILED: the override is not readable by a member: %', res -> 'overrides';
  end if;

  -- once every round before it is met the gate does not ask for an override
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, c_block, 2, gp, gp);
  perform pg_sleep(0.02);
  for who in select unnest(array[gp, gq, gr, gs]) loop
    for r in 1 .. 2 loop
      perform pg_temp.fx_pay(gp, grp, 'gate-pay-' || who::text || '-' || r, '100.00', cash, income, who, c_block, r);
    end loop;
  end loop;
  res := pg_temp.call_as(gp::text, format('select public.get_draw_cycle_contributions_v1(%L)', c_block));
  if (res ->> 'flaggedCount')::int <> 0 then raise exception 'GATE 14 FAILED: payments did not clear the flags: %', res; end if;
  res := pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, 3, %L)', c_block, 'gate-block-open-3'));
  if (res -> 'contributionGate' ->> 'overridden')::boolean or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 0 then
    raise exception 'GATE 15 FAILED: an open with every earlier round met was blocked or overridden: %', res;
  end if;
  select count(*) into n from public.draw_contribution_gate_overrides where cycle_id = c_block;
  if n <> 1 then raise exception 'GATE 16 FAILED: an unnecessary override was recorded'; end if;

  -- an inactive member's flag does not hold up the cycle
  -- (checked on the warn cycle below)

  -- =========================================================================
  -- GATE: warn allows, and says what is flagged; a reason is not recorded as an override
  -- =========================================================================
  perform pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, null, %L)', c_warn, 'gate-warn-open-1'));
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, c_warn, 1, gs, gp);
  perform pg_sleep(0.02);
  res := pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, 2, %L)', c_warn, 'gate-warn-open-2'));
  if res -> 'contributionGate' ->> 'policy' <> 'warn' or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 4
     or (res -> 'contributionGate' ->> 'overridden')::boolean or (res ->> 'replayed')::boolean then
    raise exception 'GATE 17 FAILED: warn did not allow the open and list the flagged rounds: %', res;
  end if;
  select count(*) into n from public.draw_contribution_gate_overrides where cycle_id = c_warn;
  if n <> 0 then raise exception 'GATE 18 FAILED: warn recorded an override'; end if;
  -- an inactive member's flag is ignored by the gate (the grid still lists them, marked inactive)
  reset role;
  update public.ledger_group_memberships set status = 'inactive' where group_id = grp and user_id = gq;
  res := pg_temp.call_as(gp::text, format('select public.get_draw_cycle_contributions_v1(%L)', c_warn));
  if (select (m ->> 'active')::boolean from jsonb_array_elements(res -> 'members') m where m ->> 'memberId' = gq::text) is not false
     and (select count(*) from jsonb_array_elements(res -> 'members') m where m ->> 'memberId' = gq::text) <> 0 then
    raise exception 'GATE 19 FAILED: an inactive member is shown as active: %', res;
  end if;
  if public.sened_draw_cycle_gate_flags(c_warn, 2) @> jsonb_build_array(jsonb_build_object('memberId', gq, 'round', 1)) then
    raise exception 'GATE 19 FAILED: an inactive member''s flag reaches the gate';
  end if;
  update public.ledger_group_memberships set status = 'active' where group_id = grp and user_id = gq;

  -- =========================================================================
  -- GATE: off computes nothing
  -- =========================================================================
  perform pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, null, %L)', c_off, 'gate-off-open-1'));
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, c_off, 1, gr, gp);
  perform pg_sleep(0.02);
  res := pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, 2, %L)', c_off, 'gate-off-open-2'));
  if res -> 'contributionGate' ->> 'policy' <> 'off' or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 0 then
    raise exception 'GATE 20 FAILED: off computed or reported flags: %', res;
  end if;

  -- =========================================================================
  -- GATE: changing the policy (owner/treasurer, with a reason, audited)
  -- =========================================================================
  perform pg_temp.expect_error(gr::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'block', 'Switching it on for everyone'), 'draw_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'block', 'Switching it on for everyone'), 'draw_forbidden', '42501');
  perform pg_temp.expect_error('', format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'block', 'Switching it on for everyone'), 'draw_forbidden', '28000');
  perform pg_temp.expect_error(gp::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', gen_random_uuid(), 'block', 'Switching it on for everyone'), 'draw_forbidden', '42501');
  perform pg_temp.expect_error(gp::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'block', 'short'), 'draw_invalid_request', 'P0001');
  perform pg_temp.expect_error(gp::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'bogus', 'Switching it on for everyone'), 'draw_invalid_request', 'P0001');
  perform pg_temp.expect_error(gp::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,NULL,%L)', c_off, 'Switching it on for everyone'), 'draw_invalid_request', 'P0001');
  select count(*) into n from public.draw_cycle_gate_events where cycle_id = c_off;
  if n <> 0 then raise exception 'GATE 21 FAILED: a refused change was recorded'; end if;
  res := pg_temp.call_as(gp::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'block', 'Switching it on for everyone'));
  if (res ->> 'replayed')::boolean or res -> 'cycle' ->> 'contributionGate' <> 'block' then
    raise exception 'GATE 22 FAILED: the policy did not change: %', res;
  end if;
  select * into ev from public.draw_cycle_gate_events where cycle_id = c_off;
  if not found or ev.actor_id <> gp or ev.from_gate <> 'off' or ev.to_gate <> 'block' or ev.reason <> 'Switching it on for everyone' then
    raise exception 'GATE 23 FAILED: the policy event is wrong: %', row_to_json(ev);
  end if;
  res := pg_temp.call_as(gp::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'block', 'Switching it on for everyone'));
  select count(*) into n from public.draw_cycle_gate_events where cycle_id = c_off;
  if not (res ->> 'replayed')::boolean or n <> 1 then raise exception 'GATE 24 FAILED: an unchanged policy was recorded again (%)', n; end if;
  res := pg_temp.call_as(gr::text, format('select public.get_draw_cycle_contributions_v1(%L)', c_off));
  if res ->> 'contributionGate' <> 'block' or jsonb_array_length(res -> 'gateEvents') <> 1
     or res -> 'gateEvents' -> 0 ->> 'from' <> 'off' or res -> 'gateEvents' -> 0 ->> 'to' <> 'block'
     or (res -> 'gateEvents' -> 0 ->> 'actorId')::uuid <> gp then
    raise exception 'GATE 25 FAILED: a member cannot read the policy and its history: %', res;
  end if;
  -- the new policy bites on the next open
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, c_off, 2, gq, gp);
  perform pg_sleep(0.02);
  perform pg_temp.expect_error_detail(gp::text, format('select public.open_draw_v1(%L, 3, %L)', c_off, 'gate-off-open-3'), 'draw_contribution_gate_blocked', 'P0001');
  -- and the treasurer role can switch it back
  res := pg_temp.call_as(gq::text, format('select public.set_draw_cycle_contribution_gate_v1(%L,%L,%L)', c_off, 'off', 'The group decided to relax this'));
  if res -> 'cycle' ->> 'contributionGate' <> 'off' then raise exception 'GATE 26 FAILED: %', res; end if;
  select count(*) into n from public.draw_cycle_gate_events where cycle_id = c_off;
  if n <> 2 then raise exception 'GATE 27 FAILED: expected two policy events, got %', n; end if;
  perform pg_temp.call_as(gp::text, format('select public.open_draw_v1(%L, 3, %L)', c_off, 'gate-off-open-3b'));

  -- =========================================================================
  -- GATE: append-only, and clients cannot write the tables
  -- =========================================================================
  begin
    update public.draw_cycle_gate_events set reason = 'edited reason here' where cycle_id = c_off;
    raise exception 'GATE 28 FAILED: a policy event was updated';
  exception when others then
    if sqlerrm <> 'gate_history_immutable' then raise exception 'GATE 28 FAILED: %', sqlerrm; end if;
  end;
  begin
    delete from public.draw_cycle_gate_events where cycle_id = c_off;
    raise exception 'GATE 29 FAILED: a policy event was deleted';
  exception when others then
    if sqlerrm <> 'gate_history_immutable' then raise exception 'GATE 29 FAILED: %', sqlerrm; end if;
  end;
  begin
    update public.draw_contribution_gate_overrides set reason = 'edited reason here' where cycle_id = c_block;
    raise exception 'GATE 30 FAILED: an override was updated';
  exception when others then
    if sqlerrm <> 'gate_history_immutable' then raise exception 'GATE 30 FAILED: %', sqlerrm; end if;
  end;
  begin
    delete from public.draw_contribution_gate_overrides where cycle_id = c_block;
    raise exception 'GATE 31 FAILED: an override was deleted';
  exception when others then
    if sqlerrm <> 'gate_history_immutable' then raise exception 'GATE 31 FAILED: %', sqlerrm; end if;
  end;
  set constraints all immediate;
  begin
    truncate public.draw_cycle_gate_events;
    raise exception 'GATE 32 FAILED: the events table was truncated';
  exception when others then
    if sqlerrm <> 'gate_history_immutable' then raise exception 'GATE 32 FAILED: %', sqlerrm; end if;
  end;
  begin
    truncate public.draw_contribution_gate_overrides;
    raise exception 'GATE 33 FAILED: the overrides table was truncated';
  exception when others then
    if sqlerrm <> 'gate_history_immutable' then raise exception 'GATE 33 FAILED: %', sqlerrm; end if;
  end;
  -- a recorded override needs a reason of its own and flagged rounds, for ANY writer
  begin
    insert into public.draw_contribution_gate_overrides (cycle_id, group_id, tenant_id, round, draw_id, actor_id, reason, flagged)
    values (c_block, grp, tnt, 3, sess, gp, 'short', '[]'::jsonb);
    raise exception 'GATE 34 FAILED: an override with no reason and no rounds was accepted';
  exception when check_violation then null;
  end;
  perform set_config('request.jwt.claim.sub', gp::text, true);
  set local role authenticated;
  begin
    insert into public.draw_cycle_gate_events (cycle_id, group_id, tenant_id, from_gate, to_gate, actor_id, reason)
    values (c_off, grp, tnt, 'off', 'warn', gp, 'A direct insert by a client');
    raise exception 'GATE 35 FAILED: authenticated wrote a policy event directly';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.draw_contribution_gate_overrides (cycle_id, group_id, tenant_id, round, draw_id, actor_id, reason, flagged)
    values (c_block, grp, tnt, 3, sess, gp, 'A direct insert by a client', '[{"memberId":"x","round":1}]'::jsonb);
    raise exception 'GATE 36 FAILED: authenticated wrote an override directly';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.draw_cycles set contribution_gate = 'off' where id = c_block;
    raise exception 'GATE 37 FAILED: authenticated updated the policy column directly';
  exception when insufficient_privilege then null;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', gr::text, true);
  set local role authenticated;
  select count(*) into n from public.draw_cycle_gate_events;
  if n < 2 then reset role; raise exception 'GATE 38 FAILED: a member cannot read the policy events (%)', n; end if;
  select count(*) into n from public.draw_contribution_gate_overrides;
  reset role;
  if n < 1 then raise exception 'GATE 38 FAILED: a member cannot read the overrides (%)', n; end if;
  perform set_config('request.jwt.claim.sub', outsider, true);
  set local role authenticated;
  select count(*) into n from public.draw_cycle_gate_events;
  if n <> 0 or (select count(*) from public.draw_contribution_gate_overrides) <> 0 then
    reset role;
    raise exception 'GATE 39 FAILED: an outsider reads the gate tables';
  end if;
  reset role;

  -- =========================================================================
  -- GATE: signatures and grants (no stale overload, nothing reachable that must not be)
  -- =========================================================================
  if to_regprocedure('public.open_draw_v1(uuid, integer, text)') is not null
     or to_regprocedure('public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text)') is not null then
    raise exception 'GATE 40 FAILED: an old arity is still callable (PostgREST could not choose between overloads)';
  end if;
  if has_function_privilege('anon', 'public.get_draw_cycle_contributions_v1(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_draw_cycle_contribution_gate_v1(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.set_draw_cycle_contribution_gate_v1(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.open_draw_v1(uuid, integer, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_draw_cycle_member_rounds(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_draw_cycle_gate_flags(uuid, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_draw_cycle_gate(uuid)', 'EXECUTE') then
    raise exception 'GATE 41 FAILED: a function is executable by a role that must not have it';
  end if;
  if not has_function_privilege('authenticated', 'public.get_draw_cycle_contributions_v1(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.set_draw_cycle_contribution_gate_v1(uuid, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.open_draw_v1(uuid, integer, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.get_draw_cycle_collateral_v1(uuid)', 'EXECUTE') then
    raise exception 'GATE 42 FAILED: authenticated cannot execute a grid or gate RPC';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.draw_cycle_gate_events'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.draw_contribution_gate_overrides'::regclass) then
    raise exception 'GATE 43 FAILED: a gate table has no row level security';
  end if;
end;
$gate$;
-- ---------------------------------------------------------------------------
-- Post-win fill and the gate at commit (20261013100000_post_win_fill_and_commit_gate.sql)
--
-- FILL. A payment recorded after a member's win first fills the earliest unmet round after the
-- win that was DUE WHEN IT WAS RECORDED, else the earliest unmet round up to the win, else (the
-- prepayment) the next round once it opens. Checks the order on a four-round timeline with a
-- grid snapshot after every step and proves STABILITY: once a cell is met by an entry it stays
-- met by that entry whatever is opened, revealed or recorded later (only a deliberate edit - an
-- explicit attribution, a reversal - may re-sort). Explicit cycle+round attributions still win.
-- The winner's collateral output is compared with the verbatim pre-20261011 derivation and may
-- differ ONLY where a post-win entry now clears an earlier round instead of waiting for the next.
--
-- COMMIT-GATE. commit_draw_from_seals_v1 re-reads the effective policy and the flagged pairs:
-- off computes nothing, warn allows and reports, block refuses (draw_contribution_gate_blocked,
-- DETAIL = the pairs) unless the flagged set is covered by the override given at open (no pair
-- the override did not name) or an owner/treasurer gives a 10..1000 character reason, recorded
-- append-only with stage 'commit'. A flag appearing after the open, a policy switched to block
-- while sealing, an override at open that the set outgrew, role checks, an outsider, a refused
-- commit that leaves the seals valid, and no stale overload.
-- ---------------------------------------------------------------------------
-- The GATE checks above ended with `set constraints all immediate`; restore deferral for ledger writes.
set constraints all deferred;

insert into auth.users (id, email) values
  ('aaaaaaaa-3000-4000-8000-000000000001', 'fill-owner@example.test'),
  ('aaaaaaaa-3000-4000-8000-000000000002', 'fill-a@example.test'),
  ('aaaaaaaa-3000-4000-8000-000000000003', 'fill-b@example.test'),
  ('aaaaaaaa-3000-4000-8000-000000000004', 'fill-c@example.test'),
  ('aaaaaaaa-4000-4000-8000-000000000001', 'cg-owner@example.test'),
  ('aaaaaaaa-4000-4000-8000-000000000002', 'cg-treasurer@example.test'),
  ('aaaaaaaa-4000-4000-8000-000000000003', 'cg-one@example.test'),
  ('aaaaaaaa-4000-4000-8000-000000000004', 'cg-two@example.test')
on conflict (id) do nothing;

-- Every met cell of `p_prev` is still met by the same entry in `p_next`.
create or replace function pg_temp.fill_stable(p_prev jsonb, p_next jsonb, p_label text)
returns void
language plpgsql
as $$
declare
  c record;
begin
  for c in
    select m ->> 'memberId' as member_id, (cell ->> 'round')::int as round_no, cell ->> 'entryId' as entry_id
    from jsonb_array_elements(p_prev -> 'members') m, jsonb_array_elements(m -> 'cells') cell
    where cell ->> 'status' = 'met'
  loop
    if (select x ->> 'entryId' from jsonb_array_elements(p_next -> 'members') mm, jsonb_array_elements(mm -> 'cells') x
        where mm ->> 'memberId' = c.member_id and (x ->> 'round')::int = c.round_no) is distinct from c.entry_id then
      raise exception '% FAILED: member % round % was met by entry % and no longer is', p_label, c.member_id, c.round_no, c.entry_id;
    end if;
  end loop;
end;
$$;

-- For every winner, the rounds on which the collateral view differs from the pre-20261011 derivation.
create or replace function pg_temp.fill_owed_diff(p_caller text, p_cycle uuid)
returns jsonb
language plpgsql
as $$
declare
  res jsonb := pg_temp.call_as(p_caller, format('select public.get_draw_cycle_collateral_v1(%L)', p_cycle));
  w jsonb;
  legacy jsonb;
  diffs jsonb := '{}'::jsonb;
  rounds jsonb;
  i integer;
begin
  for w in select x from jsonb_array_elements(res -> 'winners') x loop
    legacy := pg_temp.legacy_owed(p_cycle, (w ->> 'memberId')::uuid, (w ->> 'round')::int,
                                  (select total_rounds from public.draw_cycles where id = p_cycle));
    rounds := '[]'::jsonb;
    for i in 0 .. jsonb_array_length(legacy) - 1 loop
      if legacy -> i is distinct from (w -> 'owed') -> i then
        rounds := rounds || to_jsonb(((legacy -> i) ->> 'round')::int);
      end if;
    end loop;
    if jsonb_array_length(rounds) > 0 then
      diffs := diffs || jsonb_build_object(w ->> 'memberId', rounds);
    end if;
  end loop;
  return diffs;
end;
$$;

do $fill$
declare
  fo constant uuid := 'aaaaaaaa-3000-4000-8000-000000000001';
  fa constant uuid := 'aaaaaaaa-3000-4000-8000-000000000002';
  fb constant uuid := 'aaaaaaaa-3000-4000-8000-000000000003';
  fc constant uuid := 'aaaaaaaa-3000-4000-8000-000000000004';
  grp uuid; tnt uuid; cash uuid; income uuid; k uuid;
  s0 jsonb; s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb; s5 jsonb; s6 jsonb; s7 jsonb; s8 jsonb; s9 jsonb; s10 jsonb;
  q1 uuid; p1 uuid; p2 uuid; p3 uuid; y1 uuid; y2 uuid; y3 uuid; z1 uuid; z2 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid;
  w jsonb; cell jsonb; cres jsonb;
begin
  perform set_config('request.jwt.claim.sub', fo::text, true);
  grp := (public.sened_ledger_provision_group_v1('Fill equb') ->> 'groupId')::uuid;
  select tenant_id into tnt from public.ledger_groups where id = grp;
  select id into cash from public.ledger_accounts where group_id = grp and code = 'POT_CASH';
  select id into income from public.ledger_accounts where group_id = grp and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (grp, tnt, fa, 'member', 'active'), (grp, tnt, fb, 'member', 'active'), (grp, tnt, fc, 'member', 'active');
  k := (pg_temp.call_as(fo::text, format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 4, 1000, now() - interval ''1 day'', %L)', grp, 'Fill cycle', '100.00', 'fill-k')) -> 'cycle' ->> 'cycleId')::uuid;

  -- Round 1 opens; nobody has paid. A wins it (w = 1) and has not paid for round 1 either.
  perform pg_temp.call_as(fo::text, format('select public.open_draw_v1(%L, null, %L)', k, 'fill-open-1'));
  s0 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, k, 1, fa, fo);
  perform pg_sleep(0.02);

  -- FILL 1. A (the winner) pays after the win while NO round after the win is open: the payment
  -- clears A's missed round 1 instead of waiting. C (not a winner) pays: round 1, as ever.
  p1 := pg_temp.fx_pay(fo, grp, 'fill-p1', '100.00', cash, income, fa);
  q1 := pg_temp.fx_pay(fo, grp, 'fill-q1', '100.00', cash, income, fc);
  s1 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s1, fa) <> 'met,not_due,not_due,not_due' or (pg_temp.grid_cell_json(s1, fa, 1) ->> 'entryId')::uuid <> p1
     or pg_temp.grid_row(s1, fc) <> 'met,not_due,not_due,not_due' or (pg_temp.grid_cell_json(s1, fc, 1) ->> 'entryId')::uuid <> q1
     or pg_temp.grid_row(s1, fb) <> 'flagged,not_due,not_due,not_due' then
    raise exception 'FILL 1 FAILED: a post-win payment with nothing after the win due did not clear the missed round 1: %', s1;
  end if;
  perform pg_temp.fill_stable(s0, s1, 'FILL 1 stability');
  if pg_temp.fill_owed_diff(fo::text, k) <> '{}'::jsonb then
    raise exception 'FILL 1 FAILED: collateral differs from the old derivation before round 2 is open: %', pg_temp.fill_owed_diff(fo::text, k);
  end if;

  -- FILL 2 (STABILITY). Round 2 opens. The payment recorded before it does NOT move to round 2:
  -- round 1 stays met by p1 and round 2 is flagged. The old derivation would have moved p1 to round 2
  -- when it opened, so this is exactly where the collateral view legitimately differs.
  perform pg_sleep(0.02);
  perform pg_temp.call_as(fo::text, format('select public.open_draw_v1(%L, 2, %L)', k, 'fill-open-2'));
  s2 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s2, fa) <> 'met,flagged,not_due,not_due' or (pg_temp.grid_cell_json(s2, fa, 1) ->> 'entryId')::uuid <> p1
     or pg_temp.grid_row(s2, fc) <> 'met,flagged,not_due,not_due' or (pg_temp.grid_cell_json(s2, fc, 1) ->> 'entryId')::uuid <> q1 then
    raise exception 'FILL 2 FAILED: opening round 2 moved a payment that had already cleared round 1: %', s2;
  end if;
  perform pg_temp.fill_stable(s1, s2, 'FILL 2 stability');
  if pg_temp.fill_owed_diff(fo::text, k) <> jsonb_build_object(fa::text, '[2]'::jsonb) then
    raise exception 'FILL 2 FAILED: collateral must differ from the old derivation only for the winner''s round 2: %', pg_temp.fill_owed_diff(fo::text, k);
  end if;

  -- FILL 3. A pays again with round 2 open and unmet: post-win obligations first, so round 2.
  perform pg_sleep(0.02);
  p2 := pg_temp.fx_pay(fo, grp, 'fill-p2', '100.00', cash, income, fa);
  s3 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s3, fa) <> 'met,met,not_due,not_due' or (pg_temp.grid_cell_json(s3, fa, 2) ->> 'entryId')::uuid <> p2
     or (pg_temp.grid_cell_json(s3, fa, 1) ->> 'entryId')::uuid <> p1 then
    raise exception 'FILL 3 FAILED: a post-win payment with a post-win round due did not fill it: %', s3;
  end if;
  perform pg_temp.fill_stable(s2, s3, 'FILL 3 stability');
  -- the old derivation paid round 2 with p1 (the older entry); the status is the same, the entry differs
  if pg_temp.fill_owed_diff(fo::text, k) <> jsonb_build_object(fa::text, '[2]'::jsonb) then
    raise exception 'FILL 3 FAILED: unexpected collateral difference: %', pg_temp.fill_owed_diff(fo::text, k);
  end if;

  -- FILL 4. B wins round 2 with rounds 1 and 2 unpaid. B pays y1 before round 3 opens: it clears
  -- the earliest missed round (1); then round 3 opens and y1 stays put.
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(grp, tnt, k, 2, fb, fo);
  perform pg_sleep(0.02);
  y1 := pg_temp.fx_pay(fo, grp, 'fill-y1', '100.00', cash, income, fb);
  s4 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s4, fb) <> 'met,flagged,not_due,not_due' or (pg_temp.grid_cell_json(s4, fb, 1) ->> 'entryId')::uuid <> y1 then
    raise exception 'FILL 4 FAILED: B''s first post-win payment did not clear round 1: %', s4;
  end if;
  perform pg_temp.fill_stable(s3, s4, 'FILL 4 stability');
  perform pg_sleep(0.02);
  perform pg_temp.call_as(fo::text, format('select public.open_draw_v1(%L, 3, %L)', k, 'fill-open-3'));
  s5 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s5, fb) <> 'met,flagged,flagged,not_due' or (pg_temp.grid_cell_json(s5, fb, 1) ->> 'entryId')::uuid <> y1 then
    raise exception 'FILL 4 FAILED: opening round 3 moved B''s payment: %', s5;
  end if;
  perform pg_temp.fill_stable(s4, s5, 'FILL 4 stability after open');
  -- the old derivation paid B's round 3 with y1: the one place the output differs for B
  if (pg_temp.fill_owed_diff(fo::text, k) -> fb::text) <> '[3]'::jsonb then
    raise exception 'FILL 4 FAILED: B''s round 3 should differ from the old derivation: %', pg_temp.fill_owed_diff(fo::text, k);
  end if;

  -- FILL 5 (FILL ORDER). With round 3 open and unmet, B's next payment fills round 3 (post-win first)
  -- although round 2 is missed too; the one after that, with nothing after the win due, clears round 2.
  perform pg_sleep(0.02);
  y2 := pg_temp.fx_pay(fo, grp, 'fill-y2', '100.00', cash, income, fb);
  s6 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s6, fb) <> 'met,flagged,met,not_due' or (pg_temp.grid_cell_json(s6, fb, 3) ->> 'entryId')::uuid <> y2 then
    raise exception 'FILL 5 FAILED: a post-win round that is due did not take priority over an older missed round: %', s6;
  end if;
  perform pg_temp.fill_stable(s5, s6, 'FILL 5 stability');
  perform pg_sleep(0.02);
  y3 := pg_temp.fx_pay(fo, grp, 'fill-y3', '100.00', cash, income, fb);
  s7 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s7, fb) <> 'met,met,met,not_due' or (pg_temp.grid_cell_json(s7, fb, 2) ->> 'entryId')::uuid <> y3
     or (pg_temp.grid_cell_json(s7, fb, 3) ->> 'entryId')::uuid <> y2 then
    raise exception 'FILL 5 FAILED: with every post-win round met the payment did not clear the earliest missed round: %', s7;
  end if;
  perform pg_temp.fill_stable(s6, s7, 'FILL 5 stability (second)');

  -- FILL 6. Round 3 is revealed (C wins) and round 4 opens. Nothing already placed moves, and a payment
  -- recorded before round 3's reveal still cannot pay round 4 (unchanged rule).
  perform pg_sleep(0.02);
  p3 := pg_temp.fx_pay(fo, grp, 'fill-p3', '100.00', cash, income, fa);   -- A, before round 3 is revealed
  reset role;
  perform pg_sleep(0.02);
  perform pg_temp.fx_reveal(grp, tnt, k, 3, fc, fo);
  perform pg_sleep(0.02);
  perform pg_temp.call_as(fo::text, format('select public.open_draw_v1(%L, 4, %L)', k, 'fill-open-4'));
  s8 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  perform pg_temp.fill_stable(s7, s8, 'FILL 6 stability');
  -- p3 (recorded after A's win, with round 3 open and unmet then) went to round 3; round 4 is flagged
  if pg_temp.grid_row(s8, fa) <> 'met,met,met,flagged' or (pg_temp.grid_cell_json(s8, fa, 3) ->> 'entryId')::uuid <> p3 then
    raise exception 'FILL 6 FAILED: A''s row after round 4 opened is wrong: %', s8;
  end if;

  -- FILL 7. C wins round 3 (their own win round and round 2 unpaid; round 1 met pre-win by q1). A post-win
  -- payment with round 4 open fills round 4; the next one has nothing after the win due and clears round 2.
  z1 := pg_temp.fx_pay(fo, grp, 'fill-z1', '100.00', cash, income, fc);
  s9 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s9, fc) <> 'met,flagged,flagged,met' or (pg_temp.grid_cell_json(s9, fc, 4) ->> 'entryId')::uuid <> z1 then
    raise exception 'FILL 7 FAILED: C''s post-win payment did not fill the open round 4: %', s9;
  end if;
  perform pg_temp.fill_stable(s8, s9, 'FILL 7 stability');
  z2 := pg_temp.fx_pay(fo, grp, 'fill-z2', '100.00', cash, income, fc);
  s10 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s10, fc) <> 'met,met,flagged,met' or (pg_temp.grid_cell_json(s10, fc, 2) ->> 'entryId')::uuid <> z2 then
    raise exception 'FILL 7 FAILED: with round 4 met the next post-win payment did not clear the earliest missed round 2: %', s10;
  end if;
  perform pg_temp.fill_stable(s9, s10, 'FILL 7 stability (second)');

  -- FILL 8 (EXPLICIT WINS). O (never won) has paid nothing. An explicit payment for round 2 claims round 2,
  -- and the by-order payment that follows goes to the earliest unmet round (1), not to round 2.
  e2 := pg_temp.fx_pay(fo, grp, 'fill-e2', '100.00', cash, income, fo, k, 2);
  e3 := pg_temp.fx_pay(fo, grp, 'fill-e3', '100.00', cash, income, fo);
  s9 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s9, fo) <> 'met,met,flagged,flagged'
     or (pg_temp.grid_cell_json(s9, fo, 2) ->> 'entryId')::uuid <> e2 or (pg_temp.grid_cell_json(s9, fo, 1) ->> 'entryId')::uuid <> e3 then
    raise exception 'FILL 8 FAILED: an explicit cycle+round attribution did not keep its round, or the by-order payment did not take the earliest other one: %', s9;
  end if;
  -- and for a WINNER: an explicit payment for B's round 4 (not yet reached), then one more payment that has
  -- nothing to pay (one entry pays one round, no carry)
  e4 := pg_temp.fx_pay(fo, grp, 'fill-e4', '100.00', cash, income, fb, k, 4);
  s9 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s9, fb) <> 'met,met,met,met' or (pg_temp.grid_cell_json(s9, fb, 4) ->> 'entryId')::uuid <> e4 then
    raise exception 'FILL 8 FAILED: an explicit attribution did not meet a winner''s round 4: %', s9;
  end if;
  e5 := pg_temp.fx_pay(fo, grp, 'fill-e5', '100.00', cash, income, fb);
  s10 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if pg_temp.grid_row(s10, fb) <> 'met,met,met,met' or exists (
       select 1 from jsonb_array_elements(s10 -> 'members') m, jsonb_array_elements(m -> 'cells') c
       where c ->> 'entryId' = e5::text) then
    raise exception 'FILL 8 FAILED: an extra payment (one entry pays one round, no carry) was assigned to a round: %', s10;
  end if;

  -- FILL 9. A reversal is a deliberate edit: reversing p1 makes A's round 1 not met by p1 any more.
  -- Cells that were met by OTHER entries keep them.
  perform pg_temp.fx_reverse(fo, grp, 'fill-p1-fix', p1, '100.00', cash, income);
  s9 := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_contributions_v1(%L)', k));
  if (pg_temp.grid_cell_json(s9, fa, 2) ->> 'entryId')::uuid <> p2 then
    raise exception 'FILL 9 FAILED: reversing one payment moved another that was not affected: %', s9;
  end if;
  if pg_temp.grid_cell(s9, fa, 1) = 'met' and (pg_temp.grid_cell_json(s9, fa, 1) ->> 'entryId')::uuid = p1 then
    raise exception 'FILL 9 FAILED: a reversed payment still counts: %', s9;
  end if;

  -- The collateral view stays consistent with the grid for every winner.
  cres := pg_temp.call_as(fo::text, format('select public.get_draw_cycle_collateral_v1(%L)', k));
  for w in select x from jsonb_array_elements(cres -> 'winners') x loop
    for cell in select y from jsonb_array_elements(w -> 'owed') y loop
      if (cell ->> 'status') <> pg_temp.grid_cell(s9, (w ->> 'memberId')::uuid, (cell ->> 'round')::int)
         or (cell -> 'entryId') is distinct from (pg_temp.grid_cell_json(s9, (w ->> 'memberId')::uuid, (cell ->> 'round')::int) -> 'entryId') then
        raise exception 'FILL 10 FAILED: the collateral view and the grid disagree on % round %', w ->> 'memberId', cell ->> 'round';
      end if;
    end loop;
  end loop;
end;
$fill$;

-- Seal as the member, build the commit call, and a round-2 draw ready to commit.
create or replace function pg_temp.cg_seal(p_draw uuid, p_users uuid[])
returns void
language plpgsql
as $$
declare
  u uuid;
begin
  foreach u in array p_users loop
    perform pg_temp.call_as(u::text, format('select public.submit_draw_seal_v1(%L, %L)', p_draw,
      public.sened_draw_member_seal_hash(p_draw, u, 'cg-nonce-' || u::text || '-0123456789')));
  end loop;
end;
$$;

create or replace function pg_temp.cg_commit_sql(p_draw uuid, p_key text, p_override text default null)
returns text
language plpgsql
as $$
declare
  sess public.draw_sessions;
  cyc public.draw_cycles;
  participants jsonb;
  sealed_set jsonb;
  digest text;
begin
  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw;
  select c.* into cyc from public.draw_cycles c where c.id = sess.cycle_id;
  participants := (
    select jsonb_agg(jsonb_build_object(
      'memberId', e.member_id, 'displayName', 'Member ' || left(e.member_id::text, 8),
      'contributionAmount', cyc.contribution_amount::text,
      'ticket', public.sened_draw_ticket(sess.group_id, sess.cycle_id, e.member_id)) order by e.member_id::text)
    from public.sened_draw_eligible_members(sess.group_id, sess.cycle_id, sess.round) as e(member_id));
  sealed_set := (
    select coalesce(jsonb_agg(jsonb_build_object('memberId', se.member_id, 'sealed', se.sealed)
                              order by se.member_id::text collate "C"), '[]'::jsonb)
    from public.draw_seals se
    where se.draw_id = p_draw
      and exists (select 1 from public.sened_draw_eligible_members(sess.group_id, sess.cycle_id, sess.round) as e(member_id)
                  where e.member_id = se.member_id));
  digest := public.sened_draw_member_set_digest(p_draw, sealed_set);
  return format(
    'select public.commit_draw_from_seals_v1(%L, %L, %L, %L, %L, %L::jsonb, %L, null, %L, %L)',
    p_draw, encode(sha256(convert_to('commitment-' || p_key, 'utf8')), 'hex'), 'commit-nonce-0123456789abcdef',
    repeat('b', 64), digest, participants, p_key, 'v3', p_override);
end;
$$;

-- A cycle at round 2 with a draw ready to commit: round 1 opened, revealed (the winner wins it),
-- `p_payers` pay round 1 explicitly, round 2 opened (with `p_open_override` if the gate asks), and
-- `p_sealers` sealed. Returns {cycle, draw, entries: {member: entry}}.
create or replace function pg_temp.cg_prepare(
  p_owner uuid, p_winner uuid, p_group uuid, p_tenant uuid, p_cash uuid, p_income uuid,
  p_name text, p_gate text, p_payers uuid[], p_open_override text, p_sealers uuid[]
)
returns jsonb
language plpgsql
as $$
declare
  cyc uuid;
  draw uuid;
  payer uuid;
  entries jsonb := '{}'::jsonb;
  ent uuid;
begin
  cyc := (pg_temp.call_as(p_owner::text, format(
    'select public.create_draw_cycle_v1(%L, %L, %L, 3, 1000, now() - interval ''1 day'', %L, %L)',
    p_group, p_name, '100.00', 'key-' || p_name, p_gate)) -> 'cycle' ->> 'cycleId')::uuid;
  perform pg_temp.call_as(p_owner::text, format('select public.open_draw_v1(%L, null, %L)', cyc, 'open1-' || p_name));
  perform pg_sleep(0.02);
  reset role;
  perform pg_temp.fx_reveal(p_group, p_tenant, cyc, 1, p_winner, p_owner);
  perform pg_sleep(0.02);
  foreach payer in array p_payers loop
    ent := pg_temp.fx_pay(p_owner, p_group, 'pay-' || p_name || '-' || payer::text, '100.00', p_cash, p_income, payer, cyc, 1);
    entries := entries || jsonb_build_object(payer::text, ent);
  end loop;
  perform pg_sleep(0.02);
  draw := (pg_temp.call_as(p_owner::text, case when p_open_override is null
      then format('select public.open_draw_v1(%L, 2, %L)', cyc, 'open2-' || p_name)
      else format('select public.open_draw_v1(%L, 2, %L, %L)', cyc, 'open2-' || p_name, p_open_override) end)
    -> 'session' ->> 'drawId')::uuid;
  perform pg_temp.cg_seal(draw, p_sealers);
  return jsonb_build_object('cycle', cyc, 'draw', draw, 'entries', entries);
end;
$$;

do $commitgate$
declare
  co constant uuid := 'aaaaaaaa-4000-4000-8000-000000000001'; -- owner
  ct constant uuid := 'aaaaaaaa-4000-4000-8000-000000000002'; -- treasurer role
  c1 constant uuid := 'aaaaaaaa-4000-4000-8000-000000000003'; -- plain member; wins round 1
  c2 constant uuid := 'aaaaaaaa-4000-4000-8000-000000000004'; -- plain member
  outsider constant text := '44444444-4444-4444-8444-444444444444';
  grp uuid; tnt uuid; cash uuid; income uuid;
  p jsonb; cyc uuid; draw uuid;
  res jsonb; detail jsonb;
  seals_before bigint;
  ov record;
  reason constant text := 'Members agreed to pay on Friday';
begin
  perform set_config('request.jwt.claim.sub', co::text, true);
  grp := (public.sened_ledger_provision_group_v1('Commit gate equb') ->> 'groupId')::uuid;
  select tenant_id into tnt from public.ledger_groups where id = grp;
  select id into cash from public.ledger_accounts where group_id = grp and code = 'POT_CASH';
  select id into income from public.ledger_accounts where group_id = grp and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (grp, tnt, ct, 'treasurer', 'active'), (grp, tnt, c1, 'member', 'active'), (grp, tnt, c2, 'member', 'active');

  -- =========================================================================
  -- COMMIT-GATE 1: a flag that appears AFTER the draw was opened (block)
  -- =========================================================================
  -- Everyone paid round 1, so round 2 opens with nothing flagged and no override; then C2's payment is reversed.
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'late-flag', 'block', array[co, ct, c1, c2], null, array[ct, c2]);
  cyc := (p ->> 'cycle')::uuid; draw := (p ->> 'draw')::uuid;
  if (select count(*) from public.draw_contribution_gate_overrides where cycle_id = cyc) <> 0 then
    raise exception 'COMMIT-GATE 1 FAILED: an override was recorded at open with nothing flagged';
  end if;
  perform pg_temp.fx_reverse(co, grp, 'late-flag-fix', (p -> 'entries' ->> c2::text)::uuid, '100.00', cash, income);
  select count(*) into seals_before from public.draw_seals where draw_id = draw;

  detail := pg_temp.expect_error_detail(co::text, pg_temp.cg_commit_sql(draw, 'ck-late'), 'draw_contribution_gate_blocked', 'P0001');
  if detail <> jsonb_build_array(jsonb_build_object('memberId', c2, 'round', 1)) then
    raise exception 'COMMIT-GATE 1 FAILED: the refusal does not name who is flagged for which round: %', detail;
  end if;
  -- the treasurer role is refused the same way; nothing was written; the seals are still valid
  perform pg_temp.expect_error_detail(ct::text, pg_temp.cg_commit_sql(draw, 'ck-late'), 'draw_contribution_gate_blocked', 'P0001');
  if exists (select 1 from public.draw_commitments where draw_id = draw)
     or (select count(*) from public.draw_seals where draw_id = draw) <> seals_before
     or (select count(*) from public.draw_contribution_gate_overrides where cycle_id = cyc) <> 0 then
    raise exception 'COMMIT-GATE 2 FAILED: a refused commit wrote something or touched the seals';
  end if;
  -- an override needs the role: a plain member, an outsider and an anonymous caller are refused FIRST
  perform pg_temp.expect_error(c1::text, pg_temp.cg_commit_sql(draw, 'ck-late', reason), 'draw_forbidden', '42501');
  perform pg_temp.expect_error(c2::text, pg_temp.cg_commit_sql(draw, 'ck-late', reason), 'draw_forbidden', '42501');
  perform pg_temp.expect_error(outsider, pg_temp.cg_commit_sql(draw, 'ck-late', reason), 'draw_forbidden', '42501');
  perform pg_temp.expect_error('', pg_temp.cg_commit_sql(draw, 'ck-late', reason), 'draw_forbidden', '28000');
  -- and the reason must be a real one
  perform pg_temp.expect_error(co::text, pg_temp.cg_commit_sql(draw, 'ck-late', 'too short'), 'draw_override_reason_invalid', 'P0001');
  perform pg_temp.expect_error(co::text, pg_temp.cg_commit_sql(draw, 'ck-late', '          '), 'draw_override_reason_invalid', 'P0001');
  perform pg_temp.expect_error(co::text, pg_temp.cg_commit_sql(draw, 'ck-late', repeat('x', 1001)), 'draw_override_reason_invalid', 'P0001');
  if exists (select 1 from public.draw_commitments where draw_id = draw)
     or (select count(*) from public.draw_contribution_gate_overrides where cycle_id = cyc) <> 0 then
    raise exception 'COMMIT-GATE 3 FAILED: a refused override committed or was recorded';
  end if;
  -- the treasurer overrides with a reason: committed, and recorded with the stage
  res := pg_temp.call_as(ct::text, pg_temp.cg_commit_sql(draw, 'ck-late', '  ' || reason || '  '));
  if (res ->> 'replayed')::boolean or res -> 'contributionGate' ->> 'policy' <> 'block'
     or not (res -> 'contributionGate' ->> 'overridden')::boolean or (res -> 'contributionGate' ->> 'carriedOver')::boolean
     or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 1 then
    raise exception 'COMMIT-GATE 4 FAILED: the override did not commit the draw: %', res;
  end if;
  select * into ov from public.draw_contribution_gate_overrides where cycle_id = cyc;
  if not found or ov.stage <> 'commit' or ov.actor_id <> ct or ov.round <> 2 or ov.draw_id <> draw or ov.reason <> reason
     or ov.flagged <> jsonb_build_array(jsonb_build_object('memberId', c2, 'round', 1)) or ov.group_id <> grp then
    raise exception 'COMMIT-GATE 5 FAILED: the commit override record is wrong: %', row_to_json(ov);
  end if;
  if not exists (select 1 from public.draw_commitments where draw_id = draw) then
    raise exception 'COMMIT-GATE 5 FAILED: the commitment was not written';
  end if;
  -- a replay (same key) commits nothing again and records nothing again, whatever reason it carries
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-late', 'A different reason entirely'));
  if not (res ->> 'replayed')::boolean or (select count(*) from public.draw_contribution_gate_overrides where cycle_id = cyc) <> 1 then
    raise exception 'COMMIT-GATE 6 FAILED: a replay recorded another override or did not replay: %', res;
  end if;
  -- members read it, with its stage
  res := pg_temp.call_as(c2::text, format('select public.get_draw_cycle_contributions_v1(%L)', cyc));
  if jsonb_array_length(res -> 'overrides') <> 1 or res -> 'overrides' -> 0 ->> 'stage' <> 'commit'
     or res -> 'overrides' -> 0 ->> 'reason' <> reason or (res -> 'overrides' -> 0 ->> 'drawId')::uuid <> draw then
    raise exception 'COMMIT-GATE 7 FAILED: a member cannot read the commit override with its stage: %', res -> 'overrides';
  end if;
  -- one override per draw per stage, and only the two stages
  begin
    insert into public.draw_contribution_gate_overrides (cycle_id, group_id, tenant_id, round, draw_id, actor_id, reason, flagged, stage)
    values (cyc, grp, tnt, 2, draw, ct, 'A second commit override', '[{"memberId":"x","round":1}]'::jsonb, 'commit');
    raise exception 'COMMIT-GATE 8 FAILED: a second commit override for one draw was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.draw_contribution_gate_overrides (cycle_id, group_id, tenant_id, round, draw_id, actor_id, reason, flagged, stage)
    values (cyc, grp, tnt, 2, draw, ct, 'An unknown stage here', '[{"memberId":"x","round":1}]'::jsonb, 'later');
    raise exception 'COMMIT-GATE 8 FAILED: an unknown stage was accepted';
  exception when check_violation then null;
  end;

  -- =========================================================================
  -- COMMIT-GATE 2: an override given at OPEN is reused when the flagged set did not grow
  -- =========================================================================
  -- Only the owner has paid round 1: the treasurer, C1 and C2 are flagged at open, and the override names them.
  -- same set, with a (not needed) valid reason supplied: allowed, carried over, nothing new recorded
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'reuse-same', 'block', array[co], reason, array[ct, c2]);
  cyc := (p ->> 'cycle')::uuid; draw := (p ->> 'draw')::uuid;
  select * into ov from public.draw_contribution_gate_overrides where draw_id = draw;
  if ov.stage <> 'open' or jsonb_array_length(ov.flagged) <> 3 then
    raise exception 'COMMIT-GATE 9 FAILED: the open override is wrong: %', row_to_json(ov);
  end if;
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-same', 'Not needed but a real reason'));
  if res -> 'contributionGate' ->> 'policy' <> 'block' or (res -> 'contributionGate' ->> 'overridden')::boolean
     or not (res -> 'contributionGate' ->> 'carriedOver')::boolean or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 3 then
    raise exception 'COMMIT-GATE 10 FAILED: the open override was not reused for an unchanged set: %', res;
  end if;
  if (select count(*) from public.draw_contribution_gate_overrides where draw_id = draw) <> 1 then
    raise exception 'COMMIT-GATE 10 FAILED: reusing the open override recorded another';
  end if;

  -- a SMALLER set (C1 paid since): reused, no reason needed
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'reuse-smaller', 'block', array[co], reason, array[ct, c2]);
  cyc := (p ->> 'cycle')::uuid; draw := (p ->> 'draw')::uuid;
  perform pg_temp.fx_pay(co, grp, 'pay-reuse-smaller-late', '100.00', cash, income, c1, cyc, 1);
  res := pg_temp.call_as(ct::text, pg_temp.cg_commit_sql(draw, 'ck-smaller'));
  if not (res -> 'contributionGate' ->> 'carriedOver')::boolean or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 2 then
    raise exception 'COMMIT-GATE 11 FAILED: a smaller flagged set needed a new override: %', res;
  end if;

  -- the set GREW by a pair the override did not name (the owner's payment reversed): refused; an override is recorded
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'reuse-grew', 'block', array[co], reason, array[ct, c2]);
  cyc := (p ->> 'cycle')::uuid; draw := (p ->> 'draw')::uuid;
  perform pg_temp.fx_reverse(co, grp, 'reuse-grew-fix', (p -> 'entries' ->> co::text)::uuid, '100.00', cash, income);
  detail := pg_temp.expect_error_detail(co::text, pg_temp.cg_commit_sql(draw, 'ck-grew'), 'draw_contribution_gate_blocked', 'P0001');
  if jsonb_array_length(detail) <> 4 then
    raise exception 'COMMIT-GATE 12 FAILED: the refusal after the set grew should list every flagged pair: %', detail;
  end if;
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-grew', 'A fresh reason for the new flag'));
  if not (res -> 'contributionGate' ->> 'overridden')::boolean or (res -> 'contributionGate' ->> 'carriedOver')::boolean then
    raise exception 'COMMIT-GATE 13 FAILED: %', res;
  end if;
  if (select array_agg(stage order by stage) from public.draw_contribution_gate_overrides where draw_id = draw) <> array['commit', 'open']
     or (select jsonb_array_length(flagged) from public.draw_contribution_gate_overrides where draw_id = draw and stage = 'commit') <> 4
     or (select jsonb_array_length(flagged) from public.draw_contribution_gate_overrides where draw_id = draw and stage = 'open') <> 3 then
    raise exception 'COMMIT-GATE 13 FAILED: both the open and the commit override should be on record';
  end if;

  -- the set has the SAME SIZE but a different pair (one paid, another's payment reversed): refused
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'reuse-swap', 'block', array[co], reason, array[ct, c2]);
  cyc := (p ->> 'cycle')::uuid; draw := (p ->> 'draw')::uuid;
  perform pg_temp.fx_pay(co, grp, 'pay-reuse-swap-late', '100.00', cash, income, c1, cyc, 1);
  perform pg_temp.fx_reverse(co, grp, 'reuse-swap-fix', (p -> 'entries' ->> co::text)::uuid, '100.00', cash, income);
  if jsonb_array_length(public.sened_draw_cycle_gate_flags(cyc, 2)) <> 3 then
    raise exception 'COMMIT-GATE 14 FAILED: the swap fixture is wrong: %', public.sened_draw_cycle_gate_flags(cyc, 2);
  end if;
  perform pg_temp.expect_error_detail(co::text, pg_temp.cg_commit_sql(draw, 'ck-swap'), 'draw_contribution_gate_blocked', 'P0001');
  -- (the helper agrees with the function on both)
  if public.sened_draw_flags_covered(public.sened_draw_cycle_gate_flags(cyc, 2), public.sened_draw_open_override_flags(draw)) then
    raise exception 'COMMIT-GATE 14 FAILED: a swapped pair was treated as covered';
  end if;

  -- =========================================================================
  -- COMMIT-GATE 3: warn reports, off computes nothing, a switch to block while sealing is caught
  -- =========================================================================
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'warn-commit', 'warn', array[]::uuid[], null, array[ct, c2]);
  draw := (p ->> 'draw')::uuid; cyc := (p ->> 'cycle')::uuid;
  perform pg_temp.expect_error(co::text, pg_temp.cg_commit_sql(draw, 'ck-warn', 'short'), 'draw_override_reason_invalid', 'P0001');
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-warn'));
  if res -> 'contributionGate' ->> 'policy' <> 'warn' or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 4
     or (res -> 'contributionGate' ->> 'overridden')::boolean then
    raise exception 'COMMIT-GATE 15 FAILED: warn did not allow the commit and report the flagged pairs: %', res;
  end if;
  if (select count(*) from public.draw_contribution_gate_overrides where cycle_id = cyc) <> 0 then
    raise exception 'COMMIT-GATE 15 FAILED: warn recorded an override';
  end if;

  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'off-commit', 'off', array[]::uuid[], null, array[ct, c2]);
  draw := (p ->> 'draw')::uuid;
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-off'));
  if res -> 'contributionGate' ->> 'policy' <> 'off' or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 0 then
    raise exception 'COMMIT-GATE 16 FAILED: off computed or reported flags at commit: %', res;
  end if;

  -- the policy is switched to block while members are sealing (the draw was opened under warn with flags)
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'switch-block', 'warn', array[co, ct], null, array[ct, c2]);
  draw := (p ->> 'draw')::uuid; cyc := (p ->> 'cycle')::uuid;
  perform pg_temp.call_as(co::text, format('select public.set_draw_cycle_contribution_gate_v1(%L, %L, %L)', cyc, 'block', 'Switching it on for everyone'));
  detail := pg_temp.expect_error_detail(co::text, pg_temp.cg_commit_sql(draw, 'ck-switch'), 'draw_contribution_gate_blocked', 'P0001');
  if jsonb_array_length(detail) <> 2 then
    raise exception 'COMMIT-GATE 17 FAILED: a policy switched to block while sealing did not stop the commit: %', detail;
  end if;
  -- DON'T STRAND MEMBERS: the seals are still valid; recording the missing payments clears the flags and the
  -- commit goes through with no override at all
  perform pg_temp.fx_pay(co, grp, 'pay-switch-c1', '100.00', cash, income, c1, cyc, 1);
  perform pg_temp.fx_pay(co, grp, 'pay-switch-c2', '100.00', cash, income, c2, cyc, 1);
  res := pg_temp.call_as(ct::text, pg_temp.cg_commit_sql(draw, 'ck-switch'));
  if res -> 'contributionGate' ->> 'policy' <> 'block' or jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 0
     or (res -> 'contributionGate' ->> 'overridden')::boolean then
    raise exception 'COMMIT-GATE 18 FAILED: resolving the flags did not let the commit through: %', res;
  end if;
  if (select count(*) from public.draw_contribution_gate_overrides where cycle_id = cyc) <> 0 then
    raise exception 'COMMIT-GATE 18 FAILED: an override was recorded although nothing was flagged';
  end if;

  -- off -> block while sealing, then the owner overrides at commit
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'switch-off', 'off', array[]::uuid[], null, array[ct, c2]);
  draw := (p ->> 'draw')::uuid; cyc := (p ->> 'cycle')::uuid;
  perform pg_temp.call_as(co::text, format('select public.set_draw_cycle_contribution_gate_v1(%L, %L, %L)', cyc, 'block', 'Switching it on for everyone'));
  perform pg_temp.expect_error_detail(co::text, pg_temp.cg_commit_sql(draw, 'ck-switch-off'), 'draw_contribution_gate_blocked', 'P0001');
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-switch-off', reason));
  select * into ov from public.draw_contribution_gate_overrides where draw_id = draw;
  if not found or ov.stage <> 'commit' or jsonb_array_length(ov.flagged) <> 4 or ov.actor_id <> co then
    raise exception 'COMMIT-GATE 19 FAILED: the override after a policy switch is wrong: %', row_to_json(ov);
  end if;
  -- and block -> off while sealing lets it through
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'switch-relax', 'block', array[co], reason, array[ct, c2]);
  draw := (p ->> 'draw')::uuid; cyc := (p ->> 'cycle')::uuid;
  perform pg_temp.fx_reverse(co, grp, 'switch-relax-fix', (p -> 'entries' ->> co::text)::uuid, '100.00', cash, income);
  perform pg_temp.call_as(co::text, format('select public.set_draw_cycle_contribution_gate_v1(%L, %L, %L)', cyc, 'off', 'The group decided to relax this'));
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-relax'));
  if res -> 'contributionGate' ->> 'policy' <> 'off' then raise exception 'COMMIT-GATE 20 FAILED: %', res; end if;

  -- an inactive member's flag does not hold up the commit
  p := pg_temp.cg_prepare(co, c1, grp, tnt, cash, income, 'inactive', 'block', array[co, ct, c1, c2], null, array[ct, c2]);
  draw := (p ->> 'draw')::uuid; cyc := (p ->> 'cycle')::uuid;
  perform pg_temp.fx_reverse(co, grp, 'inactive-fix', (p -> 'entries' ->> ct::text)::uuid, '100.00', cash, income);
  reset role;
  update public.ledger_group_memberships set status = 'inactive' where group_id = grp and user_id = ct;
  res := pg_temp.call_as(co::text, pg_temp.cg_commit_sql(draw, 'ck-inactive'));
  update public.ledger_group_memberships set status = 'active' where group_id = grp and user_id = ct;
  if jsonb_array_length(res -> 'contributionGate' -> 'flagged') <> 0 then
    raise exception 'COMMIT-GATE 21 FAILED: an inactive member''s flag reached the commit gate: %', res;
  end if;

  -- =========================================================================
  -- COMMIT-GATE 4: signatures and grants (no stale overload)
  -- =========================================================================
  if to_regprocedure('public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text)') is not null then
    raise exception 'COMMIT-GATE 22 FAILED: the old nine-argument commit is still callable (PostgREST could not choose between overloads)';
  end if;
  if (select count(*) from pg_proc where proname = 'commit_draw_from_seals_v1' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'COMMIT-GATE 22 FAILED: commit_draw_from_seals_v1 has more than one signature';
  end if;
  if has_function_privilege('anon', 'public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_draw_open_override_flags(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_draw_flags_covered(jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_draw_cycle_member_rounds(uuid, uuid)', 'EXECUTE') then
    raise exception 'COMMIT-GATE 23 FAILED: a function is executable by a role that must not have it';
  end if;
  if not has_function_privilege('authenticated', 'public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text)', 'EXECUTE') then
    raise exception 'COMMIT-GATE 23 FAILED: authenticated cannot execute the commit';
  end if;
end;
$commitgate$;

rollback;
select 'ALL ATTRIBUTION AND COLLATERAL CHECKS PASSED' as result;
select 'ALL CONTRIBUTION GRID AND GATE CHECKS PASSED' as result;
select 'ALL POST-WIN FILL AND COMMIT GATE CHECKS PASSED' as result;

-- ---------------------------------------------------------------------------
-- Payment channel and note on an attribution (20261012100000_attribution_channel_and_note.sql)
--
-- A manual contribution's HOW (channel: telebirr | cbe | awash | cash | other) and a
-- short plain-text note live on the same append-only attribution row as the payer, not
-- on the hash-chained entry. Checks that (a) record stores a channel and a trimmed
-- note and the read reports both, an old-style call (no channel, no note) still works
-- and means none, (b) a channel outside the list and a note that is empty-after-trim
-- over 280 characters or carries a control, DEL, C1 or bidi/zero-width character are
-- refused with ledger_invalid_request and leave no row, a 280-character Amharic note is
-- accepted, (c) a repeat that includes the same channel and note is a replay and any
-- difference in channel or note is attribution_exists, (d) supersede KEEPS channel and
-- note when the argument is null, CLEARS them with the empty string, stores the full
-- resulting state in a new row, can correct the channel alone, refuses a no-op as
-- attribution_unchanged and the original row keeps its channel and note, (e) outsiders,
-- plain members and anonymous callers are refused and nothing is left behind, (f)
-- PROVENANCE: a bank-verified entry refuses every manual write whatever channel it
-- carries (matching the provider or not, with or without a note), reads as the bank
-- provider with no note, and a bank link that appears after a manual row makes the read
-- report the provider while the manual row (channel and note) stays in the history,
-- (g) the table's own constraints hold against a direct insert and the row is still
-- append-only, (h) the entry's hash and the chain head are untouched, and (i) one
-- signature per RPC (no overload for PostgREST to choose between) with the right grants.
-- Runs in a transaction that is rolled back.
-- ---------------------------------------------------------------------------
reset role;
begin;
select set_config('request.jwt.claim.sub', '', true);

insert into auth.users (id, email) values
  ('d1000000-0000-4000-8000-000000000001', 'chan-owner@example.test'),
  ('d1000000-0000-4000-8000-000000000002', 'chan-treasurer@example.test'),
  ('d1000000-0000-4000-8000-000000000003', 'chan-a@example.test'),
  ('d1000000-0000-4000-8000-000000000004', 'chan-b@example.test'),
  ('d1000000-0000-4000-8000-000000000005', 'chan-plain@example.test'),
  ('d1000000-0000-4000-8000-000000000006', 'chan-outsider@example.test')
on conflict (id) do nothing;

create or replace function pg_temp.expect_error(p_uid text, p_sql text, p_msg text, p_state text)
returns void
language plpgsql
as $$
declare
  got_msg text;
  got_state text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  begin
    set local role authenticated;
    execute p_sql;
    reset role;
    raise exception 'no error' using errcode = 'XX999';
  exception when others then
    got_msg := sqlerrm;
    got_state := sqlstate;
  end;
  reset role;
  if got_state = 'XX999' then
    raise exception 'EXPECT FAILED: no error from [%], wanted % %', p_sql, p_state, p_msg;
  end if;
  if got_msg <> p_msg or got_state <> p_state then
    raise exception 'EXPECT FAILED: [%] wanted % %, got % %', p_sql, p_state, p_msg, got_state, got_msg;
  end if;
end;
$$;

create or replace function pg_temp.call_as(p_uid text, p_sql text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  set local role authenticated;
  execute p_sql into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end;
$$;

do $chan$
declare
  owner_uid constant text := 'd1000000-0000-4000-8000-000000000001';
  t_uid     constant text := 'd1000000-0000-4000-8000-000000000002';
  a_uid     constant text := 'd1000000-0000-4000-8000-000000000003';
  b_uid     constant text := 'd1000000-0000-4000-8000-000000000004';
  c_uid     constant text := 'd1000000-0000-4000-8000-000000000005';
  outsider  constant text := 'd1000000-0000-4000-8000-000000000006';
  group_g uuid;
  tenant_g uuid;
  cash_g uuid;
  income_g uuid;
  binding_a uuid := 'dc000000-0000-4000-8000-0000000000f1';
  e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; e_bank uuid; e_late uuid;
  head_before record;
  head_after record;
  hash_before text;
  hash_after text;
  res jsonb;
  res2 jsonb;
  n bigint;
  long_note text;
  amharic_note text;
begin
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  group_g := (public.sened_ledger_provision_group_v1('Channel equb') ->> 'groupId')::uuid;
  select tenant_id into tenant_g from public.ledger_groups where id = group_g;
  select id into cash_g from public.ledger_accounts where group_id = group_g and code = 'POT_CASH';
  select id into income_g from public.ledger_accounts where group_id = group_g and code = 'CONTRIBUTION_INCOME';
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (group_g, tenant_g, t_uid::uuid, 'treasurer', 'active'),
    (group_g, tenant_g, a_uid::uuid, 'member', 'active'),
    (group_g, tenant_g, b_uid::uuid, 'member', 'active'),
    (group_g, tenant_g, c_uid::uuid, 'member', 'active');

  e1 := (public.post_ledger_entry_v1(group_g, 'chan-e1', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e2 := (public.post_ledger_entry_v1(group_g, 'chan-e2', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e3 := (public.post_ledger_entry_v1(group_g, 'chan-e3', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e4 := (public.post_ledger_entry_v1(group_g, 'chan-e4', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e5 := (public.post_ledger_entry_v1(group_g, 'chan-e5', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e_bank := (public.post_ledger_entry_v1(group_g, 'bank-verified-chan-1', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;
  e_late := (public.post_ledger_entry_v1(group_g, 'chan-late', now(), 'contribution', null, null,
    jsonb_build_array(jsonb_build_object('accountId', cash_g, 'direction', 'debit', 'amount', '100.00'),
                      jsonb_build_object('accountId', income_g, 'direction', 'credit', 'amount', '100.00'))) -> 'entry' ->> 'id')::uuid;

  insert into public.bank_account_bindings (id,user_id,tenant_id,group_id,ledger_account_id,provider,account_label,account_fingerprint_hmac,sender_fingerprint_hmac,receiver_fingerprint_hmac)
  values (binding_a, a_uid::uuid, tenant_g, group_g, cash_g, 'cbe', 'A', repeat('a',64), repeat('b',64), repeat('c',64));
  insert into public.bank_verification_intents (id,user_id,tenant_id,group_id,bank_account_binding_id,ledger_account_id,provider,provider_reference_hmac,idempotency_key,request_fingerprint,amount,direction,occurred_at)
  values
    ('dd000000-0000-4000-8000-0000000000f1', a_uid::uuid, tenant_g, group_g, binding_a, cash_g, 'cbe', repeat('7',64), 'chan-bank-1', repeat('e',64), 100.00, 'inbound', now()),
    ('dd000000-0000-4000-8000-0000000000f2', a_uid::uuid, tenant_g, group_g, binding_a, cash_g, 'cbe', repeat('6',64), 'chan-bank-2', repeat('e',64), 100.00, 'inbound', now());
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('3',64), verified_at = '2026-10-12 09:00:05.123+00',
      ledger_entry_id = e_bank
  where id = 'dd000000-0000-4000-8000-0000000000f1';
  update public.bank_verification_intents
  set state = 'VERIFIED', reason_code = 'VERIFIED', evidence_fingerprint = repeat('f',64),
      provider_transaction_identity_hmac = repeat('4',64), verified_at = '2026-10-12 09:05:00+00'
  where id = 'dd000000-0000-4000-8000-0000000000f2';

  select last_sequence, last_hash into head_before from public.ledger_group_heads where group_id = group_g;
  select entry_hash into hash_before from public.ledger_entries where id = e1;

  -- =========================================================================
  -- CHANNEL 1-3: record stores channel and a trimmed note; the read reports both
  -- =========================================================================
  res := pg_temp.call_as(t_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e1, a_uid, 'telebirr', '  Paid at the Sunday meeting  '));
  if (res ->> 'replayed')::boolean is not false
     or res -> 'attribution' ->> 'channel' <> 'telebirr'
     or res -> 'attribution' ->> 'note' <> 'Paid at the Sunday meeting'
     or res -> 'attribution' ->> 'source' <> 'treasurer' then
    raise exception 'CHANNEL 1 FAILED: unexpected record result %', res;
  end if;
  res := pg_temp.call_as(c_uid, format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_g, e1));
  if res -> 0 ->> 'channel' <> 'telebirr' or res -> 0 ->> 'note' <> 'Paid at the Sunday meeting' then
    raise exception 'CHANNEL 2 FAILED: a plain member does not read the channel and note: %', res;
  end if;
  -- an old-style call (no channel, no note) still works and means none
  res := pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e2, a_uid));
  if res -> 'attribution' -> 'channel' <> 'null'::jsonb or res -> 'attribution' -> 'note' <> 'null'::jsonb then
    raise exception 'CHANNEL 3 FAILED: an old-style call stored a channel or note: %', res;
  end if;
  -- the empty string also means none (a form that sends "")
  res := pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e3, a_uid, '', '   '));
  if res -> 'attribution' -> 'channel' <> 'null'::jsonb or res -> 'attribution' -> 'note' <> 'null'::jsonb then
    raise exception 'CHANNEL 4 FAILED: empty channel/note were stored: %', res;
  end if;

  -- =========================================================================
  -- CHANNEL 5-8: shapes that are refused leave nothing behind
  -- =========================================================================
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L)', group_g, e4, a_uid, 'paypal'), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L)', group_g, e4, a_uid, 'CASH'), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e4, a_uid, repeat('x', 281)), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e4, a_uid, E'line one\nline two'), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e4, a_uid, E'tab\there'), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e4, a_uid, 'del' || chr(127)), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e4, a_uid, 'c1' || chr(133)), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e4, a_uid, 'bidi' || chr(8238) || 'txt'), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e4, a_uid, 'zw' || chr(8203) || 'sp'), 'ledger_invalid_request', '22023');
  if (select count(*) from public.ledger_entry_attributions where entry_id = e4) <> 0 then
    raise exception 'CHANNEL 5 FAILED: a refused channel or note left a row behind';
  end if;
  -- exactly 280 Ethiopic characters is accepted (the limit counts characters, not bytes)
  amharic_note := repeat(chr(4768), 280);
  res := pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e4, b_uid, 'other', amharic_note));
  if char_length(res -> 'attribution' ->> 'note') <> 280 or res -> 'attribution' ->> 'channel' <> 'other' then
    raise exception 'CHANNEL 6 FAILED: a 280-character Ethiopic note was not stored whole: %', res;
  end if;
  -- markup is data: stored and returned byte for byte, never interpreted
  res := pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e5, b_uid, 'cash', '<b>paid</b> & "ok"'));
  if res -> 'attribution' ->> 'note' <> '<b>paid</b> & "ok"' then
    raise exception 'CHANNEL 7 FAILED: markup in a note was altered: %', res;
  end if;

  -- the remaining channels (awash, cbe) are accepted by a correction
  res := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e5, b_uid, 'It went through Awash instead', 'awash'));
  res2 := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e5, b_uid, 'Actually it was CBE Birr', 'cbe'));
  if res -> 'attribution' ->> 'channel' <> 'awash' or res2 -> 'attribution' ->> 'channel' <> 'cbe'
     or res2 -> 'attribution' ->> 'note' <> '<b>paid</b> & "ok"' then
    raise exception 'CHANNEL 7B FAILED: awash/cbe corrections: % %', res, res2;
  end if;

  -- =========================================================================
  -- CHANNEL 8-10: replay, exists
  -- =========================================================================
  res2 := pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e1, a_uid, 'telebirr', 'Paid at the Sunday meeting'));
  if (res2 ->> 'replayed')::boolean is not true then
    raise exception 'CHANNEL 8 FAILED: the same record with the same channel and note was not a replay: %', res2;
  end if;
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e1, a_uid, 'cash', 'Paid at the Sunday meeting'), 'attribution_exists', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e1, a_uid, 'telebirr', 'A different note'), 'attribution_exists', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L)', group_g, e1, a_uid), 'attribution_exists', 'P0001');
  if (select count(*) from public.ledger_entry_attributions where entry_id = e1) <> 1 then
    raise exception 'CHANNEL 9 FAILED: more than one row for an entry after a replay and refusals';
  end if;

  -- =========================================================================
  -- CHANNEL 10-16: supersede keeps, clears, corrects one field, refuses a no-op
  -- =========================================================================
  -- null keeps channel and note, so correcting the payer does not wipe them
  res := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, b_uid, 'Receipt book shows B paid, not A'));
  if (res ->> 'replayed')::boolean is not false
     or (res -> 'attribution' ->> 'revision')::int <> 2
     or res -> 'attribution' ->> 'memberUserId' <> b_uid
     or res -> 'attribution' ->> 'channel' <> 'telebirr'
     or res -> 'attribution' ->> 'note' <> 'Paid at the Sunday meeting'
     or res -> 'attribution' ->> 'reason' <> 'Receipt book shows B paid, not A' then
    raise exception 'CHANNEL 10 FAILED: a payer-only correction did not keep channel and note: %', res;
  end if;
  -- the same correction again is a replay
  res2 := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, b_uid, 'Receipt book shows B paid, not A'));
  if (res2 ->> 'replayed')::boolean is not true then
    raise exception 'CHANNEL 11 FAILED: the same supersede again was not a replay: %', res2;
  end if;
  -- a no-op (same payer, channel and note, kept) is unchanged
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L)', group_g, e1, b_uid, 'Nothing about this changes at all'), 'attribution_unchanged', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L,%L)', group_g, e1, b_uid, 'Saying the same thing again', 'telebirr', 'Paid at the Sunday meeting'), 'attribution_unchanged', 'P0001');
  -- the channel alone can be corrected
  res := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e1, b_uid, 'It was cash, not Telebirr', 'cash'));
  if (res -> 'attribution' ->> 'revision')::int <> 3
     or res -> 'attribution' ->> 'channel' <> 'cash'
     or res -> 'attribution' ->> 'note' <> 'Paid at the Sunday meeting'
     or res -> 'attribution' ->> 'memberUserId' <> b_uid then
    raise exception 'CHANNEL 12 FAILED: a channel-only correction did not store the full state: %', res;
  end if;
  -- the empty string clears; the note alone can be set and cleared
  res := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L,%L)', group_g, e1, b_uid, 'Removing the channel and the note', '', ''));
  if res -> 'attribution' -> 'channel' <> 'null'::jsonb or res -> 'attribution' -> 'note' <> 'null'::jsonb
     or (res -> 'attribution' ->> 'revision')::int <> 4 then
    raise exception 'CHANNEL 13 FAILED: the empty string did not clear channel and note: %', res;
  end if;
  res := pg_temp.call_as(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,null,%L)', group_g, e1, b_uid, 'Adding a note afterwards', 'Brought by his brother'));
  if res -> 'attribution' ->> 'note' <> 'Brought by his brother' or res -> 'attribution' -> 'channel' <> 'null'::jsonb then
    raise exception 'CHANNEL 14 FAILED: a note-only correction failed: %', res;
  end if;
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e1, b_uid, 'Trying an invalid channel', 'paypal'), 'ledger_invalid_request', '22023');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,null,%L)', group_g, e1, b_uid, 'Trying a control character', E'a\nb'), 'ledger_invalid_request', '22023');
  -- history: one root, the original channel and note preserved in it, five rows in a line
  if (select count(*) from public.ledger_entry_attributions where entry_id = e1) <> 5
     or (select channel from public.ledger_entry_attributions where entry_id = e1 and supersedes_id is null) <> 'telebirr'
     or (select note from public.ledger_entry_attributions where entry_id = e1 and supersedes_id is null) <> 'Paid at the Sunday meeting'
     or (select member_user_id from public.ledger_entry_attributions where entry_id = e1 and supersedes_id is null) <> a_uid::uuid then
    raise exception 'CHANNEL 15 FAILED: the original attribution (with its channel and note) was not preserved';
  end if;
  -- a correction of an entry that has none is still attribution_not_found
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e_late, a_uid, 'There is nothing to supersede', 'cash'), 'attribution_not_found', 'P0002');

  -- =========================================================================
  -- CHANNEL 16: who may write
  -- =========================================================================
  perform pg_temp.expect_error(c_uid,    format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e_late, a_uid, 'cash', 'x'), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e_late, a_uid, 'cash', 'x'), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error('',       format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e_late, a_uid, 'cash', 'x'), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(c_uid,    format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e1, a_uid, 'A plain member cannot correct', 'cash'), 'ledger_forbidden', '42501');
  perform pg_temp.expect_error(outsider, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e1, a_uid, 'An outsider cannot correct', 'cash'), 'ledger_forbidden', '42501');
  if (select count(*) from public.ledger_entry_attributions where entry_id = e_late) <> 0 then
    raise exception 'CHANNEL 16 FAILED: a refused caller left a row behind';
  end if;
  perform pg_temp.expect_error(outsider, format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_g, e1), 'ledger_forbidden', '42501');

  -- =========================================================================
  -- CHANNEL 17-21: provenance. A bank-verified entry refuses EVERY manual write, so a
  -- manual channel can never contradict the provider; it reads as the provider.
  -- =========================================================================
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L)', group_g, e_bank, a_uid, 'cbe'), 'attribution_bank_verified', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L)', group_g, e_bank, a_uid, 'cash'), 'attribution_bank_verified', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,null,%L)', group_g, e_bank, a_uid, 'a note'), 'attribution_bank_verified', 'P0001');
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e_bank, a_uid, 'Trying to override the bank', 'cash'), 'attribution_bank_verified', 'P0001');
  if (select count(*) from public.ledger_entry_attributions where entry_id = e_bank) <> 0 then
    raise exception 'CHANNEL 17 FAILED: a manual write landed on a bank-verified entry';
  end if;
  res := pg_temp.call_as(c_uid, format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_g, e_bank));
  if res -> 0 ->> 'source' <> 'bank_verification' or res -> 0 ->> 'channel' <> 'cbe' or res -> 0 -> 'note' <> 'null'::jsonb then
    raise exception 'CHANNEL 18 FAILED: a bank-verified entry does not read as its provider: %', res;
  end if;
  -- a manual row first (cash + note), the bank link appears afterwards
  perform pg_temp.call_as(owner_uid, format('select public.record_ledger_entry_attribution_v1(%L,%L,%L,null,null,%L,%L)', group_g, e_late, b_uid, 'cash', 'Handed over in person'));
  res := pg_temp.call_as(c_uid, format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_g, e_late));
  if res -> 0 ->> 'source' <> 'treasurer' or res -> 0 ->> 'channel' <> 'cash' or res -> 0 ->> 'note' <> 'Handed over in person' then
    raise exception 'CHANNEL 19 FAILED: the manual channel and note are not read before the bank link: %', res;
  end if;
  update public.bank_verification_intents set ledger_entry_id = e_late where id = 'dd000000-0000-4000-8000-0000000000f2';
  res := pg_temp.call_as(c_uid, format('select public.get_ledger_entry_attributions_v1(%L, array[%L]::uuid[])', group_g, e_late));
  if res -> 0 ->> 'source' <> 'bank_verification' or res -> 0 ->> 'channel' <> 'cbe' or res -> 0 -> 'note' <> 'null'::jsonb then
    raise exception 'CHANNEL 20 FAILED: a manual channel/note outranked a later bank link: %', res;
  end if;
  if (select channel from public.ledger_entry_attributions where entry_id = e_late) <> 'cash'
     or (select note from public.ledger_entry_attributions where entry_id = e_late) <> 'Handed over in person' then
    raise exception 'CHANNEL 21 FAILED: the manual row was not kept in the history';
  end if;
  perform pg_temp.expect_error(owner_uid, format('select public.supersede_ledger_entry_attribution_v1(%L,%L,%L,%L,null,null,%L)', group_g, e_late, b_uid, 'Bank link appeared afterwards', 'awash'), 'attribution_bank_verified', 'P0001');

  -- =========================================================================
  -- CHANNEL 22-27: the table holds its own rules for ANY writer, and is append-only
  -- =========================================================================
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, channel)
    values (e2, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, 'paypal');
    raise exception 'CHANNEL 22 FAILED: a channel outside the list was inserted directly';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, note)
    values (e2, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, ' padded');
    raise exception 'CHANNEL 23 FAILED: an untrimmed note was inserted directly';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, note)
    values (e2, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, '');
    raise exception 'CHANNEL 24 FAILED: an empty note was inserted directly';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, note)
    values (e2, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, repeat('y', 281));
    raise exception 'CHANNEL 25 FAILED: a 281-character note was inserted directly';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, note)
    values (e2, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, E'two\nlines');
    raise exception 'CHANNEL 26 FAILED: a note with a control character was inserted directly';
  exception when check_violation then null;
  end;
  begin
    update public.ledger_entry_attributions set channel = 'other' where entry_id = e1;
    raise exception 'CHANNEL 27 FAILED: a channel was updated in place';
  exception when others then
    if sqlerrm <> 'attribution_history_immutable' then raise exception 'CHANNEL 27 FAILED: %', sqlerrm; end if;
  end;
  begin
    update public.ledger_entry_attributions set note = null where entry_id = e1;
    raise exception 'CHANNEL 28 FAILED: a note was updated in place';
  exception when others then
    if sqlerrm <> 'attribution_history_immutable' then raise exception 'CHANNEL 28 FAILED: %', sqlerrm; end if;
  end;
  -- the trigger rules still apply to a direct insert carrying a channel
  begin
    insert into public.ledger_entry_attributions (entry_id, group_id, tenant_id, member_user_id, recorded_by, channel)
    values (e_bank, group_g, tenant_g, a_uid::uuid, owner_uid::uuid, 'cbe');
    raise exception 'CHANNEL 29 FAILED: a direct insert on a bank-verified entry was accepted';
  exception when others then
    if sqlerrm <> 'attribution_bank_verified' then raise exception 'CHANNEL 29 FAILED: %', sqlerrm; end if;
  end;

  -- =========================================================================
  -- CHANNEL 30-32: the chain is untouched; one signature per RPC; grants
  -- =========================================================================
  select last_sequence, last_hash into head_after from public.ledger_group_heads where group_id = group_g;
  select entry_hash into hash_after from public.ledger_entries where id = e1;
  if head_after.last_sequence <> head_before.last_sequence or head_after.last_hash <> head_before.last_hash or hash_after <> hash_before then
    raise exception 'CHANNEL 30 FAILED: the ledger chain moved while channel and note were recorded';
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname in ('record_ledger_entry_attribution_v1', 'supersede_ledger_entry_attribution_v1', 'sened_attribute_entry');
  if n <> 3 then
    raise exception 'CHANNEL 31 FAILED: expected one signature each for the two RPCs and the helper, found % functions', n;
  end if;
  if to_regprocedure('public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer)') is not null
     or to_regprocedure('public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer)') is not null
     or to_regprocedure('public.sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text)') is not null then
    raise exception 'CHANNEL 32 FAILED: an old arity is still callable (PostgREST could not choose between overloads)';
  end if;
  if has_function_privilege('anon', 'public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text)', 'EXECUTE')
     or has_function_privilege('public', 'public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_attribution_channel_note(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sened_attribution_json(uuid, uuid)', 'EXECUTE') then
    raise exception 'CHANNEL 33 FAILED: a function is executable by a role that must not have it';
  end if;
  if not has_function_privilege('authenticated', 'public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer, text, text)', 'EXECUTE') then
    raise exception 'CHANNEL 34 FAILED: authenticated cannot execute the attribution RPCs';
  end if;
end;
$chan$;
rollback;
select 'ALL PAYMENT CHANNEL AND NOTE CHECKS PASSED' as result;
