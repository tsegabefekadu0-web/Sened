-- Draw integrity: the database derives the winner, one live draw per round, every
-- eligible member must seal, a deadline-bound cancel path, and an enforced reserve.
--
-- A review found that a treasurer could control or distort the outcome of a draw
-- even with protocol v3. This migration closes each hole IN SQL, because the
-- database is the only gate a treasurer holding an ordinary JWT cannot walk around
-- (the draw RPCs are reachable straight through PostgREST).
--
-- Decision: ONE NEW MIGRATION that redefines the affected functions, not an edit of
-- the earlier files. The earlier migrations are the history a deployed database may
-- already have applied; redefining here keeps each one readable as it was written.
-- Every statement is idempotent (the runner applies the whole set twice).
--
-- =================================================================================
-- 1. THE WINNER IS DERIVED BY THE DATABASE
-- =================================================================================
--
--   20260926110000_draw_reveal_binding.sql said the derivation was "deliberately not
--   reimplemented in SQL". That left selected_index, winner_member_id, the transcript
--   digest and the selection digest as claims the caller typed. A treasurer could name
--   any member as the winner, as long as that member stood at the index they typed.
--
--   Now (protocol v3 commitments):
--     sened_draw_nonce_set_digest  sened-draw-nonce-set-v1    = canonical.ts canonicalSerializeNonceSet
--     sened_draw_transcript_hash_v3 sened-draw-transcript-v3  = canonicalSerializeTranscript (v3)
--     sened_draw_accept_digest / sened_draw_select_index      = selectWinnerIndex (rejection sampling
--                                                               over 2^256, attempt counter, max 1000)
--     sened_draw_derive_v3         re-checks the seed against the commitment, every nonce against its
--                                  seal and the opened set against the sealed set, then returns the
--                                  nonce digest, transcript digest, selection digest and index.
--   The reveal trigger (sened_draw_validate_reveal) runs that derivation on EVERY insert into
--   draw_reveals, so reveal_draw_v1 and a direct insert are held to the same rule. The caller's
--   values are not ignored: they must EQUAL the computed ones, otherwise the reveal is refused
--   (draw_transcript_mismatch / draw_selection_mismatch / draw_winner_binding_mismatch). Equal-or-refuse
--   keeps an honest client's bug visible instead of silently papering over it.
--   Legacy v2 commitments keep the older rules (they cannot be created any more).
--   PARITY with the TypeScript engine is pinned by golden vectors that
--   test/draw.sql-parity.test.ts and scripts/verify-migrations.sql assert as the same literals.
--
-- =================================================================================
-- 2. ONE LIVE DRAW PER ROUND, NO RE-ROLL
-- =================================================================================
--
--   Before: open_draw_v1 only continued a draw still SEALING. Once a draw was committed
--   but not revealed it opened a NEW session for the same round, and a treasurer could
--   commit again with a different seed: a re-roll.
--
--   * open_draw_v1 refuses (draw_round_has_live_draw) while any committed, uncancelled and
--     unrevealed session exists for that cycle and round.
--   * Trigger draw_commitments_one_live: at most ONE non-cancelled commitment per
--     (cycle_id, round). A partial unique index cannot see the cancellations table, so the
--     rule is a validate trigger that first takes the cycle row lock (concurrent commits for
--     one cycle queue up and each sees the other).
--   * draw_reveals gets denormalised cycle_id and round (set by the reveal trigger, never by
--     the caller) and a UNIQUE index on (cycle_id, round): at most one reveal per round,
--     whatever happens to the sessions around it.
--
-- =================================================================================
-- 3. QUORUM: EVERY ELIGIBLE MEMBER MUST SEAL
-- =================================================================================
--
--   commit_draw_from_seals_v1 used to need ONE seal from somebody other than the
--   committer. It now needs a stored seal from EVERY member eligible for the session
--   (draw_member_commitment_missing otherwise). A seal from a member who is no longer
--   eligible is ignored, as before. The client shows "N of M sealed" and enables Commit
--   at M of M.
--   The client-supplied commit time is gone: committed_at is always clock_timestamp().
--
-- =================================================================================
-- 4. THE CANCEL PATH FOR MEMBERS WHO DO NOT RESPOND
-- =================================================================================
--
--   Members can stall a draw by never sealing, or by sealing and never releasing the
--   nonce. A treasurer must not be able to turn "cancel" into "re-roll". The design:
--
--   DEADLINES. draw_cycles.seal_window_hours and nonce_window_hours (default 48 each,
--   1..720, fixed at cycle creation; a cycle is immutable). open_draw_v1 stamps
--   draw_sessions.seal_deadline = now + seal window. commit_draw_from_seals_v1 stamps
--   draw_commitments.nonce_deadline = now + nonce window. Both rows are append-only and
--   no client role has UPDATE on them, so a treasurer cannot shorten either deadline
--   after the fact. Both are shown to every member.
--
--   BEFORE COMMIT (stage 'sealing'). Once the seal deadline has passed, an owner or
--   treasurer may cancel_draw_v1(draw, reason) with a reason of 10..1000 characters. The
--   eligible members who never sealed are recorded as MISSED. Cancelling when nobody
--   missed is refused (draw_cancel_nothing_missed): the draw should be committed.
--
--   AFTER COMMIT (stage 'committed'). A treasurer can NEVER cancel because they dislike
--   a result: nobody, the treasurer included, can compute the result before the nonces
--   are public, so there is no result to dislike, and once the reveal is opened the nonces
--   ARE public. Cancel is therefore allowed only when ALL of these hold:
--     - the nonce-release deadline has passed,
--     - at least one sealed member has still not released their nonce (recorded as MISSED),
--     - open_draw_reveal_v1 has NOT been called (draw_reveal_opened otherwise).
--   Once the reveal has been opened the draw MUST be finished. reveal_draw_v1 is open to
--   any owner or treasurer of the group, and the seed was published by the opening, so a
--   stalled opened reveal can be completed by any manager and cannot be abandoned.
--
--   AUDIT. draw_cancellations is append-only (no update, no delete, one row per session):
--   who, when, why, the stage, the deadline that had passed, the members who missed, and
--   whether an owner made the call past the limit. Every member of the group can read it
--   (RLS + list_draw_cancellations_v1 + the session view).
--
--   LIMIT. At most 2 cancels per (cycle, round) by a treasurer (sened_draw_cancel_limit()).
--   The third cancel, and the opening of a session after the second, needs a group OWNER
--   (draw_cancel_limit_reached for a treasurer); the cancellation row then carries
--   owner_decision = true. The limit stops a treasurer from cancelling until a result
--   they like appears, even with every deadline honoured.
--
--   RE-OPENING AND EXCLUDING NON-RESPONDERS. A new session for the same round MAY exclude
--   the members recorded as missed in earlier cancellations of that round, and ONLY them:
--   open_draw_v1(..., p_exclude_missed => true). The exclusion list is stored on the
--   session (draw_sessions.excluded_members), is part of the session view every member sees,
--   and removes those members from the round's eligible set (so they neither seal nor can
--   win THAT round; they stay in the group and are eligible again next round). A member who
--   answered cannot be excluded, and a treasurer cannot pick names. The pot is unchanged.
--
--   A cancelled session can never be committed, revealed or sealed into again
--   (draw_cancelled). Seals and nonces of a cancelled session stay private forever.
--   A committed-then-cancelled draw still counts as an abandoned commitment in
--   count_draw_commitments_v1, so verification keeps flagging it for a member vote.
--
-- =================================================================================
-- 5. PAYOUT SPLIT
-- =================================================================================
--
--   reserve = the cycle's reserve_ratio_bps applied to the committed pot, ROUNDED HALF UP
--   to 2 decimals (sened_draw_reserve_amount: floor((cents * bps + 5000) / 10000) cents),
--   and payout = pot - reserve. Enforced in the reveal trigger for v3 commitments:
--   draw_payout_split_mismatch for any other split. src/lib/draw/risk.ts uses the same rule.
--
-- DEPLOY ORDER: apply together with the application release. The previous application
-- sends p_occurred_at on commit (the argument is gone) and a seed-less commit body.

-- ---------------------------------------------------------------------------
-- A. Schema
-- ---------------------------------------------------------------------------
alter table public.draw_cycles
  add column if not exists seal_window_hours integer not null default 48,
  add column if not exists nonce_window_hours integer not null default 48;

alter table public.draw_cycles drop constraint if exists draw_cycles_seal_window_range;
alter table public.draw_cycles
  add constraint draw_cycles_seal_window_range check (seal_window_hours between 1 and 720);
alter table public.draw_cycles drop constraint if exists draw_cycles_nonce_window_range;
alter table public.draw_cycles
  add constraint draw_cycles_nonce_window_range check (nonce_window_hours between 1 and 720);

alter table public.draw_sessions
  add column if not exists seal_deadline timestamptz,
  add column if not exists excluded_members uuid[] not null default '{}';

alter table public.draw_commitments
  add column if not exists nonce_deadline timestamptz;

alter table public.draw_reveals
  add column if not exists cycle_id uuid,
  add column if not exists round integer;

-- Backfill rows that predate the columns. The history tables refuse UPDATE, so the
-- guard is lifted for this one statement each (the migration runs as the table owner).
alter table public.draw_sessions disable trigger draw_sessions_block_mutation;
update public.draw_sessions set seal_deadline = opened_at + interval '48 hours' where seal_deadline is null;
alter table public.draw_sessions enable trigger draw_sessions_block_mutation;

alter table public.draw_commitments disable trigger draw_commitments_block_mutation;
update public.draw_commitments set nonce_deadline = committed_at + interval '48 hours' where nonce_deadline is null;
alter table public.draw_commitments enable trigger draw_commitments_block_mutation;

alter table public.draw_reveals disable trigger draw_reveals_block_mutation;
update public.draw_reveals r
set cycle_id = c.cycle_id, round = c.round
from public.draw_commitments c
where c.draw_id = r.draw_id and (r.cycle_id is null or r.round is null);
alter table public.draw_reveals enable trigger draw_reveals_block_mutation;

alter table public.draw_sessions alter column seal_deadline set not null;
alter table public.draw_commitments alter column nonce_deadline set not null;
alter table public.draw_reveals alter column cycle_id set not null;
alter table public.draw_reveals alter column round set not null;

-- At most one reveal per (cycle, round).
create unique index if not exists draw_reveals_one_per_cycle_round_idx
  on public.draw_reveals (cycle_id, round);

comment on column public.draw_sessions.seal_deadline is
  'After this instant an owner/treasurer may cancel a still-sealing session. Set at open from the cycle; immutable.';
comment on column public.draw_sessions.excluded_members is
  'Members recorded as non-responders in an earlier cancellation of this round, excluded from this session by the opener. Visible to all.';
comment on column public.draw_commitments.nonce_deadline is
  'After this instant an owner/treasurer may cancel a committed draw whose reveal has not been opened and whose nonces are still missing. Immutable.';

create table if not exists public.draw_cancellations (
  id uuid primary key default gen_random_uuid(),
  draw_id uuid not null unique references public.draw_sessions (draw_id) on delete restrict,
  group_id uuid not null,
  tenant_id uuid not null,
  cycle_id uuid not null,
  round integer not null check (round between 1 and 1000),
  stage text not null check (stage in ('sealing', 'committed')),
  reason text not null check (char_length(reason) between 10 and 1000),
  missed_members jsonb not null check (
    jsonb_typeof(missed_members) = 'array' and jsonb_array_length(missed_members) >= 1
  ),
  deadline_at timestamptz not null,
  owner_decision boolean not null default false,
  cancelled_by uuid not null references auth.users (id) on delete restrict,
  cancelled_at timestamptz not null default clock_timestamp(),
  constraint draw_cancellations_cycle_group_fk
    foreign key (cycle_id, group_id)
    references public.draw_cycles (id, group_id)
    on delete restrict
);

create index if not exists draw_cancellations_cycle_round_idx
  on public.draw_cancellations (cycle_id, round, cancelled_at);

alter table public.draw_cancellations enable row level security;

drop trigger if exists draw_cancellations_block_mutation on public.draw_cancellations;
create trigger draw_cancellations_block_mutation
before update or delete on public.draw_cancellations
for each row execute function public.sened_draw_block_mutation();

drop policy if exists "draw cancellations members read" on public.draw_cancellations;
create policy "draw cancellations members read"
on public.draw_cancellations
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

revoke all on table public.draw_cancellations from anon, authenticated;
grant select on table public.draw_cancellations to authenticated;

-- ---------------------------------------------------------------------------
-- B. Derivation primitives (parity with src/lib/draw/canonical.ts)
-- ---------------------------------------------------------------------------
-- sened-draw-nonce-set-v1: every revealed (memberId, nonce), sorted by memberId in
-- byte order, bound to the draw.
create or replace function public.sened_draw_nonce_set_digest(
  p_draw_id uuid,
  p_nonces jsonb
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sened_draw_encode('sened-draw-nonce-set-v1') || E'\n' ||
      public.sened_draw_line('drawId', p_draw_id::text) ||
      coalesce((
        select string_agg(
          E'\n' ||
          public.sened_draw_line('nonce.' || (ordered.position - 1)::text || '.memberId', ordered.entry ->> 'memberId') || E'\n' ||
          public.sened_draw_line('nonce.' || (ordered.position - 1)::text || '.nonce', ordered.entry ->> 'nonce'),
          '' order by ordered.position
        )
        from (
          select
            item.entry as entry,
            row_number() over (order by item.entry ->> 'memberId' collate "C") as position
          from jsonb_array_elements(p_nonces) as item(entry)
        ) as ordered
      ), ''),
      'UTF8'
    )),
    'hex'
  );
$$;

-- sened-draw-transcript-v3: the preimage whose digest selects the winner.
create or replace function public.sened_draw_transcript_hash_v3(
  p_draw_id uuid,
  p_commitment text,
  p_roster_digest text,
  p_member_digest text,
  p_nonce_digest text,
  p_seed text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sened_draw_encode('sened-draw-transcript-v3') || E'\n' ||
      public.sened_draw_line('drawId', p_draw_id::text) || E'\n' ||
      public.sened_draw_line('commitment', p_commitment) || E'\n' ||
      public.sened_draw_line('rosterDigest', p_roster_digest) || E'\n' ||
      public.sened_draw_line('memberDigest', p_member_digest) || E'\n' ||
      public.sened_draw_line('nonceDigest', p_nonce_digest) || E'\n' ||
      public.sened_draw_line('seed', p_seed),
      'UTF8'
    )),
    'hex'
  );
$$;

-- sened-draw-selection-v1 hash for one attempt.
create or replace function public.sened_draw_selection_hash(
  p_transcript_digest text,
  p_attempt integer
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sened_draw_encode('sened-draw-selection-v1') || E'\n' ||
      public.sened_draw_line('transcriptDigest', p_transcript_digest) || E'\n' ||
      public.sened_draw_line('attempt', p_attempt::text),
      'UTF8'
    )),
    'hex'
  );
$$;

-- A 64-character lowercase hex string as an exact non-negative integer.
create or replace function public.sened_draw_hex_to_numeric(p_hex text)
returns numeric
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
declare
  acc numeric := 0;
  i integer;
begin
  for i in 1..char_length(p_hex) loop
    acc := acc * 16 + (position(substr(p_hex, i, 1) in '0123456789abcdef') - 1);
  end loop;
  return acc;
end;
$$;

-- Rejection sampling for ONE digest. A digest at or above the largest multiple of n
-- that fits in 256 bits is rejected (a plain `mod n` would favour the first
-- 2^256 mod n residues). Returns accepted = false and a null index when rejected.
create or replace function public.sened_draw_accept_digest(
  p_digest text,
  p_count integer,
  out accepted boolean,
  out selected_index integer
)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  modulus numeric;
  two256 numeric := 1;
  bound numeric;
  value numeric;
  i integer;
begin
  if p_count is null or p_count < 1 then
    raise exception using errcode = 'P0001', message = 'draw_no_eligible_participants';
  end if;
  modulus := p_count;
  for i in 1..256 loop
    two256 := two256 * 2;
  end loop;
  bound := two256 - mod(two256, modulus);
  value := public.sened_draw_hex_to_numeric(p_digest);
  if value < bound then
    accepted := true;
    selected_index := mod(value, modulus)::integer;
  else
    accepted := false;
    selected_index := null;
  end if;
end;
$$;

-- selectWinnerIndex: the first attempt whose digest is accepted wins; the attempt
-- counter is part of the hashed preimage. At most 1001 attempts (MAX_SELECTION_ROUNDS).
create or replace function public.sened_draw_select_index(
  p_transcript_digest text,
  p_count integer,
  out selected_index integer,
  out selection_digest text,
  out attempts integer
)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  attempt integer;
  digest text;
  verdict record;
begin
  for attempt in 0..1000 loop
    digest := public.sened_draw_selection_hash(p_transcript_digest, attempt);
    select * into verdict from public.sened_draw_accept_digest(digest, p_count);
    if verdict.accepted then
      selected_index := verdict.selected_index;
      selection_digest := digest;
      attempts := attempt + 1;
      return;
    end if;
  end loop;
  raise exception using errcode = 'P0001', message = 'draw_uniformity_exhausted';
end;
$$;

-- The whole derivation of a v3 draw: re-check the seed against the commitment, every
-- nonce against its seal, the opened set against the sealed set; then the digests and
-- the index. Raises (never returns a guess) when anything does not reproduce.
create or replace function public.sened_draw_derive_v3(
  p_commitment public.draw_commitments,
  p_seed text,
  p_nonces jsonb,
  out nonce_digest text,
  out transcript_digest text,
  out selection_digest text,
  out selected_index integer
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  sealed_count integer;
  picked record;
begin
  if p_commitment.protocol_version <> 'v3' then
    raise exception using errcode = 'P0001', message = 'draw_protocol_version_unsupported';
  end if;
  if p_nonces is null or jsonb_typeof(p_nonces) <> 'array' then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_nonces) as opened(entry)
    where jsonb_typeof(opened.entry) <> 'object'
       or jsonb_typeof(opened.entry -> 'memberId') is distinct from 'string'
       or jsonb_typeof(opened.entry -> 'nonce') is distinct from 'string'
  ) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
  end if;

  -- The sealed set can no longer be anything but what the commitment bound.
  if p_commitment.member_digest is distinct from
     public.sened_draw_member_set_digest(p_commitment.draw_id, p_commitment.member_commitments) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
  end if;

  -- The seed must reproduce the published commitment.
  if public.sened_draw_commit_hash_v3(
       p_commitment.group_id, p_commitment.cycle_id, p_commitment.round, p_commitment.draw_id,
       p_commitment.roster_digest, p_commitment.commitment_nonce, p_commitment.member_digest, p_seed
     ) is distinct from p_commitment.commitment then
    raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
  end if;

  -- The opened set is exactly the sealed set, each member once, each nonce opening its seal.
  sealed_count := jsonb_array_length(p_commitment.member_commitments);
  if jsonb_array_length(p_nonces) <> sealed_count
     or (select count(distinct opened.entry ->> 'memberId') from jsonb_array_elements(p_nonces) as opened(entry)) <> sealed_count then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_commitment.member_commitments) as sealed(entry)
    where not exists (
      select 1
      from jsonb_array_elements(p_nonces) as opened(entry)
      where opened.entry ->> 'memberId' = sealed.entry ->> 'memberId'
    )
  ) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_commitment.member_commitments) as sealed(entry)
    join jsonb_array_elements(p_nonces) as opened(entry)
      on opened.entry ->> 'memberId' = sealed.entry ->> 'memberId'
    where char_length(opened.entry ->> 'nonce') < 16
       or public.sened_draw_member_seal_hash(
            p_commitment.draw_id, (sealed.entry ->> 'memberId')::uuid, opened.entry ->> 'nonce'
          ) is distinct from sealed.entry ->> 'sealed'
  ) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
  end if;

  nonce_digest := public.sened_draw_nonce_set_digest(p_commitment.draw_id, p_nonces);
  transcript_digest := public.sened_draw_transcript_hash_v3(
    p_commitment.draw_id, p_commitment.commitment, p_commitment.roster_digest,
    p_commitment.member_digest, nonce_digest, p_seed
  );
  select * into picked
  from public.sened_draw_select_index(transcript_digest, jsonb_array_length(p_commitment.participants));
  selected_index := picked.selected_index;
  selection_digest := picked.selection_digest;
end;
$$;

-- reserve = pot x bps / 10000, rounded HALF UP to 2 decimals (to the cent).
create or replace function public.sened_draw_reserve_amount(p_pot numeric, p_bps integer)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select (floor((round(p_pot * 100) * p_bps + 5000) / 10000) / 100)::numeric(20, 2);
$$;

create or replace function public.sened_draw_cancel_limit()
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$ select 2; $$;

-- A group owner: the tenant owner, or an active member whose role is 'owner'.
create or replace function public.sened_draw_actor_is_owner(p_group_id uuid, p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.ledger_groups group_row
    where group_row.id = p_group_id
      and group_row.tenant_id = p_tenant_id
      and (
        group_row.tenant_id = auth.uid()
        or exists (
          select 1
          from public.ledger_group_memberships membership
          where membership.group_id = group_row.id
            and membership.tenant_id = group_row.tenant_id
            and membership.user_id = auth.uid()
            and membership.status = 'active'
            and membership.role = 'owner'
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- C. State, eligibility for a SESSION, and the session view
-- ---------------------------------------------------------------------------
create or replace function public.sened_draw_state(p_draw_id uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when exists (select 1 from public.draw_cancellations x where x.draw_id = p_draw_id) then 'cancelled'
    when exists (select 1 from public.draw_payouts po where po.draw_id = p_draw_id) then 'paid'
    when exists (select 1 from public.draw_reveals rv where rv.draw_id = p_draw_id) then 'revealed'
    when exists (select 1 from public.draw_commitments cm where cm.draw_id = p_draw_id) then 'committed'
    else 'sealing'
  end;
$$;

-- The members who may seal this session and exactly its roster: the round's eligible
-- members, minus those the opener excluded as recorded non-responders.
create or replace function public.sened_draw_session_eligible(p_draw_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.member_id
  from public.draw_sessions s
  cross join lateral public.sened_draw_eligible_members(s.group_id, s.cycle_id, s.round) as e(member_id)
  where s.draw_id = p_draw_id
    and not (e.member_id = any (s.excluded_members));
$$;

create or replace function public.sened_draw_cycle_json(cycle_row public.draw_cycles)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'cycleId', cycle_row.id,
    'groupId', cycle_row.group_id,
    'name', cycle_row.name,
    'contributionAmount', cycle_row.contribution_amount::text,
    'potAmount', cycle_row.pot_amount::text,
    'totalRounds', cycle_row.total_rounds,
    'reserveRatioBps', cycle_row.reserve_ratio_bps,
    'startedAt', cycle_row.started_at,
    'closedAt', cycle_row.closed_at,
    'createdAt', cycle_row.created_at,
    'roundsRevealed', progress.revealed,
    'roundsPaid', progress.paid,
    'nextRound', case when progress.revealed < cycle_row.total_rounds then progress.revealed + 1 else null end,
    'contributionGate', public.sened_draw_cycle_gate(cycle_row.id),
    'sealWindowHours', cycle_row.seal_window_hours,
    'nonceWindowHours', cycle_row.nonce_window_hours
  )
  from (
    select
      (
        select count(distinct cm.round)
        from public.draw_commitments cm
        join public.draw_reveals rv on rv.draw_id = cm.draw_id
        where cm.cycle_id = cycle_row.id
      ) as revealed,
      (
        select count(distinct cm.round)
        from public.draw_commitments cm
        join public.draw_payouts po on po.draw_id = cm.draw_id
        where cm.cycle_id = cycle_row.id
      ) as paid
  ) as progress;
$$;

create or replace function public.sened_draw_cancellation_json(p_row public.draw_cancellations)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'cancellationId', p_row.id,
    'drawId', p_row.draw_id,
    'cycleId', p_row.cycle_id,
    'round', p_row.round,
    'stage', p_row.stage,
    'reason', p_row.reason,
    'missedMembers', p_row.missed_members,
    'deadlineAt', p_row.deadline_at,
    'ownerDecision', p_row.owner_decision,
    'cancelledBy', p_row.cancelled_by,
    'cancelledAt', p_row.cancelled_at
  );
$$;

create or replace function public.sened_draw_session_view(p_draw_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  sess public.draw_sessions;
  cyc public.draw_cycles;
  com public.draw_commitments;
  cancel_row public.draw_cancellations;
  opening public.draw_reveal_openings;
  is_committed boolean;
  eligible_ids jsonb;
  seal_rows jsonb;
  nonce_rows jsonb;
begin
  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    return null;
  end if;
  select cy.* into cyc from public.draw_cycles cy where cy.id = sess.cycle_id;
  select c.* into com from public.draw_commitments c where c.draw_id = p_draw_id;
  is_committed := found;
  select x.* into cancel_row from public.draw_cancellations x where x.draw_id = p_draw_id;
  select o.* into opening from public.draw_reveal_openings o where o.draw_id = p_draw_id;

  if is_committed then
    select coalesce(jsonb_agg(item.entry ->> 'memberId' order by item.entry ->> 'memberId'), '[]'::jsonb)
    into eligible_ids
    from jsonb_array_elements(com.participants) as item(entry);

    seal_rows := com.member_commitments;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'memberId', sealed_item.entry ->> 'memberId',
          'released', exists (
            select 1 from public.draw_nonces n
            where n.draw_id = p_draw_id
              and n.member_id::text = sealed_item.entry ->> 'memberId'
          )
        )
        order by sealed_item.entry ->> 'memberId'
      ),
      '[]'::jsonb
    )
    into nonce_rows
    from jsonb_array_elements(com.member_commitments) as sealed_item(entry);
  else
    select coalesce(jsonb_agg(e.member_id order by e.member_id), '[]'::jsonb)
    into eligible_ids
    from public.sened_draw_session_eligible(p_draw_id) as e(member_id);

    select coalesce(
      jsonb_agg(
        jsonb_build_object('memberId', se.member_id, 'sealed', se.sealed, 'sealedAt', se.sealed_at)
        order by se.member_id::text collate "C"
      ),
      '[]'::jsonb
    )
    into seal_rows
    from public.draw_seals se
    where se.draw_id = p_draw_id;

    nonce_rows := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'drawId', sess.draw_id,
    'groupId', sess.group_id,
    'cycleId', sess.cycle_id,
    'round', sess.round,
    'state', public.sened_draw_state(sess.draw_id),
    'openedBy', sess.opened_by,
    'openedAt', sess.opened_at,
    'committedAt', case when is_committed then com.committed_at else null end,
    'cycle', public.sened_draw_cycle_json(cyc),
    'eligible', eligible_ids,
    'seals', seal_rows,
    'nonces', nonce_rows,
    'revealRequested', opening.draw_id is not null,
    'sealDeadline', sess.seal_deadline,
    'nonceDeadline', case when is_committed then com.nonce_deadline else null end,
    'excluded', to_jsonb(sess.excluded_members),
    'cancelsThisRound', (
      select count(*) from public.draw_cancellations x
      where x.cycle_id = sess.cycle_id and x.round = sess.round
    ),
    'cancellation', case when cancel_row.id is null then null else public.sened_draw_cancellation_json(cancel_row) end,
    -- The seed is public from the instant the reveal is opened, so a manager other than the
    -- opener can finish the draw.
    'revealOpening', case
      when opening.draw_id is null then null
      else jsonb_build_object('seed', opening.seed, 'openedBy', opening.opened_by, 'openedAt', opening.opened_at)
    end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- D. Cycles carry the windows
-- ---------------------------------------------------------------------------
drop function if exists public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text);

create or replace function public.create_draw_cycle_v1(
  p_group_id uuid,
  p_name text,
  p_contribution_amount numeric,
  p_total_rounds integer,
  p_reserve_ratio_bps integer,
  p_started_at timestamptz,
  p_idempotency_key text,
  p_contribution_gate text default 'off',
  p_seal_window_hours integer default null,
  p_nonce_window_hours integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
  clean_name text := btrim(coalesce(p_name, ''));
  seal_hours integer := coalesce(p_seal_window_hours, 48);
  nonce_hours integer := coalesce(p_nonce_window_hours, 48);
  member_count integer;
  created_row public.draw_cycles;
  existing_row public.draw_cycles;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select group_row.tenant_id
  into tenant
  from public.ledger_groups group_row
  where group_row.id = p_group_id;
  -- An unknown group and a group the caller cannot manage read the same.
  if not found or not public.sened_ledger_can_manage_group(p_group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  if char_length(clean_name) not between 1 and 120
     or p_contribution_amount is null
     or p_contribution_amount <= 0
     or p_contribution_amount > 1000000000
     or p_contribution_amount <> round(p_contribution_amount, 2)
     or p_total_rounds is null
     or p_total_rounds not between 1 and 1000
     or p_reserve_ratio_bps is null
     or p_reserve_ratio_bps not between 0 and 3333
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_contribution_gate is null
     or p_contribution_gate not in ('off', 'warn', 'block')
     or seal_hours not between 1 and 720
     or nonce_hours not between 1 and 720
     or (p_started_at is not null and (
       p_started_at < timestamptz '2000-01-01 00:00:00+00'
       or p_started_at >= timestamptz '2101-01-01 00:00:00+00'
     )) then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;

  select count(*)::integer
  into member_count
  from public.ledger_group_memberships membership
  where membership.group_id = p_group_id and membership.status = 'active';

  -- Rotation draws each member at most once per cycle, so more rounds than
  -- members could never be filled.
  if p_total_rounds > member_count then
    raise exception using errcode = 'P0001', message = 'draw_cycle_rounds_exceed_members';
  end if;

  insert into public.draw_cycles (
    group_id, tenant_id, name, total_rounds, pot_amount, reserve_ratio_bps,
    started_at, contribution_amount, created_by, idempotency_key, contribution_gate,
    seal_window_hours, nonce_window_hours
  ) values (
    p_group_id, tenant, clean_name, p_total_rounds,
    round(p_contribution_amount * member_count, 2),
    p_reserve_ratio_bps,
    coalesce(p_started_at, clock_timestamp()),
    round(p_contribution_amount, 2),
    actor,
    p_idempotency_key,
    p_contribution_gate,
    seal_hours,
    nonce_hours
  )
  on conflict (group_id, idempotency_key) where idempotency_key is not null do nothing
  returning * into created_row;

  if not found then
    select cy.*
    into existing_row
    from public.draw_cycles cy
    where cy.group_id = p_group_id and cy.idempotency_key = p_idempotency_key;
    if not found
       or existing_row.name <> clean_name
       or existing_row.contribution_amount is distinct from round(p_contribution_amount, 2)
       or existing_row.total_rounds <> p_total_rounds
       or existing_row.reserve_ratio_bps <> p_reserve_ratio_bps
       or existing_row.contribution_gate <> p_contribution_gate
       or existing_row.seal_window_hours <> seal_hours
       or existing_row.nonce_window_hours <> nonce_hours then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    return jsonb_build_object('cycle', public.sened_draw_cycle_json(existing_row), 'replayed', true);
  end if;

  return jsonb_build_object('cycle', public.sened_draw_cycle_json(created_row), 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- E. Opening a draw: one live draw per round, the cancel limit, exclusion
-- ---------------------------------------------------------------------------
drop function if exists public.open_draw_v1(uuid, integer, text, text);

create or replace function public.open_draw_v1(
  p_cycle_id uuid,
  p_round integer,
  p_idempotency_key text,
  p_override_reason text default null,
  p_exclude_missed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  cyc public.draw_cycles;
  tenant uuid;
  revealed_rounds integer;
  next_round integer;
  existing_row public.draw_sessions;
  live_row public.draw_sessions;
  created_row public.draw_sessions;
  clean_override text := btrim(p_override_reason);
  gate_policy text;
  flagged jsonb := '[]'::jsonb;
  overridden boolean := false;
  cancel_count integer;
  excluded uuid[] := '{}';
  remaining integer;
  stamp timestamptz := clock_timestamp();
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select cy.* into cyc from public.draw_cycles cy where cy.id = p_cycle_id;
  if found then
    select group_row.tenant_id into tenant
    from public.ledger_groups group_row where group_row.id = cyc.group_id;
  end if;
  if not found or not public.sened_ledger_can_manage_group(cyc.group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;
  -- A supplied override reason must be a real one, whether or not it ends up needed.
  if p_override_reason is not null and char_length(clean_override) not between 10 and 1000 then
    raise exception using errcode = 'P0001', message = 'draw_override_reason_invalid';
  end if;

  -- Serialise concurrent opens (and commits) for one cycle.
  perform 1 from public.draw_cycles locked where locked.id = p_cycle_id for update;

  if cyc.closed_at is not null then
    raise exception using errcode = 'P0001', message = 'draw_cycle_closed';
  end if;

  select s.* into existing_row
  from public.draw_sessions s
  where s.group_id = cyc.group_id and s.idempotency_key = p_idempotency_key;
  if found then
    if existing_row.cycle_id <> cyc.id or (p_round is not null and existing_row.round <> p_round) then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    return jsonb_build_object(
      'session', public.sened_draw_session_view(existing_row.draw_id),
      'replayed', true
    );
  end if;

  select coalesce(max(cm.round), 0)
  into revealed_rounds
  from public.draw_commitments cm
  join public.draw_reveals rv on rv.draw_id = cm.draw_id
  where cm.cycle_id = cyc.id;
  next_round := revealed_rounds + 1;

  if next_round > cyc.total_rounds then
    raise exception using errcode = 'P0001', message = 'draw_cycle_complete';
  end if;
  if p_round is not null and p_round <> next_round then
    if p_round >= 1 and p_round <= revealed_rounds then
      raise exception using errcode = 'P0001', message = 'draw_already_revealed';
    end if;
    raise exception using errcode = 'P0001', message = 'draw_round_out_of_order';
  end if;

  -- NO RE-ROLL. A committed draw that has not been revealed or cancelled is THE draw for
  -- this round: nothing new is opened over it. The only way out is the deadline-bound
  -- cancel, which is audited and limited.
  if exists (
    select 1
    from public.draw_commitments cm
    where cm.cycle_id = cyc.id
      and cm.round = next_round
      and not exists (select 1 from public.draw_cancellations x where x.draw_id = cm.draw_id)
      and not exists (select 1 from public.draw_reveals rv where rv.draw_id = cm.draw_id)
  ) then
    raise exception using errcode = 'P0001', message = 'draw_round_has_live_draw';
  end if;

  -- A draw still sealing for this round is continued, not duplicated (and not gated
  -- again: nothing new is being opened).
  select s.* into live_row
  from public.draw_sessions s
  where s.cycle_id = cyc.id
    and s.round = next_round
    and not exists (select 1 from public.draw_commitments cm where cm.draw_id = s.draw_id)
    and not exists (select 1 from public.draw_cancellations x where x.draw_id = s.draw_id)
  order by s.opened_at desc
  limit 1;
  if found then
    return jsonb_build_object(
      'session', public.sened_draw_session_view(live_row.draw_id),
      'replayed', true
    );
  end if;

  -- THE CANCEL LIMIT. After the limit a treasurer cannot open another session for this
  -- round: only a group owner can, and that is the explicit act.
  select count(*)::integer into cancel_count
  from public.draw_cancellations x
  where x.cycle_id = cyc.id and x.round = next_round;
  if cancel_count >= public.sened_draw_cancel_limit()
     and not public.sened_draw_actor_is_owner(cyc.group_id, cyc.tenant_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancel_limit_reached';
  end if;

  -- EXCLUDING NON-RESPONDERS: only members recorded as missed in an earlier cancellation of
  -- THIS round, never anyone else, and never a name the opener typed.
  if coalesce(p_exclude_missed, false) then
    select coalesce(array_agg(distinct (missed.entry #>> '{}')::uuid), '{}')
    into excluded
    from public.draw_cancellations x
    cross join lateral jsonb_array_elements(x.missed_members) as missed(entry)
    where x.cycle_id = cyc.id and x.round = next_round;
    if cardinality(excluded) = 0 then
      raise exception using errcode = 'P0001', message = 'draw_invalid_request';
    end if;
    select count(*)::integer into remaining
    from public.sened_draw_eligible_members(cyc.group_id, cyc.id, next_round) as e(member_id)
    where not (e.member_id = any (excluded));
    if remaining < 1 then
      raise exception using errcode = 'P0001', message = 'draw_no_eligible_participants';
    end if;
  end if;

  -- THE GATE. A new draw would be created for round next_round.
  gate_policy := public.sened_draw_cycle_gate(cyc.id);
  if gate_policy <> 'off' then
    flagged := public.sened_draw_cycle_gate_flags(cyc.id, next_round);
    if gate_policy = 'block' and jsonb_array_length(flagged) > 0 then
      if p_override_reason is null then
        raise exception using
          errcode = 'P0001',
          message = 'draw_contribution_gate_blocked',
          detail = flagged::text;
      end if;
      overridden := true;
    end if;
  end if;

  -- One instant for both, so the deadline is EXACTLY opened_at + the cycle's window.
  insert into public.draw_sessions (
    group_id, tenant_id, cycle_id, round, opened_by, idempotency_key, opened_at, seal_deadline, excluded_members
  ) values (
    cyc.group_id, cyc.tenant_id, cyc.id, next_round, actor, p_idempotency_key,
    stamp,
    stamp + make_interval(hours => cyc.seal_window_hours),
    excluded
  )
  returning * into created_row;

  if overridden then
    insert into public.draw_contribution_gate_overrides (
      cycle_id, group_id, tenant_id, round, draw_id, actor_id, reason, flagged
    ) values (
      cyc.id, cyc.group_id, cyc.tenant_id, next_round, created_row.draw_id, actor, clean_override, flagged
    );
  end if;

  return jsonb_build_object(
    'session', public.sened_draw_session_view(created_row.draw_id),
    'replayed', false,
    'contributionGate', jsonb_build_object(
      'policy', gate_policy,
      'flagged', flagged,
      'overridden', overridden
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- F. Seals and nonces: never into a cancelled session; eligibility is the session's
-- ---------------------------------------------------------------------------
create or replace function public.submit_draw_seal_v1(p_draw_id uuid, p_sealed text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sess public.draw_sessions;
  previous text;
  stored_at timestamptz;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_found';
  end if;
  if not exists (
    select 1 from public.ledger_group_memberships membership
    where membership.group_id = sess.group_id
      and membership.tenant_id = sess.tenant_id
      and membership.user_id = actor
      and membership.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  -- Serialise with the commit and the cancel: a seal either lands before them (and is in
  -- the committed set) or is refused after.
  perform 1 from public.draw_sessions locked where locked.draw_id = p_draw_id for share;

  if p_sealed is null or p_sealed !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;
  if exists (select 1 from public.draw_cancellations x where x.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancelled';
  end if;
  if exists (select 1 from public.draw_commitments cm where cm.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_already_committed';
  end if;
  if not exists (
    select 1 from public.sened_draw_session_eligible(p_draw_id) as e(member_id)
    where e.member_id = actor
  ) then
    raise exception using errcode = 'P0001', message = 'draw_not_eligible';
  end if;

  select se.sealed into previous
  from public.draw_seals se
  where se.draw_id = p_draw_id and se.member_id = actor;

  insert into public.draw_seals (draw_id, member_id, sealed)
  values (p_draw_id, actor, p_sealed)
  on conflict (draw_id, member_id) do update
    set sealed = excluded.sealed, sealed_at = clock_timestamp()
    where public.draw_seals.sealed is distinct from excluded.sealed;

  select se.sealed_at into stored_at
  from public.draw_seals se
  where se.draw_id = p_draw_id and se.member_id = actor;

  return jsonb_build_object(
    'drawId', p_draw_id,
    'memberId', actor,
    'sealed', p_sealed,
    'replaced', previous is not null and previous <> p_sealed,
    'unchanged', previous is not null and previous = p_sealed,
    'sealedAt', stored_at
  );
end;
$$;

create or replace function public.submit_draw_nonce_v1(p_draw_id uuid, p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sess public.draw_sessions;
  com public.draw_commitments;
  my_seal text;
  inserted boolean;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_found';
  end if;
  if not exists (
    select 1 from public.ledger_group_memberships membership
    where membership.group_id = sess.group_id
      and membership.tenant_id = sess.tenant_id
      and membership.user_id = actor
      and membership.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  perform 1 from public.draw_sessions locked where locked.draw_id = p_draw_id for share;

  if exists (select 1 from public.draw_cancellations x where x.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancelled';
  end if;

  -- THE ORDERING THE FAIRNESS RESTS ON: a nonce is accepted only once the
  -- commitment that fixes everything else is published.
  select c.* into com from public.draw_commitments c where c.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_nonce_too_early';
  end if;
  if exists (select 1 from public.draw_reveal_openings o where o.draw_id = p_draw_id)
     or exists (select 1 from public.draw_reveals rv where rv.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_already_revealed';
  end if;

  if p_nonce is null or (char_length(p_nonce) not between 16 and 256 or p_nonce !~ '^[!-~]+$') then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;

  -- Only the caller's OWN committed seal is ever consulted.
  select sealed_item.entry ->> 'sealed'
  into my_seal
  from jsonb_array_elements(com.member_commitments) as sealed_item(entry)
  where sealed_item.entry ->> 'memberId' = actor::text;
  if my_seal is null then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;

  if public.sened_draw_member_seal_hash(p_draw_id, actor, p_nonce) <> my_seal then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
  end if;

  insert into public.draw_nonces (draw_id, member_id, nonce)
  values (p_draw_id, actor, p_nonce)
  on conflict (draw_id, member_id) do nothing;
  inserted := found;

  return jsonb_build_object(
    'drawId', p_draw_id,
    'memberId', actor,
    'released', true,
    'replayed', not inserted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- G. Commit: every eligible member has sealed; the time is the database's
-- ---------------------------------------------------------------------------
-- The previous arity carried p_occurred_at (a client-supplied time). It is dropped, not
-- overloaded, so PostgREST has exactly one function of the name.
drop function if exists public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text);

create or replace function public.commit_draw_from_seals_v1(
  p_draw_id uuid,
  p_commitment text,
  p_commitment_nonce text,
  p_roster_digest text,
  p_member_digest text,
  p_participants jsonb,
  p_idempotency_key text,
  p_protocol_version text,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sess public.draw_sessions;
  cyc public.draw_cycles;
  existing_row public.draw_commitments;
  created_row public.draw_commitments;
  existing_reveal public.draw_reveals;
  existing_payout public.draw_payouts;
  eligible_count integer;
  sealed_set jsonb;
  seal_count integer;
  clean_override text := btrim(p_override_reason);
  gate_policy text;
  flagged jsonb := '[]'::jsonb;
  acknowledged jsonb := '[]'::jsonb;
  carried_over boolean := false;
  overridden boolean := false;
  stamp timestamptz := clock_timestamp();
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_found';
  end if;
  if not public.sened_ledger_can_manage_group(sess.group_id, sess.tenant_id) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  -- Serialise with seal and nonce submission and with the cancel, then read the seals.
  perform 1 from public.draw_sessions locked where locked.draw_id = p_draw_id for update;

  if p_protocol_version is distinct from 'v3' then
    raise exception using errcode = 'P0001', message = 'draw_protocol_version_unsupported';
  end if;
  if p_commitment is null or p_commitment !~ '^[0-9a-f]{64}$'
     or p_roster_digest is null or p_roster_digest !~ '^[0-9a-f]{64}$'
     or p_member_digest is null or p_member_digest !~ '^[0-9a-f]{64}$'
     or p_commitment_nonce is null or (char_length(p_commitment_nonce) not between 16 and 256 or p_commitment_nonce !~ '^[!-~]+$')
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;
  -- A supplied override reason must be a real one, whether or not it ends up needed.
  if p_override_reason is not null and char_length(clean_override) not between 10 and 1000 then
    raise exception using errcode = 'P0001', message = 'draw_override_reason_invalid';
  end if;

  select c.* into existing_row from public.draw_commitments c where c.draw_id = p_draw_id;
  if found then
    if existing_row.idempotency_key = p_idempotency_key
       and existing_row.commitment = p_commitment
       and existing_row.member_digest is not distinct from p_member_digest then
      select rv.* into existing_reveal from public.draw_reveals rv where rv.draw_id = p_draw_id;
      select po.* into existing_payout from public.draw_payouts po where po.draw_id = p_draw_id;
      return jsonb_build_object(
        'round', public.sened_draw_round_response(existing_row, existing_reveal, existing_payout),
        'replayed', true
      );
    end if;
    raise exception using errcode = 'P0001', message = 'draw_already_committed';
  end if;

  if exists (select 1 from public.draw_cancellations x where x.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancelled';
  end if;

  -- Serialise with every other commit and open for this cycle, then refuse a second live
  -- commitment for the round. (draw_commitments_one_live enforces the same at the table.)
  select cy.* into cyc from public.draw_cycles cy where cy.id = sess.cycle_id for update;
  if sess.round > cyc.total_rounds then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;
  if exists (
    select 1
    from public.draw_commitments other
    where other.cycle_id = sess.cycle_id
      and other.round = sess.round
      and other.draw_id <> p_draw_id
      and not exists (select 1 from public.draw_cancellations x where x.draw_id = other.draw_id)
  ) then
    raise exception using errcode = 'P0001', message = 'draw_round_has_live_draw';
  end if;

  -- Rotation is only sound when every earlier round is already revealed.
  if exists (
    select 1
    from generate_series(1, sess.round - 1) as earlier(n)
    where not exists (
      select 1
      from public.draw_commitments cm
      join public.draw_reveals rv on rv.draw_id = cm.draw_id
      where cm.cycle_id = sess.cycle_id and cm.round = earlier.n
    )
  ) then
    raise exception using errcode = 'P0001', message = 'draw_round_out_of_order';
  end if;

  -- The roster is not typed: it is exactly this session's eligible members (active, not
  -- yet drawn this cycle, not excluded as recorded non-responders), each at the cycle's
  -- contribution, each with their derived ticket.
  select count(*)::integer into eligible_count
  from public.sened_draw_session_eligible(p_draw_id);
  if eligible_count < 1 then
    raise exception using errcode = 'P0001', message = 'draw_no_eligible_participants';
  end if;
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception using errcode = 'P0001', message = 'draw_roster_mismatch';
  end if;
  if jsonb_array_length(p_participants) <> eligible_count
     or (
       select count(distinct item.entry ->> 'memberId')
       from jsonb_array_elements(p_participants) as item(entry)
     ) <> eligible_count
     or exists (
       select 1
       from jsonb_array_elements(p_participants) as item(entry)
       where not exists (
         select 1
         from public.sened_draw_session_eligible(p_draw_id) as e(member_id)
         where e.member_id::text = item.entry ->> 'memberId'
       )
     ) then
    raise exception using errcode = 'P0001', message = 'draw_roster_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_participants) as item(entry)
    where item.entry ->> 'ticket' is distinct from
          public.sened_draw_ticket(sess.group_id, sess.cycle_id, (item.entry ->> 'memberId')::uuid)
       or (
         cyc.contribution_amount is not null
         and item.entry ->> 'contributionAmount' is distinct from cyc.contribution_amount::text
       )
  ) then
    raise exception using errcode = 'P0001', message = 'draw_roster_mismatch';
  end if;

  -- THE SEALED SET IS WHATEVER IS STORED. Nothing the caller sends can add, drop or alter a
  -- seal. Seals from members no longer eligible are not used.
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object('memberId', se.member_id, 'sealed', se.sealed)
        order by se.member_id::text collate "C"
      ),
      '[]'::jsonb
    ),
    count(*)::integer
  into sealed_set, seal_count
  from public.draw_seals se
  where se.draw_id = p_draw_id
    and exists (
      select 1
      from public.sened_draw_session_eligible(p_draw_id) as e(member_id)
      where e.member_id = se.member_id
    );

  -- QUORUM: EVERY eligible member must have sealed. A committer who waits for fewer is
  -- choosing whose randomness counts.
  if seal_count <> eligible_count then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;
  if p_member_digest is distinct from public.sened_draw_member_set_digest(p_draw_id, sealed_set) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
  end if;

  -- THE GATE, AGAIN. The policy and the flags are read now, not as they were when the
  -- draw was opened. Serialised with policy changes and opens (the cycle row is locked).
  gate_policy := public.sened_draw_cycle_gate(sess.cycle_id);
  if gate_policy <> 'off' then
    flagged := public.sened_draw_cycle_gate_flags(sess.cycle_id, sess.round);
    if gate_policy = 'block' and jsonb_array_length(flagged) > 0 then
      -- An override given when the draw was opened still stands for the pairs it named:
      -- the set may shrink (a payment recorded) but not gain a pair.
      acknowledged := public.sened_draw_open_override_flags(p_draw_id);
      if public.sened_draw_flags_covered(flagged, acknowledged) then
        carried_over := true;
      elsif p_override_reason is null then
        raise exception using
          errcode = 'P0001',
          message = 'draw_contribution_gate_blocked',
          detail = flagged::text;
      else
        overridden := true;
      end if;
    end if;
  end if;

  insert into public.draw_commitments (
    draw_id, group_id, tenant_id, cycle_id, round, commitment, commitment_nonce,
    roster_digest, member_digest, member_commitments, participants,
    pot_amount, total_rounds, reserve_ratio_bps, actor_id, idempotency_key,
    committed_at, protocol_version, nonce_deadline
  ) values (
    p_draw_id, sess.group_id, sess.tenant_id, sess.cycle_id, sess.round, p_commitment,
    p_commitment_nonce, p_roster_digest, p_member_digest, sealed_set, p_participants,
    cyc.pot_amount, cyc.total_rounds, cyc.reserve_ratio_bps, actor, p_idempotency_key,
    stamp, 'v3', stamp + make_interval(hours => cyc.nonce_window_hours)
  )
  on conflict (group_id, idempotency_key) do nothing
  returning * into created_row;

  if not found then
    -- The key belongs to a different draw in this group.
    raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
  end if;

  if overridden then
    insert into public.draw_contribution_gate_overrides (
      cycle_id, group_id, tenant_id, round, draw_id, actor_id, reason, flagged, stage
    ) values (
      sess.cycle_id, sess.group_id, sess.tenant_id, sess.round, p_draw_id, actor, clean_override, flagged, 'commit'
    );
  end if;

  return jsonb_build_object(
    'round', public.sened_draw_round_response(created_row, null, null),
    'replayed', false,
    'contributionGate', jsonb_build_object(
      'policy', gate_policy,
      'flagged', flagged,
      'overridden', overridden,
      'carriedOver', carried_over
    )
  );
end;
$$;

-- At most one non-cancelled commitment per (cycle, round), at the table. The cycle row is
-- locked first, so two concurrent commits for one cycle queue and each sees the other.
create or replace function public.sened_draw_guard_live_commitment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  window_hours integer;
begin
  select locked.nonce_window_hours into window_hours
  from public.draw_cycles locked where locked.id = new.cycle_id for update;
  -- The deadline is the database's, whatever a direct insert supplied.
  new.nonce_deadline := new.committed_at + make_interval(hours => coalesce(window_hours, 48));
  if exists (
    select 1
    from public.draw_commitments other
    where other.cycle_id = new.cycle_id
      and other.round = new.round
      and other.draw_id <> new.draw_id
      and not exists (select 1 from public.draw_cancellations x where x.draw_id = other.draw_id)
  ) then
    raise exception using errcode = 'P0001', message = 'draw_round_has_live_draw';
  end if;
  return new;
end;
$$;

drop trigger if exists draw_commitments_one_live on public.draw_commitments;
create trigger draw_commitments_one_live
before insert on public.draw_commitments
for each row execute function public.sened_draw_guard_live_commitment();

-- ---------------------------------------------------------------------------
-- H. Requesting the reveal: never on a cancelled draw
-- ---------------------------------------------------------------------------
create or replace function public.open_draw_reveal_v1(p_draw_id uuid, p_seed text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sess public.draw_sessions;
  com public.draw_commitments;
  opening public.draw_reveal_openings;
  stored_nonces jsonb;
  stored_count integer;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_found';
  end if;
  if not public.sened_ledger_can_manage_group(sess.group_id, sess.tenant_id) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  perform 1 from public.draw_sessions locked where locked.draw_id = p_draw_id for update;

  select c.* into com from public.draw_commitments c where c.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_committed';
  end if;
  if exists (select 1 from public.draw_cancellations x where x.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancelled';
  end if;
  if exists (select 1 from public.draw_reveals rv where rv.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_already_revealed';
  end if;
  if p_seed is null or (char_length(p_seed) not between 16 and 256 or p_seed !~ '^[!-~]+$') then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;
  if com.protocol_version <> 'v3' then
    raise exception using errcode = 'P0001', message = 'draw_protocol_version_unsupported';
  end if;

  select o.* into opening from public.draw_reveal_openings o where o.draw_id = p_draw_id;
  if found then
    -- A retry with the same seed replays; a different seed never replaces it.
    if opening.seed <> p_seed then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    return jsonb_build_object(
      'drawId', p_draw_id,
      'seed', opening.seed,
      'memberNonces', opening.member_nonces,
      'replayed', true
    );
  end if;

  -- The seed must reproduce the published commitment BEFORE anything is read, so
  -- that a junk seed cannot be used to extract the nonces and walk away.
  if public.sened_draw_commit_hash_v3(
       com.group_id, com.cycle_id, com.round, com.draw_id, com.roster_digest,
       com.commitment_nonce, com.member_digest, p_seed
     ) <> com.commitment then
    raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object('memberId', n.member_id, 'nonce', n.nonce)
        order by n.member_id::text collate "C"
      ),
      '[]'::jsonb
    ),
    count(*)::integer
  into stored_nonces, stored_count
  from public.draw_nonces n
  where n.draw_id = p_draw_id
    and exists (
      select 1
      from jsonb_array_elements(com.member_commitments) as sealed_item(entry)
      where sealed_item.entry ->> 'memberId' = n.member_id::text
    );

  -- Every sealed member must have released a nonce. Refusing here discloses
  -- nothing: who has released is already public in the session view.
  if stored_count <> jsonb_array_length(com.member_commitments) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;

  insert into public.draw_reveal_openings (draw_id, seed, member_nonces, opened_by)
  values (p_draw_id, p_seed, stored_nonces, actor);

  return jsonb_build_object(
    'drawId', p_draw_id,
    'seed', p_seed,
    'memberNonces', stored_nonces,
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- I. The reveal trigger: the derivation, the split, one reveal per round
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
  expected_reserve numeric(20, 2);
  derived record;
begin
  select commitment.*
  into committed_row
  from public.draw_commitments commitment
  where commitment.draw_id = new.draw_id
    and commitment.commitment = new.commitment;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
  end if;

  -- The reveal's round is the commitment's, never the caller's.
  new.cycle_id := committed_row.cycle_id;
  new.round := committed_row.round;

  if exists (select 1 from public.draw_cancellations x where x.draw_id = new.draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancelled';
  end if;

  -- ONE REVEAL PER ROUND, whichever draw it is for.
  if exists (
    select 1 from public.draw_reveals other
    where other.cycle_id = committed_row.cycle_id
      and other.round = committed_row.round
      and other.draw_id <> new.draw_id
  ) then
    raise exception using errcode = 'P0001', message = 'draw_round_already_revealed';
  end if;

  if committed_row.protocol_version = 'v3' then
    -- THE SPLIT: reserve = the cycle's ratio of the committed pot, rounded half up to the
    -- cent; payout = pot - reserve.
    expected_reserve := public.sened_draw_reserve_amount(committed_row.pot_amount, committed_row.reserve_ratio_bps);
    if new.reserve_amount <> expected_reserve
       or new.payout_amount <> committed_row.pot_amount - expected_reserve then
      raise exception using errcode = 'P0001', message = 'draw_payout_split_mismatch';
    end if;

    -- THE WINNER IS DERIVED HERE. Whatever the caller typed must equal it.
    select * into derived
    from public.sened_draw_derive_v3(committed_row, new.seed, new.member_nonces);
    if new.transcript_digest is distinct from derived.transcript_digest then
      raise exception using errcode = 'P0001', message = 'draw_transcript_mismatch';
    end if;
    if new.selection_digest is distinct from derived.selection_digest
       or new.selected_index is distinct from derived.selected_index then
      raise exception using errcode = 'P0001', message = 'draw_selection_mismatch';
    end if;
  else
    if new.payout_amount + new.reserve_amount <> committed_row.pot_amount then
      raise exception using errcode = 'P0001', message = 'draw_payout_split_mismatch';
    end if;
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

-- ---------------------------------------------------------------------------
-- J. Cancel, and the cancellation listing
-- ---------------------------------------------------------------------------
create or replace function public.cancel_draw_v1(p_draw_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sess public.draw_sessions;
  com public.draw_commitments;
  existing_cancel public.draw_cancellations;
  created public.draw_cancellations;
  clean_reason text := btrim(coalesce(p_reason, ''));
  stage_name text;
  deadline timestamptz;
  missed jsonb;
  prior_cancels integer;
  by_owner boolean;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_found';
  end if;
  if not public.sened_ledger_can_manage_group(sess.group_id, sess.tenant_id) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;
  if char_length(clean_reason) not between 10 and 1000 then
    raise exception using errcode = 'P0001', message = 'draw_cancel_reason_invalid';
  end if;

  -- Serialise with seals, nonces, the commit, the reveal request and a re-open.
  perform 1 from public.draw_sessions locked where locked.draw_id = p_draw_id for update;
  perform 1 from public.draw_cycles locked where locked.id = sess.cycle_id for update;

  select x.* into existing_cancel from public.draw_cancellations x where x.draw_id = p_draw_id;
  if found then
    return jsonb_build_object('cancellation', public.sened_draw_cancellation_json(existing_cancel), 'replayed', true);
  end if;

  if exists (select 1 from public.draw_reveals rv where rv.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_already_revealed';
  end if;

  select c.* into com from public.draw_commitments c where c.draw_id = p_draw_id;
  if not found then
    -- BEFORE COMMIT: only after the seal deadline, and only for members who did not seal.
    stage_name := 'sealing';
    deadline := sess.seal_deadline;
    if clock_timestamp() < deadline then
      raise exception using errcode = 'P0001', message = 'draw_cancel_too_early';
    end if;
    select coalesce(jsonb_agg(e.member_id order by e.member_id::text collate "C"), '[]'::jsonb)
    into missed
    from public.sened_draw_session_eligible(p_draw_id) as e(member_id)
    where not exists (
      select 1 from public.draw_seals se where se.draw_id = p_draw_id and se.member_id = e.member_id
    );
  else
    -- AFTER COMMIT: never because of a result. Only when the nonce-release deadline has
    -- passed, a nonce is still missing, and the reveal has NOT been opened.
    stage_name := 'committed';
    deadline := com.nonce_deadline;
    if exists (select 1 from public.draw_reveal_openings o where o.draw_id = p_draw_id) then
      raise exception using errcode = 'P0001', message = 'draw_reveal_opened';
    end if;
    if clock_timestamp() < deadline then
      raise exception using errcode = 'P0001', message = 'draw_cancel_too_early';
    end if;
    select coalesce(jsonb_agg((sealed_item.entry ->> 'memberId') order by sealed_item.entry ->> 'memberId'), '[]'::jsonb)
    into missed
    from jsonb_array_elements(com.member_commitments) as sealed_item(entry)
    where not exists (
      select 1 from public.draw_nonces n
      where n.draw_id = p_draw_id and n.member_id::text = sealed_item.entry ->> 'memberId'
    );
  end if;

  if jsonb_array_length(missed) = 0 then
    raise exception using errcode = 'P0001', message = 'draw_cancel_nothing_missed';
  end if;

  select count(*)::integer into prior_cancels
  from public.draw_cancellations x
  where x.cycle_id = sess.cycle_id and x.round = sess.round;
  by_owner := public.sened_draw_actor_is_owner(sess.group_id, sess.tenant_id);
  if prior_cancels >= public.sened_draw_cancel_limit() and not by_owner then
    raise exception using errcode = 'P0001', message = 'draw_cancel_limit_reached';
  end if;

  insert into public.draw_cancellations (
    draw_id, group_id, tenant_id, cycle_id, round, stage, reason, missed_members,
    deadline_at, owner_decision, cancelled_by
  ) values (
    p_draw_id, sess.group_id, sess.tenant_id, sess.cycle_id, sess.round, stage_name, clean_reason, missed,
    deadline, prior_cancels >= public.sened_draw_cancel_limit(), actor
  )
  returning * into created;

  return jsonb_build_object('cancellation', public.sened_draw_cancellation_json(created), 'replayed', false);
end;
$$;

create or replace function public.list_draw_cancellations_v1(p_cycle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  cyc public.draw_cycles;
  tenant uuid;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;
  select cy.* into cyc from public.draw_cycles cy where cy.id = p_cycle_id;
  if found then
    select group_row.tenant_id into tenant from public.ledger_groups group_row where group_row.id = cyc.group_id;
  end if;
  if not found or not public.sened_ledger_can_access_group(cyc.group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;
  return coalesce(
    (
      select jsonb_agg(public.sened_draw_cancellation_json(x) order by x.round, x.cancelled_at)
      from public.draw_cancellations x
      where x.cycle_id = p_cycle_id
    ),
    '[]'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- K. reveal_draw_v1: same signature. The trigger is the gate; this function refuses a
--    cancelled draw early and otherwise keeps the stored-opening binding.
-- ---------------------------------------------------------------------------
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
  opening_row public.draw_reveal_openings;
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
  if exists (select 1 from public.draw_cancellations x where x.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancelled';
  end if;

  -- A draw that has a session carries stored nonces: the reveal can be nothing
  -- other than what open_draw_reveal_v1 published.
  if exists (select 1 from public.draw_sessions s where s.draw_id = p_draw_id) then
    select o.* into opening_row from public.draw_reveal_openings o where o.draw_id = p_draw_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
    end if;
    if opening_row.seed <> p_seed then
      raise exception using errcode = 'P0001', message = 'draw_commitment_mismatch';
    end if;
    if p_member_nonces is null
       or jsonb_typeof(p_member_nonces) <> 'array'
       or jsonb_array_length(p_member_nonces) <> jsonb_array_length(opening_row.member_nonces)
       or exists (
         select 1
         from jsonb_array_elements(p_member_nonces) as supplied(entry)
         where not exists (
           select 1
           from jsonb_array_elements(opening_row.member_nonces) as stored(entry)
           where stored.entry ->> 'memberId' = supplied.entry ->> 'memberId'
             and stored.entry ->> 'nonce' = supplied.entry ->> 'nonce'
         )
       ) then
      raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
    end if;
  end if;

  -- The reveal must open every contribution the commitment sealed.
  if commitment_row.member_digest is not null then
    if p_member_nonces is null
       or jsonb_typeof(p_member_nonces) <> 'array'
       or jsonb_array_length(p_member_nonces) <> jsonb_array_length(commitment_row.member_commitments) then
      raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
    end if;
    if p_member_digest is distinct from commitment_row.member_digest then
      raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
    end if;

    -- Protocol v3: the opened set must be exactly the sealed set.
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

  -- Rotation, enforced in the database as well as in the application.
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

  -- The insert fires sened_draw_validate_reveal: the seed, every nonce, the transcript,
  -- the selection, the winner, the split and the one-reveal-per-round rule are all
  -- re-derived there, from the stored commitment.
  insert into public.draw_reveals (
    draw_id, commitment, seed, member_digest, member_nonces, transcript_digest,
    selection_digest, selected_index, winner_member_id, winning_ticket,
    payout_amount, reserve_amount, actor_id, revealed_at
  ) values (
    p_draw_id, p_commitment, p_seed,
    coalesce(p_member_digest, commitment_row.member_digest),
    p_member_nonces, p_transcript_digest, p_selection_digest, p_selected_index,
    p_winner_member_id, p_winning_ticket, p_payout_amount, p_reserve_amount,
    actor, coalesce(p_occurred_at, clock_timestamp())
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

-- ---------------------------------------------------------------------------
-- L. Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.sened_draw_nonce_set_digest(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.sened_draw_transcript_hash_v3(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.sened_draw_selection_hash(text, integer) from public, anon, authenticated;
revoke all on function public.sened_draw_hex_to_numeric(text) from public, anon, authenticated;
revoke all on function public.sened_draw_accept_digest(text, integer) from public, anon, authenticated;
revoke all on function public.sened_draw_select_index(text, integer) from public, anon, authenticated;
revoke all on function public.sened_draw_derive_v3(public.draw_commitments, text, jsonb) from public, anon, authenticated;
revoke all on function public.sened_draw_reserve_amount(numeric, integer) from public, anon, authenticated;
revoke all on function public.sened_draw_cancel_limit() from public, anon, authenticated;
revoke all on function public.sened_draw_actor_is_owner(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_session_eligible(uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_cancellation_json(public.draw_cancellations) from public, anon, authenticated;
revoke all on function public.sened_draw_guard_live_commitment() from public, anon, authenticated;
revoke all on function public.sened_draw_state(uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_cycle_json(public.draw_cycles) from public, anon, authenticated;
revoke all on function public.sened_draw_session_view(uuid) from public, anon, authenticated;

revoke all on function public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text, integer, integer) from public, anon;
revoke all on function public.open_draw_v1(uuid, integer, text, text, boolean) from public, anon;
revoke all on function public.submit_draw_seal_v1(uuid, text) from public, anon;
revoke all on function public.submit_draw_nonce_v1(uuid, text) from public, anon;
revoke all on function public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, text, text) from public, anon;
revoke all on function public.open_draw_reveal_v1(uuid, text) from public, anon;
revoke all on function public.cancel_draw_v1(uuid, text) from public, anon;
revoke all on function public.list_draw_cancellations_v1(uuid) from public, anon;
revoke all on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) from public, anon;

grant execute on function public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text, integer, integer) to authenticated;
grant execute on function public.open_draw_v1(uuid, integer, text, text, boolean) to authenticated;
grant execute on function public.submit_draw_seal_v1(uuid, text) to authenticated;
grant execute on function public.submit_draw_nonce_v1(uuid, text) to authenticated;
grant execute on function public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, text, text) to authenticated;
grant execute on function public.open_draw_reveal_v1(uuid, text) to authenticated;
grant execute on function public.cancel_draw_v1(uuid, text) to authenticated;
grant execute on function public.list_draw_cancellations_v1(uuid) to authenticated;
grant execute on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) to authenticated;
