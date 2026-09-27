-- Carry member contributions through the draw RPCs.
--
-- `20260927120000_draw_member_commitments.sql` added the columns and the
-- constraints. The application refuses a commitment with no member contribution,
-- but a caller going straight through PostgREST could still reach
-- `commit_draw_v1` and produce exactly the row the fairness property depends on
-- not existing. This closes that.
--
-- On signatures
--
-- `create or replace function` with a *different* argument list creates an
-- overload rather than replacing anything, so the old arities are dropped
-- explicitly first. That matters here: `20260925120000_bank_verification_reconciliation.sql`
-- shipped revoke/grant statements naming a function that did not exist, and the
-- whole migration chain failed to apply. Every drop below is paired with the
-- revoke and the grant for the new arity in the same file, so the two cannot
-- drift apart.
--
-- UNVERIFIED BY EXECUTION, like its predecessor. `scripts/verify-migrations.sql`
-- exercises the new arities at the end of that file. Docker is not startable in
-- the environment this was authored in.

-- ── commit_draw_v1 ──────────────────────────────────────────────────────────

drop function if exists public.commit_draw_v1(
  uuid, uuid, integer, uuid, text, text, text, jsonb, numeric, integer, integer, text, timestamptz
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
  p_occurred_at timestamptz
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
    committed_at
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
    coalesce(p_occurred_at, clock_timestamp())
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

-- ── reveal_draw_v1 ──────────────────────────────────────────────────────────

drop function if exists public.reveal_draw_v1(
  uuid, text, text, text, text, integer, uuid, text, numeric, numeric, timestamptz
);

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

-- Grants for the new arities. These are the exact lines that were wrong in the
-- bank migration, so they are written immediately after the create rather than
-- collected at the end of the file where they can drift.
revoke all on function public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz) from public, anon;
revoke all on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) from public, anon;

grant execute on function public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz) to authenticated;
grant execute on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) to authenticated;
