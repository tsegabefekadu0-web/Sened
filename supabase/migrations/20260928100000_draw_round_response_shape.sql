-- Make the draw RPC response match what the application parses.
--
-- `src/lib/draw/repository.ts` (`parseRound`) reads
--   { commitment: { drawId, groupId, ..., commitment, memberDigest,
--                   memberCommitments, ... }, reveal: {...}|null, payout: {...}|null }
-- but `sened_draw_round_response` returned a flat object whose `commitment`
-- key was the hash string, and it left out the member digest, the sealed member
-- commitments and the revealed member nonces. Against a real PostgREST every
-- draw RPC therefore failed with "Draw storage returned no commitment", and a
-- round that did parse would not have verified (no member contributions).
--
-- Money fields are emitted as text ("2000.00"): a jsonb number would reach the
-- application as a JS number, and the ledger refuses non-string posting amounts.
--
-- Same signature as before, so every caller (commit, reveal, payout, get, list)
-- picks it up without being redefined. Idempotent: create or replace.

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
