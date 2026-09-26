-- M4 — Verifiably fair draw engine (እጣ).
--
-- Commit-reveal over SHA-256. A treasurer commits to a digest *before* the
-- ceremony; the seed is revealed after; any member recomputes the winner from
-- the published values alone. The commitment preimage binds the group, cycle,
-- round, draw id, roster digest, and public nonce, so the roster cannot be
-- edited after the fact without the digest ceasing to match.
--
-- Append-only by construction. `draw_commitments` accepts more than one row per
-- (cycle, round) on purpose: a treasurer who creates commitments and abandons
-- them has searched seeds for a preferred winner, and `count_draw_commitments_v1`
-- surfaces that count so the application can refuse to call such a draw final.
-- That residual grinding risk is documented, not hidden — see
-- docs/architecture/draw.md.
--
-- Payouts are never written here. `draw_payouts.ledger_entry_id` records the id
-- returned by `post_ledger_entry_v1`, so the money itself always goes through
-- the append-only hash-chained ledger.

create table if not exists public.draw_cycles (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  tenant_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  total_rounds integer not null check (total_rounds between 1 and 1000),
  pot_amount numeric(20, 2) not null check (pot_amount > 0),
  currency text not null default 'ETB' check (currency = 'ETB'),
  reserve_ratio_bps integer not null default 1000 check (
    reserve_ratio_bps >= 0 and reserve_ratio_bps <= 3333
  ),
  started_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint draw_cycles_id_group_key unique (id, group_id),
  constraint draw_cycles_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint draw_cycles_closed_shape_check check (
    (closed_at is null) or (closed_at >= started_at)
  )
);

create table if not exists public.draw_commitments (
  id uuid primary key default gen_random_uuid(),
  draw_id uuid not null,
  group_id uuid not null,
  tenant_id uuid not null,
  cycle_id uuid not null,
  round integer not null check (round between 1 and 1000),
  commitment text not null check (commitment ~ '^[0-9a-f]{64}$'),
  commitment_nonce text not null check (char_length(btrim(commitment_nonce)) between 16 and 256),
  roster_digest text not null check (roster_digest ~ '^[0-9a-f]{64}$'),
  participants jsonb not null check (jsonb_typeof(participants) = 'array'),
  pot_amount numeric(20, 2) not null check (pot_amount > 0),
  total_rounds integer not null check (total_rounds between 1 and 1000),
  reserve_ratio_bps integer not null check (
    reserve_ratio_bps >= 0 and reserve_ratio_bps <= 3333
  ),
  actor_id uuid not null references auth.users (id) on delete restrict,
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 128 and
    idempotency_key = btrim(idempotency_key) and
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  committed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  constraint draw_commitments_id_group_key unique (id, group_id),
  constraint draw_commitments_draw_id_key unique (draw_id),
  constraint draw_commitments_draw_commitment_key unique (draw_id, commitment),
  constraint draw_commitments_cycle_round_key unique (cycle_id, round, commitment),
  constraint draw_commitments_group_idempotency_key unique (group_id, idempotency_key),
  constraint draw_commitments_round_total_check check (round <= total_rounds),
  constraint draw_commitments_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint draw_commitments_cycle_group_fk
    foreign key (cycle_id, group_id)
    references public.draw_cycles (id, group_id)
    on delete restrict
);

create table if not exists public.draw_reveals (
  id uuid primary key default gen_random_uuid(),
  draw_id uuid not null,
  commitment text not null check (commitment ~ '^[0-9a-f]{64}$'),
  seed text not null check (char_length(btrim(seed)) between 16 and 256),
  transcript_digest text not null check (transcript_digest ~ '^[0-9a-f]{64}$'),
  selection_digest text not null check (selection_digest ~ '^[0-9a-f]{64}$'),
  selected_index integer not null check (selected_index >= 0),
  winner_member_id uuid not null,
  winning_ticket text not null check (winning_ticket ~ '^[0-9a-f]{64}$'),
  payout_amount numeric(20, 2) not null check (payout_amount > 0),
  reserve_amount numeric(20, 2) not null check (reserve_amount >= 0),
  actor_id uuid not null references auth.users (id) on delete restrict,
  revealed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  constraint draw_reveals_one_per_draw_key unique (draw_id),
  constraint draw_reveals_draw_winner_key unique (draw_id, winner_member_id)
);

create table if not exists public.draw_payouts (
  id uuid primary key default gen_random_uuid(),
  draw_id uuid not null,
  group_id uuid not null,
  tenant_id uuid not null,
  ledger_entry_id uuid not null,
  winner_member_id uuid not null,
  amount numeric(20, 2) not null check (amount > 0),
  reserve_amount numeric(20, 2) not null check (reserve_amount >= 0),
  actor_id uuid not null references auth.users (id) on delete restrict,
  posted_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  constraint draw_payouts_id_group_key unique (id, group_id),
  constraint draw_payouts_one_per_draw_key unique (draw_id),
  constraint draw_payouts_one_per_entry_key unique (ledger_entry_id),
  constraint draw_payouts_entry_group_fk
    foreign key (ledger_entry_id, group_id)
    references public.ledger_entries (id, group_id)
    on delete restrict,
  constraint draw_payouts_reveal_fk
    foreign key (draw_id, winner_member_id)
    references public.draw_reveals (draw_id, winner_member_id)
    on delete restrict,
  constraint draw_payouts_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict
);

create index if not exists draw_cycles_group_tenant_idx
  on public.draw_cycles (group_id, tenant_id);

create index if not exists draw_commitments_cycle_round_idx
  on public.draw_commitments (cycle_id, round, committed_at desc);

create index if not exists draw_commitments_actor_idx
  on public.draw_commitments (group_id, actor_id, committed_at desc);

create index if not exists draw_reveals_winner_idx
  on public.draw_reveals (winner_member_id, revealed_at desc);

create index if not exists draw_payouts_cycle_idx
  on public.draw_payouts (group_id, created_at desc);

alter table public.draw_cycles enable row level security;
alter table public.draw_commitments enable row level security;
alter table public.draw_reveals enable row level security;
alter table public.draw_payouts enable row level security;

create or replace function public.sened_draw_block_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'draw_history_immutable';
end;
$$;

-- PostgreSQL forbids subqueries in a check constraint, so the payout/reserve
-- split is validated on insert instead. A reveal that does not account for
-- exactly the committed pot is refused.
create or replace function public.sened_draw_validate_reveal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  committed_pot numeric(20, 2);
  eligible_count integer;
begin
  select commitment.pot_amount, jsonb_array_length(commitment.participants)
  into committed_pot, eligible_count
  from public.draw_commitments commitment
  where commitment.draw_id = new.draw_id
    and commitment.commitment = new.commitment;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
  end if;

  if new.payout_amount + new.reserve_amount <> committed_pot then
    raise exception using errcode = 'P0001', message = 'draw_payout_split_mismatch';
  end if;
  if new.selected_index >= eligible_count then
    raise exception using errcode = 'P0001', message = 'draw_selection_out_of_range';
  end if;
  return new;
end;
$$;

drop trigger if exists draw_cycles_block_mutation on public.draw_cycles;
create trigger draw_cycles_block_mutation
before update or delete on public.draw_cycles
for each row execute function public.sened_draw_block_mutation();

drop trigger if exists draw_commitments_block_mutation on public.draw_commitments;
create trigger draw_commitments_block_mutation
before update or delete on public.draw_commitments
for each row execute function public.sened_draw_block_mutation();

drop trigger if exists draw_reveals_block_mutation on public.draw_reveals;
create trigger draw_reveals_block_mutation
before update or delete on public.draw_reveals
for each row execute function public.sened_draw_block_mutation();

drop trigger if exists draw_payouts_block_mutation on public.draw_payouts;
create trigger draw_payouts_block_mutation
before update or delete on public.draw_payouts
for each row execute function public.sened_draw_block_mutation();

drop trigger if exists draw_reveals_validate_insert on public.draw_reveals;
create trigger draw_reveals_validate_insert
before insert on public.draw_reveals
for each row execute function public.sened_draw_validate_reveal();

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
    'drawId', commitment_row.draw_id,
    'groupId', commitment_row.group_id,
    'cycleId', commitment_row.cycle_id,
    'round', commitment_row.round,
    'commitment', commitment_row.commitment,
    'commitmentNonce', commitment_row.commitment_nonce,
    'rosterDigest', commitment_row.roster_digest,
    'participants', commitment_row.participants,
    'potAmount', commitment_row.pot_amount,
    'totalRounds', commitment_row.total_rounds,
    'reserveRatioBps', commitment_row.reserve_ratio_bps,
    'committedBy', commitment_row.actor_id,
    'committedAt', commitment_row.committed_at,
    'idempotencyKey', commitment_row.idempotency_key,
    'state', case
      when payout_row.id is not null then 'paid'
      when reveal_row.id is not null then 'revealed'
      else 'committed'
    end,
    'reveal', case
      when reveal_row.id is null then null
      else jsonb_build_object(
        'drawId', reveal_row.draw_id,
        'commitment', reveal_row.commitment,
        'seed', reveal_row.seed,
        'transcriptDigest', reveal_row.transcript_digest,
        'selectionDigest', reveal_row.selection_digest,
        'selectedIndex', reveal_row.selected_index,
        'winnerMemberId', reveal_row.winner_member_id,
        'winningTicket', reveal_row.winning_ticket,
        'payoutAmount', reveal_row.payout_amount,
        'reserveAmount', reveal_row.reserve_amount,
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
        'amount', payout_row.amount,
        'reserveAmount', payout_row.reserve_amount,
        'postedAt', payout_row.posted_at,
        'postedBy', payout_row.actor_id
      )
    end
  );
$$;

create or replace function public.commit_draw_v1(
  p_group_id uuid,
  p_cycle_id uuid,
  p_round integer,
  p_draw_id uuid,
  p_commitment text,
  p_commitment_nonce text,
  p_roster_digest text,
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

create or replace function public.reveal_draw_v1(
  p_draw_id uuid,
  p_seed text,
  p_commitment text,
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

create or replace function public.record_draw_payout_v1(
  p_draw_id uuid,
  p_ledger_entry_id uuid,
  p_winner_member_id uuid,
  p_amount numeric,
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
  payout_row public.draw_payouts;
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

  select reveal.*
  into reveal_row
  from public.draw_reveals reveal
  where reveal.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_committed';
  end if;
  if reveal_row.winner_member_id <> p_winner_member_id then
    raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
  end if;

  insert into public.draw_payouts (
    draw_id,
    group_id,
    tenant_id,
    ledger_entry_id,
    winner_member_id,
    amount,
    reserve_amount,
    actor_id,
    posted_at
  ) values (
    p_draw_id,
    commitment_row.group_id,
    commitment_row.tenant_id,
    p_ledger_entry_id,
    p_winner_member_id,
    p_amount,
    p_reserve_amount,
    actor,
    coalesce(p_occurred_at, clock_timestamp())
  )
  on conflict (draw_id) do nothing
  returning * into payout_row;

  if not found then
    raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
  end if;

  return public.sened_draw_round_response(commitment_row, reveal_row, payout_row);
end;
$$;

create or replace function public.get_draw_v1(p_draw_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.sened_draw_round_response(commitment.*, reveal.*, payout.*)
  from public.draw_commitments commitment
  left join public.draw_reveals reveal on reveal.draw_id = commitment.draw_id
  left join public.draw_payouts payout on payout.draw_id = commitment.draw_id
  where commitment.draw_id = p_draw_id
    and public.sened_ledger_can_access_group(commitment.group_id, commitment.tenant_id);
$$;

create or replace function public.get_draw_by_idempotency_key_v1(
  p_group_id uuid,
  p_idempotency_key text
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.sened_draw_round_response(commitment.*, reveal.*, payout.*)
  from public.draw_commitments commitment
  left join public.draw_reveals reveal on reveal.draw_id = commitment.draw_id
  left join public.draw_payouts payout on payout.draw_id = commitment.draw_id
  where commitment.group_id = p_group_id
    and commitment.idempotency_key = p_idempotency_key
    and public.sened_ledger_can_access_group(commitment.group_id, commitment.tenant_id);
$$;

create or replace function public.list_draw_cycle_v1(p_cycle_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      public.sened_draw_round_response(commitment.*, reveal.*, payout.*)
      order by commitment.round, commitment.committed_at
    ),
    '[]'::jsonb
  )
  from public.draw_commitments commitment
  left join public.draw_reveals reveal on reveal.draw_id = commitment.draw_id
  left join public.draw_payouts payout on payout.draw_id = commitment.draw_id
  where commitment.cycle_id = p_cycle_id
    and public.sened_ledger_can_access_group(commitment.group_id, commitment.tenant_id);
$$;

/**
 * Commitments recorded for a round, minus the live one. Any value above zero is
 * the observable signature of a treasurer who created commitments and abandoned
 * them, i.e. who searched seeds for a preferred winner. The application refuses
 * to call such a draw final.
 */
create or replace function public.count_draw_commitments_v1(p_draw_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(0, count(*) - 1)::integer
  from public.draw_commitments commitment
  where commitment.draw_id in (
    select sibling.draw_id
    from public.draw_commitments target
    join public.draw_commitments sibling
      on sibling.cycle_id = target.cycle_id
     and sibling.round = target.round
    where target.draw_id = p_draw_id
      and public.sened_ledger_can_access_group(sibling.group_id, sibling.tenant_id)
  );
$$;

drop policy if exists "draw cycles members read" on public.draw_cycles;
create policy "draw cycles members read"
on public.draw_cycles
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "draw commitments members read" on public.draw_commitments;
create policy "draw commitments members read"
on public.draw_commitments
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "draw reveals members read" on public.draw_reveals;
create policy "draw reveals members read"
on public.draw_reveals
for select
to authenticated
using (
  exists (
    select 1
    from public.draw_commitments commitment
    where commitment.draw_id = draw_reveals.draw_id
      and public.sened_ledger_can_access_group(commitment.group_id, commitment.tenant_id)
  )
);

drop policy if exists "draw payouts members read" on public.draw_payouts;
create policy "draw payouts members read"
on public.draw_payouts
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

revoke all on table public.draw_cycles from anon, authenticated;
revoke all on table public.draw_commitments from anon, authenticated;
revoke all on table public.draw_reveals from anon, authenticated;
revoke all on table public.draw_payouts from anon, authenticated;

grant select on table public.draw_cycles to authenticated;
grant select on table public.draw_commitments to authenticated;
grant select on table public.draw_reveals to authenticated;
grant select on table public.draw_payouts to authenticated;

revoke all on function public.sened_draw_block_mutation() from public, anon, authenticated;
revoke all on function public.sened_draw_validate_reveal() from public, anon, authenticated;
revoke all on function public.sened_draw_round_response(public.draw_commitments, public.draw_reveals, public.draw_payouts) from public, anon, authenticated;
revoke all on function public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, jsonb, numeric, integer, integer, text, timestamptz) from public, anon;
revoke all on function public.reveal_draw_v1(uuid, text, text, text, text, integer, uuid, text, numeric, numeric, timestamptz) from public, anon;
revoke all on function public.record_draw_payout_v1(uuid, uuid, uuid, numeric, numeric, timestamptz) from public, anon;
revoke all on function public.get_draw_v1(uuid) from public, anon;
revoke all on function public.get_draw_by_idempotency_key_v1(uuid, text) from public, anon;
revoke all on function public.list_draw_cycle_v1(uuid) from public, anon;
revoke all on function public.count_draw_commitments_v1(uuid) from public, anon;

grant execute on function public.sened_draw_block_mutation() to authenticated;
grant execute on function public.sened_draw_validate_reveal() to authenticated;
grant execute on function public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, jsonb, numeric, integer, integer, text, timestamptz) to authenticated;
grant execute on function public.reveal_draw_v1(uuid, text, text, text, text, integer, uuid, text, numeric, numeric, timestamptz) to authenticated;
grant execute on function public.record_draw_payout_v1(uuid, uuid, uuid, numeric, numeric, timestamptz) to authenticated;
grant execute on function public.get_draw_v1(uuid) to authenticated;
grant execute on function public.get_draw_by_idempotency_key_v1(uuid, text) to authenticated;
grant execute on function public.list_draw_cycle_v1(uuid) to authenticated;
grant execute on function public.count_draw_commitments_v1(uuid) to authenticated;
