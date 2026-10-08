-- Draw protocol v3: the winner depends on the revealed member nonces.
--
-- THE HOLE. In protocol v2 the winner was selected from a transcript digest over
-- (drawId, commitment, rosterDigest, memberDigest, seed). Every one of those is
-- known to the treasurer *before* they commit — `memberDigest` is a digest of the
-- members' sealed HASHES, not of their nonces — so the treasurer could grind
-- `seed` / `commitment_nonce` offline until the winner was the member they
-- wanted, and then commit. The member nonces, the only values the treasurer does
-- not have at commit time, never influenced the outcome.
--
-- THE FIX (application side, src/lib/draw/canonical.ts). Protocol v3 adds a
-- nonce digest — H(drawId, sorted (memberId, nonce) pairs), computed only from
-- nonces that verified against their seals — to the transcript preimage
-- (`sened-draw-transcript-v3`) and binds the protocol version into the
-- commitment hash (`sened-draw-commit-v3`).
--
-- WHAT THIS MIGRATION DOES
--
-- 1. `draw_commitments.protocol_version` ('v2' | 'v3'). Every existing row is
--    backfilled 'v2' (they were hashed under the v2 rules and must stay
--    verifiable under them); the column default is then switched to 'v3'. The
--    table is append-only (draw_commitments_block_mutation), so a row's version
--    can never be changed afterwards.
-- 2. `commit_draw_v1` gains `p_protocol_version` and REFUSES anything but 'v3':
--    this function is reachable directly through PostgREST, so a treasurer cannot
--    open a new draw under the grindable v2 rules by calling it by hand. The
--    old 15-argument arity is dropped explicitly (create or replace with a new
--    argument list would otherwise leave it callable) and the new arity is
--    revoked/granted in this same file.
-- 3. `reveal_draw_v1` keeps its signature. For v3 draws it additionally requires
--    the opened nonce set to be exactly the sealed member set (see the comment
--    at the check).
-- 4. `sened_draw_round_response` publishes `protocolVersion`, which the verifier
--    dispatches on.
--
-- WHAT THIS DOES NOT DO. The database still does not recompute the seed-to-winner
-- derivation or hash nonces against seals (see 20260926110000_draw_reveal_binding.sql
-- for why). That is enforced in the application and independently checkable by
-- every member's browser.
--
-- DEPLOY ORDER: apply this migration BEFORE the application release that sends
-- `p_protocol_version`.

alter table public.draw_commitments
  add column if not exists protocol_version text not null default 'v2';

alter table public.draw_commitments
  drop constraint if exists draw_commitments_protocol_version_known;
alter table public.draw_commitments
  add constraint draw_commitments_protocol_version_known
  check (protocol_version in ('v2', 'v3'));

-- Existing rows keep 'v2' (the default at the moment the column was added);
-- anything inserted from here on is v3 unless it says otherwise.
alter table public.draw_commitments
  alter column protocol_version set default 'v3';

comment on column public.draw_commitments.protocol_version is
  'Derivation the draw was committed under. v2 = legacy (winner independent of member nonces, grindable by the treasurer); v3 = winner depends on the revealed member nonces. Immutable.';

-- ── commit_draw_v1 ──────────────────────────────────────────────────────────

drop function if exists public.commit_draw_v1(
  uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz
);

create or replace function public.commit_draw_v1(
  p_group_id uuid,
  p_cycle_id uuid,
  p_round integer,
  p_draw_id uuid,
  p_commitment text,
  p_commitment_nonce text,
  p_roster_digest text,
  p_member_digest text,
  p_member_commitments jsonb,
  p_participants jsonb,
  p_pot_amount numeric,
  p_total_rounds integer,
  p_reserve_ratio_bps integer,
  p_idempotency_key text,
  p_occurred_at timestamptz,
  p_protocol_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
  created_row public.draw_commitments;
  existing_row public.draw_commitments;
  existing_reveal public.draw_reveals;
  existing_payout public.draw_payouts;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  -- New draws are protocol v3 only. v2 derived the winner from values the
  -- treasurer knew before committing, so a treasurer could grind the seed; it
  -- stays readable (historical rows) but can no longer be created, including by
  -- a caller going straight to this function.
  if p_protocol_version is distinct from 'v3' then
    raise exception using errcode = 'P0001', message = 'draw_protocol_version_unsupported';
  end if;

  -- A draw with no sealed member contribution is not a draw, it is a treasurer
  -- choosing a winner. Refused here as well as in the application, because this
  -- function is reachable directly.
  if p_member_digest is null or p_member_commitments is null then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;
  if jsonb_typeof(p_member_commitments) <> 'array' or jsonb_array_length(p_member_commitments) < 1 then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;

  select group_row.tenant_id
  into tenant
  from public.ledger_groups group_row
  where group_row.id = p_group_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_group_not_found';
  end if;

  if not public.sened_ledger_can_manage_group(p_group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  if not exists (
    select 1
    from public.draw_cycles cycle
    where cycle.id = p_cycle_id and cycle.group_id = p_group_id
  ) then
    raise exception using errcode = 'P0001', message = 'draw_group_not_found';
  end if;

  insert into public.draw_commitments (
    draw_id,
    group_id,
    tenant_id,
    cycle_id,
    round,
    commitment,
    commitment_nonce,
    roster_digest,
    member_digest,
    member_commitments,
    participants,
    pot_amount,
    total_rounds,
    reserve_ratio_bps,
    actor_id,
    idempotency_key,
    committed_at,
    protocol_version
  ) values (
    p_draw_id,
    p_group_id,
    tenant,
    p_cycle_id,
    p_round,
    p_commitment,
    p_commitment_nonce,
    p_roster_digest,
    p_member_digest,
    p_member_commitments,
    p_participants,
    p_pot_amount,
    p_total_rounds,
    p_reserve_ratio_bps,
    actor,
    p_idempotency_key,
    coalesce(p_occurred_at, clock_timestamp()),
    p_protocol_version
  )
  on conflict (group_id, idempotency_key) do nothing
  returning * into created_row;

  if not found then
    select existing.*
    into existing_row
    from public.draw_commitments existing
    where existing.group_id = p_group_id
      and existing.idempotency_key = p_idempotency_key;
    if not found then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    if existing_row.commitment <> p_commitment then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    -- The same idempotency key must not be reusable to swap in a different set
    -- of contributing members, or the retry would silently change the ceremony.
    if existing_row.member_digest is distinct from p_member_digest then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    if existing_row.protocol_version is distinct from p_protocol_version then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    select reveal.* into existing_reveal
    from public.draw_reveals reveal
    where reveal.draw_id = existing_row.draw_id;
    select payout.* into existing_payout
    from public.draw_payouts payout
    where payout.draw_id = existing_row.draw_id;
    return jsonb_build_object(
      'round', public.sened_draw_round_response(
        existing_row,
        existing_reveal,
        existing_payout
      ),
      'replayed', true
    );
  end if;

  return jsonb_build_object(
    'round', public.sened_draw_round_response(created_row, null, null),
    'replayed', false
  );
end;
$$;


-- ── reveal_draw_v1 (same signature; checks added for v3) ────────────────────

create or replace function public.reveal_draw_v1(
  p_draw_id uuid,
  p_seed text,
  p_commitment text,
  p_member_digest text,
  p_member_nonces jsonb,
  p_transcript_digest text,
  p_selection_digest text,
  p_selected_index integer,
  p_winner_member_id uuid,
  p_winning_ticket text,
  p_payout_amount numeric,
  p_reserve_amount numeric,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  commitment_row public.draw_commitments;
  reveal_row public.draw_reveals;
  existing_payout public.draw_payouts;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select commitment.*
  into commitment_row
  from public.draw_commitments commitment
  where commitment.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_committed';
  end if;
  if not public.sened_ledger_can_manage_group(commitment_row.group_id, commitment_row.tenant_id) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;
  if commitment_row.commitment <> p_commitment then
    raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
  end if;

  -- The reveal must open every contribution the commitment sealed. A partial set
  -- would leave part of the randomness that decided the winner unpublished, which
  -- is the one thing a member checking the transcript needs to rule out.
  if commitment_row.member_digest is not null then
    if p_member_nonces is null
       or jsonb_typeof(p_member_nonces) <> 'array'
       or jsonb_array_length(p_member_nonces) <> jsonb_array_length(commitment_row.member_commitments) then
      raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
    end if;
    if p_member_digest is distinct from commitment_row.member_digest then
      raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
    end if;

    -- Protocol v3 derives the winner from the revealed nonces, so the opened set
    -- must be exactly the sealed set: every entry well formed, no member opened
    -- twice (which would hide an unopened one), and no outsider. Equal length +
    -- distinct ids + every id sealed = the same set. The nonce-to-seal hash and
    -- the seed-to-winner derivation stay in the application, and are checked on
    -- every member's own device (see docs/architecture/draw.md).
    if commitment_row.protocol_version = 'v3' then
      if exists (
        select 1
        from jsonb_array_elements(p_member_nonces) as opened(entry)
        where jsonb_typeof(opened.entry) <> 'object'
          or opened.entry ->> 'memberId' is null
          or char_length(coalesce(opened.entry ->> 'nonce', '')) < 16
      ) then
        raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
      end if;
      if (
        select count(distinct opened.entry ->> 'memberId')
        from jsonb_array_elements(p_member_nonces) as opened(entry)
      ) <> jsonb_array_length(p_member_nonces) then
        raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(p_member_nonces) as opened(entry)
        where not exists (
          select 1
          from jsonb_array_elements(commitment_row.member_commitments) as sealed(entry)
          where sealed.entry ->> 'memberId' = opened.entry ->> 'memberId'
        )
      ) then
        raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
      end if;
    end if;
  end if;

  -- Rotation, enforced in the database as well as in the application: a member
  -- already drawn in this cycle can never be drawn again.
  if exists (
    select 1
    from public.draw_commitments sibling
    join public.draw_reveals prior on prior.draw_id = sibling.draw_id
    where sibling.cycle_id = commitment_row.cycle_id
      and sibling.round < commitment_row.round
      and prior.winner_member_id = p_winner_member_id
  ) then
    raise exception using errcode = 'P0001', message = 'draw_repeat_winner';
  end if;

  insert into public.draw_reveals (
    draw_id,
    commitment,
    seed,
    member_digest,
    member_nonces,
    transcript_digest,
    selection_digest,
    selected_index,
    winner_member_id,
    winning_ticket,
    payout_amount,
    reserve_amount,
    actor_id,
    revealed_at
  ) values (
    p_draw_id,
    p_commitment,
    p_seed,
    coalesce(p_member_digest, commitment_row.member_digest),
    p_member_nonces,
    p_transcript_digest,
    p_selection_digest,
    p_selected_index,
    p_winner_member_id,
    p_winning_ticket,
    p_payout_amount,
    p_reserve_amount,
    actor,
    coalesce(p_occurred_at, clock_timestamp())
  )
  on conflict (draw_id) do nothing
  returning * into reveal_row;

  if not found then
    raise exception using errcode = 'P0001', message = 'draw_already_revealed';
  end if;

  select payout.* into existing_payout
  from public.draw_payouts payout
  where payout.draw_id = p_draw_id;

  return public.sened_draw_round_response(commitment_row, reveal_row, existing_payout);
end;
$$;


revoke all on function public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz, text) from public, anon;
grant execute on function public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz, text) to authenticated;

-- Same signature as before, so the existing privileges carry over; restated so
-- this file is self-contained.
revoke all on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) from public, anon;
grant execute on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) to authenticated;

-- ── round response: publish the protocol version ────────────────────────────

create or replace function public.sened_draw_round_response(
  commitment_row public.draw_commitments,
  reveal_row public.draw_reveals,
  payout_row public.draw_payouts
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'state', case
      when payout_row.id is not null then 'paid'
      when reveal_row.id is not null then 'revealed'
      else 'committed'
    end,
    'commitment', jsonb_build_object(
      'drawId', commitment_row.draw_id,
      'groupId', commitment_row.group_id,
      'cycleId', commitment_row.cycle_id,
      'round', commitment_row.round,
      'commitment', commitment_row.commitment,
      'protocolVersion', commitment_row.protocol_version,
      'commitmentNonce', commitment_row.commitment_nonce,
      'memberDigest', commitment_row.member_digest,
      'memberCommitments', coalesce(commitment_row.member_commitments, '[]'::jsonb),
      'rosterDigest', commitment_row.roster_digest,
      'participants', commitment_row.participants,
      'potAmount', commitment_row.pot_amount::text,
      'totalRounds', commitment_row.total_rounds,
      'reserveRatioBps', commitment_row.reserve_ratio_bps,
      'committedBy', commitment_row.actor_id,
      'committedAt', commitment_row.committed_at,
      'idempotencyKey', commitment_row.idempotency_key
    ),
    'reveal', case
      when reveal_row.id is null then null
      else jsonb_build_object(
        'drawId', reveal_row.draw_id,
        'commitment', reveal_row.commitment,
        'seed', reveal_row.seed,
        'memberDigest', reveal_row.member_digest,
        'memberNonces', coalesce(reveal_row.member_nonces, '[]'::jsonb),
        'transcriptDigest', reveal_row.transcript_digest,
        'selectionDigest', reveal_row.selection_digest,
        'selectedIndex', reveal_row.selected_index,
        'winnerMemberId', reveal_row.winner_member_id,
        'winningTicket', reveal_row.winning_ticket,
        'payoutAmount', reveal_row.payout_amount::text,
        'reserveAmount', reveal_row.reserve_amount::text,
        'revealedBy', reveal_row.actor_id,
        'revealedAt', reveal_row.revealed_at
      )
    end,
    'payout', case
      when payout_row.id is null then null
      else jsonb_build_object(
        'drawId', payout_row.draw_id,
        'ledgerEntryId', payout_row.ledger_entry_id,
        'winnerMemberId', payout_row.winner_member_id,
        'amount', payout_row.amount::text,
        'reserveAmount', payout_row.reserve_amount::text,
        'postedAt', payout_row.posted_at,
        'postedBy', payout_row.actor_id
      )
    end
  );
$$;

revoke all on function public.sened_draw_round_response(public.draw_commitments, public.draw_reveals, public.draw_payouts) from public, anon, authenticated;
