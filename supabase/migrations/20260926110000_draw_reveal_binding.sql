-- Draw reveal and payout binding.
--
-- AGENT-3's `20260926100000_draw_commit_reveal.sql` built correct commit-reveal
-- cryptography, but the database did not enforce it. `reveal_draw_v1` and
-- `record_draw_payout_v1` are `security definer` and were granted to
-- `authenticated`, so a treasurer holding an ordinary user JWT could call them
-- directly through PostgREST and write a forged, permanently unalterable row.
--
-- Two holes are closed here.
--
-- 1. The reveal trigger checked only three things: that a commitment row
--    existed, that `payout_amount + reserve_amount = pot`, and that
--    `selected_index < jsonb_array_length(participants)`. It never checked that
--    `winner_member_id` was the member actually standing at `selected_index`.
--    Any treasurer could name any winner.
--
-- 2. Every prior-winner check filtered on `round < current round`
--    (`reveal_draw_v1`, `service.ts`, `routeHandlers.ts`). Nothing required
--    rounds to be revealed in ascending order, so a treasurer could reveal round
--    5 first, then round 2 with the round-5 winner still eligible, and defeat
--    all three layers of rotation with no cryptographic attack at all.
--
-- What is deliberately NOT claimed here
--
-- This migration cannot verify that `selected_index` *derives from the seed*.
-- Doing so in SQL would mean reimplementing `canonicalSerializeDrawSeed` and
-- the rejection sampler from `src/lib/draw/canonical.ts` a second time, in
-- plpgsql, where a single byte of drift would reject honest reveals. That
-- binding therefore remains enforced by `verifyRound` in the application, which
-- is the reviewed implementation. A member verifying a transcript with
-- `verifyTranscript` checks the seed-to-index binding end to end, because that
-- check happens on their own device rather than on a server anyone controls.
--
-- Until that is duplicated and differentially tested, the honest statement of
-- the guarantee is: the database pins the winner to the committed roster and
-- enforces rotation order; the seed-to-index binding is enforced in the
-- application and is independently checkable by any member.

-- ---------------------------------------------------------------------------
-- Ticket-ordered participant lookup
--
-- `orderParticipants` in src/lib/draw/canonical.ts sorts by `ticket`, then by
-- `memberId`. Tickets are 64-character lowercase hex, so a byte-wise sort
-- matches the JavaScript string comparison, and `collate "C"` guarantees
-- byte order rather than a locale's collation. Tickets are derived from
-- memberId, so the sort is total and the lookup is unambiguous.
-- ---------------------------------------------------------------------------
create or replace function public.sened_draw_ordered_participant(
  p_participants jsonb,
  p_index integer
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select ordered.entry
  from (
    select item.entry as entry
    from jsonb_array_elements(p_participants) as item(entry)
    order by
      item.entry ->> 'ticket' collate "C",
      item.entry ->> 'memberId' collate "C"
  ) as ordered
  offset greatest(p_index, 0)
  limit 1;
$$;

revoke all on function public.sened_draw_ordered_participant(jsonb, integer) from public, anon;
-- Intentionally NOT granted to authenticated: it is a trigger-internal helper,
-- never called directly over the wire.

-- ---------------------------------------------------------------------------
-- Reveal binding
-- ---------------------------------------------------------------------------
create or replace function public.sened_draw_validate_reveal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  committed_row public.draw_commitments;
  expected_participant jsonb;
  prior_unrevealed integer;
begin
  select commitment.*
  into committed_row
  from public.draw_commitments commitment
  where commitment.draw_id = new.draw_id
    and commitment.commitment = new.commitment;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
  end if;

  if new.payout_amount + new.reserve_amount <> committed_row.pot_amount then
    raise exception using errcode = 'P0001', message = 'draw_payout_split_mismatch';
  end if;

  if new.selected_index < 0
     or new.selected_index >= jsonb_array_length(committed_row.participants) then
    raise exception using errcode = 'P0001', message = 'draw_selection_out_of_range';
  end if;

  -- The winner must be the member standing at this index in the committed
  -- ticket order. Without this, `winner_member_id` is an unverified claim.
  expected_participant :=
    public.sened_draw_ordered_participant(committed_row.participants, new.selected_index);
  if expected_participant is null then
    raise exception using errcode = 'P0001', message = 'draw_selection_out_of_range';
  end if;
  if (expected_participant ->> 'memberId')::uuid <> new.winner_member_id then
    raise exception using errcode = 'P0001', message = 'draw_winner_binding_mismatch';
  end if;
  if expected_participant ->> 'ticket' <> new.winning_ticket then
    raise exception using errcode = 'P0001', message = 'draw_winning_ticket_mismatch';
  end if;

  -- Rotation soundness. The prior-winner exclusion only looks at lower rounds,
  -- so it is only sound if every lower round has already been revealed.
  select count(*) into prior_unrevealed
  from public.draw_commitments sibling
  where sibling.cycle_id = committed_row.cycle_id
    and sibling.round < committed_row.round
    and not exists (
      select 1
      from public.draw_reveals prior
      where prior.draw_id = sibling.draw_id
    );
  if prior_unrevealed > 0 then
    raise exception using errcode = 'P0001', message = 'draw_round_out_of_order';
  end if;

  return new;
end;
$$;

-- The existing `before insert` trigger on draw_reveals already points at this
-- function name, so replacing the body is enough; no trigger recreation needed.

-- ---------------------------------------------------------------------------
-- Payout binding
--
-- `draw_payouts` had no validate trigger at all, so `amount` and
-- `reserve_amount` were free. A caller could book an amount that disagreed with
-- the reveal it claims to settle.
-- ---------------------------------------------------------------------------
create or replace function public.sened_draw_validate_payout()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  reveal_row public.draw_reveals;
begin
  select reveal.*
  into reveal_row
  from public.draw_reveals reveal
  where reveal.draw_id = new.draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_revealed';
  end if;

  if reveal_row.winner_member_id <> new.winner_member_id then
    raise exception using errcode = 'P0001', message = 'draw_winner_binding_mismatch';
  end if;

  if new.amount <> reveal_row.payout_amount
     or new.reserve_amount <> reveal_row.reserve_amount then
    raise exception using errcode = 'P0001', message = 'draw_payout_amount_mismatch';
  end if;

  return new;
end;
$$;

drop trigger if exists draw_payouts_validate on public.draw_payouts;
create trigger draw_payouts_validate
  before insert on public.draw_payouts
  for each row execute function public.sened_draw_validate_payout();

revoke all on function public.sened_draw_validate_payout() from public, anon, authenticated;
-- Trigger functions are never invoked directly; granting execute would be
-- meaningless. `sened_draw_validate_reveal` is likewise left ungranted, which
-- is consistent with how the bank migration treats its trigger functions.
