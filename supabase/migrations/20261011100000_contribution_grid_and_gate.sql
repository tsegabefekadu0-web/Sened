-- M4.2 follow-up: per-round contribution status for EVERY member and EVERY round,
-- and a per-cycle gate so that an unmet round can hold up the next draw.
--
-- A. THE GRID (derived, never stored)
--
--   get_draw_cycle_collateral_v1 (20261010100000) derived met / flagged / not_due
--   only for a winner's rounds AFTER their win. This migration generalises that one
--   derivation into sened_draw_cycle_member_rounds(cycle [, member]), which yields a
--   status for every (member, round) of the cycle, and rebuilds the collateral view
--   on top of it, so there is ONE implementation of the rule.
--
--   Who is in the grid: the group's ACTIVE members, plus every member who won a round
--   of the cycle (a winner who has since left still has obligations; they are marked
--   inactive, and the gate ignores inactive members).
--
--   Status of (member, round r):
--
--     met      a qualifying contribution is assigned to the round;
--     flagged  NOT met, and the round is DUE;
--     not_due  NOT met, and the round is not due yet.
--
--   There is deliberately NO `partial` status. A contribution that moved less than
--   the cycle's contribution into POT_CASH does not qualify (it never did, §17.3), and
--   splitting amounts across rounds would need a policy nobody has decided (is 150 of
--   100 one round plus a half? does 60 + 40 pay a round?). One qualifying entry pays
--   one round; an entry that falls short is simply not counted, and the round stays
--   flagged until a full payment is attributed. Overpayment does not carry over.
--
--   DUE (the same for every member, winner or not): round r is due once the draw for
--   round r has been OPENED (a draw_sessions row, or a legacy commitment, exists for
--   it). This is exactly the rule the collateral view already used for a winner's later
--   rounds, now applied to every round.
--
--   QUALIFYING CONTRIBUTION (unchanged, sened_collateral_member_entries): a contribution
--   entry that is not reversed by a correction; is attributed to the member (bank
--   provenance, else the current treasurer record); moved at least the cycle's
--   contribution into POT_CASH; was RECORDED (server time) on or after the cycle's
--   start; and is not attributed to a different cycle.
--
--   ASSIGNMENT. An entry whose attribution names this cycle AND round pays that round
--   (even one not yet due, which is then `met`). Otherwise, by order: the member's
--   remaining entries, oldest first, each fill the earliest unmet DUE round r such that
--   the entry was recorded after round r-1 had been revealed (round 1 has no previous
--   reveal: only the cycle's start applies). One entry pays one round.
--
--   WINNERS (so that nothing about the existing collateral view changes). For a member
--   who has won at round w with reveal time W, the entries are split at W:
--     * recorded AFTER W: they can only pay rounds after w, by the rule above, exactly as
--       before this migration;
--     * recorded AT OR BEFORE W: they can only pay rounds up to and including w.
--   So a payment made after a member's win is never taken by one of their earlier
--   rounds; a late payment for an earlier flagged round needs an explicit cycle+round
--   attribution. (Letting it take the earliest unmet round would have moved a winner's
--   post-win rounds from met to flagged whenever an earlier round was unpaid, which is
--   a change to existing collateral output; it would also flap, because which round an
--   entry pays would depend on whether a later round had been opened yet.) A member who
--   has not won has no such split.
--
-- B. THE GATE
--
--   draw_cycles.contribution_gate: 'off' (default, and every existing cycle), 'warn' or
--   'block', chosen at cycle creation. draw_cycles is append-only, so the column is the
--   INITIAL policy and the effective policy is the latest row of the append-only
--   draw_cycle_gate_events (who, when, from, to, a 10..1000 character reason), written by
--   set_draw_cycle_contribution_gate_v1 (owner/treasurer).
--
--   ENFORCEMENT POINT: open_draw_v1, at the moment a NEW draw session would be created
--   for round R. Gate input = every ACTIVE member's `flagged` cell for a round < R.
--     off    nothing is computed.
--     warn   the server allows it (the screen shows the rounds and asks for a confirm);
--            the flagged rounds are returned in the result.
--     block  refused with `draw_contribution_gate_blocked` (P0001, DETAIL = a JSON array
--            of {memberId, round}), unless the caller supplies p_override_reason
--            (10..1000 characters). The override is written, in the same transaction as
--            the session, to the append-only draw_contribution_gate_overrides (who, when,
--            reason, round, the draw, and exactly which flagged rounds were overridden).
--   Why open and not commit: opening is the decision point. It is also when round R
--   becomes due (the flag clock) and when members start sealing; refusing at commit would
--   let a treasurer open the ceremony, collect every member's seal and nonce preparation
--   and only then discover the block. One override record per opened draw. Continuing a
--   draw that is already sealing for the round, and replaying an open by idempotency
--   key, return the existing session and are not gated again (nothing new is opened).
--   Residual: a flag that appears AFTER the draw was opened (a reversal) is not re-checked
--   at commit; the grid keeps showing it.
--
-- create_draw_cycle_v1 and open_draw_v1 gain an optional trailing parameter. Because
-- `create or replace` with a different argument list would leave the old arity as an
-- overload (PostgREST cannot choose between them), the old signatures are dropped first,
-- exactly as the bank and commit migrations did.
--
-- DEPLOY ORDER: apply this migration together with the application release; the new
-- application sends p_contribution_gate and p_override_reason.

-- ---------------------------------------------------------------------------
-- 1. Policy column and the append-only audit tables
-- ---------------------------------------------------------------------------
alter table public.draw_cycles
  add column if not exists contribution_gate text not null default 'off';

alter table public.draw_cycles
  drop constraint if exists draw_cycles_contribution_gate_check;
alter table public.draw_cycles
  add constraint draw_cycles_contribution_gate_check
  check (contribution_gate in ('off', 'warn', 'block'));

comment on column public.draw_cycles.contribution_gate is
  'INITIAL contribution gate policy (off | warn | block). The effective policy is the latest draw_cycle_gate_events row, if any (sened_draw_cycle_gate).';

create table if not exists public.draw_cycle_gate_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  cycle_id uuid not null,
  group_id uuid not null,
  tenant_id uuid not null,
  from_gate text not null check (from_gate in ('off', 'warn', 'block')),
  to_gate text not null check (to_gate in ('off', 'warn', 'block')),
  actor_id uuid not null references auth.users (id) on delete restrict,
  reason text not null check (char_length(btrim(reason)) between 10 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  constraint draw_cycle_gate_events_changed check (from_gate <> to_gate),
  constraint draw_cycle_gate_events_cycle_group_fk
    foreign key (cycle_id, group_id)
    references public.draw_cycles (id, group_id)
    on delete restrict,
  constraint draw_cycle_gate_events_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict
);

create index if not exists draw_cycle_gate_events_cycle_seq_idx
  on public.draw_cycle_gate_events (cycle_id, seq);

create table if not exists public.draw_contribution_gate_overrides (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  group_id uuid not null,
  tenant_id uuid not null,
  round integer not null check (round between 1 and 1000),
  draw_id uuid not null unique references public.draw_sessions (draw_id) on delete restrict,
  actor_id uuid not null references auth.users (id) on delete restrict,
  reason text not null check (char_length(btrim(reason)) between 10 and 1000),
  flagged jsonb not null check (jsonb_typeof(flagged) = 'array' and jsonb_array_length(flagged) >= 1),
  created_at timestamptz not null default clock_timestamp(),
  constraint draw_gate_overrides_cycle_group_fk
    foreign key (cycle_id, group_id)
    references public.draw_cycles (id, group_id)
    on delete restrict,
  constraint draw_gate_overrides_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict
);

create index if not exists draw_gate_overrides_cycle_idx
  on public.draw_contribution_gate_overrides (cycle_id, created_at);

alter table public.draw_cycle_gate_events enable row level security;
alter table public.draw_contribution_gate_overrides enable row level security;

create or replace function public.sened_gate_block_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'gate_history_immutable';
end;
$$;

drop trigger if exists draw_cycle_gate_events_block_mutation on public.draw_cycle_gate_events;
create trigger draw_cycle_gate_events_block_mutation
before update or delete on public.draw_cycle_gate_events
for each row execute function public.sened_gate_block_mutation();

drop trigger if exists draw_cycle_gate_events_block_truncate on public.draw_cycle_gate_events;
create trigger draw_cycle_gate_events_block_truncate
before truncate on public.draw_cycle_gate_events
for each statement execute function public.sened_gate_block_mutation();

drop trigger if exists draw_gate_overrides_block_mutation on public.draw_contribution_gate_overrides;
create trigger draw_gate_overrides_block_mutation
before update or delete on public.draw_contribution_gate_overrides
for each row execute function public.sened_gate_block_mutation();

drop trigger if exists draw_gate_overrides_block_truncate on public.draw_contribution_gate_overrides;
create trigger draw_gate_overrides_block_truncate
before truncate on public.draw_contribution_gate_overrides
for each statement execute function public.sened_gate_block_mutation();

drop policy if exists "draw gate events members read" on public.draw_cycle_gate_events;
create policy "draw gate events members read"
on public.draw_cycle_gate_events
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "draw gate overrides members read" on public.draw_contribution_gate_overrides;
create policy "draw gate overrides members read"
on public.draw_contribution_gate_overrides
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

revoke all on table public.draw_cycle_gate_events from anon, authenticated;
revoke all on table public.draw_contribution_gate_overrides from anon, authenticated;
grant select on table public.draw_cycle_gate_events to authenticated;
grant select on table public.draw_contribution_gate_overrides to authenticated;

-- The effective policy: the latest event, else the policy the cycle was created with.
create or replace function public.sened_draw_cycle_gate(p_cycle_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select ev.to_gate
      from public.draw_cycle_gate_events ev
      where ev.cycle_id = p_cycle_id
      order by ev.seq desc
      limit 1
    ),
    (select cy.contribution_gate from public.draw_cycles cy where cy.id = p_cycle_id),
    'off'
  );
$$;

-- The cycle as every cycle-returning function shows it, now with its effective policy.
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
    'contributionGate', public.sened_draw_cycle_gate(cycle_row.id)
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

-- ---------------------------------------------------------------------------
-- 2. The derivation: every (member, round) of a cycle
-- ---------------------------------------------------------------------------
-- p_member_id null = every member of the grid; otherwise only that member.
create or replace function public.sened_draw_cycle_member_rounds(p_cycle_id uuid, p_member_id uuid default null)
returns table (
  member_id uuid,
  is_active boolean,
  win_round integer,
  round_no integer,
  cell_status text,
  due_at timestamptz,
  entry_id uuid,
  source text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  cyc public.draw_cycles;
  member_row record;
  r integer;
  due_arr timestamptz[];
  reveal_arr timestamptz[];
  win_no integer;
  win_rev timestamptz;
  e_ids uuid[];
  e_at timestamptz[];
  e_src text[];
  e_round integer[];
  used_idx integer[];
  n integer;
  i integer;
  pick integer;
  due timestamptz;
  prev timestamptz;
begin
  select cycle_row.* into cyc from public.draw_cycles cycle_row where cycle_row.id = p_cycle_id;
  if not found then
    return;
  end if;

  -- When each round's draw was first opened, and first revealed: cycle-level, once.
  due_arr := array_fill(null::timestamptz, array[cyc.total_rounds]);
  reveal_arr := array_fill(null::timestamptz, array[cyc.total_rounds]);
  for r in 1 .. cyc.total_rounds loop
    select min(opened.at_time) into due
    from (
      select s.opened_at as at_time from public.draw_sessions s
      where s.cycle_id = p_cycle_id and s.round = r
      union all
      select cm2.committed_at from public.draw_commitments cm2
      where cm2.cycle_id = p_cycle_id and cm2.round = r
    ) opened;
    due_arr[r] := due;
    select min(rv2.revealed_at) into prev
    from public.draw_commitments cm3
    join public.draw_reveals rv2 on rv2.draw_id = cm3.draw_id
    where cm3.cycle_id = p_cycle_id and cm3.round = r;
    reveal_arr[r] := prev;
  end loop;

  for member_row in
    select
      u.uid as uid,
      exists (
        select 1 from public.ledger_group_memberships mm
        where mm.group_id = cyc.group_id and mm.user_id = u.uid and mm.status = 'active'
      ) as active
    from (
      select m.user_id as uid
      from public.ledger_group_memberships m
      where m.group_id = cyc.group_id and m.status = 'active'
      union
      select rv.winner_member_id
      from public.draw_commitments cm
      join public.draw_reveals rv on rv.draw_id = cm.draw_id
      where cm.cycle_id = p_cycle_id
    ) u
    where p_member_id is null or u.uid = p_member_id
    order by u.uid
  loop
    -- The round the member won (their earliest), and when that round was revealed.
    win_no := null;
    win_rev := null;
    select cm.round into win_no
    from public.draw_commitments cm
    join public.draw_reveals rv on rv.draw_id = cm.draw_id
    where cm.cycle_id = p_cycle_id and rv.winner_member_id = member_row.uid
    order by cm.round
    limit 1;
    if win_no is not null then
      win_rev := reveal_arr[win_no];
    end if;

    select
      coalesce(array_agg(c.entry_id order by c.recorded_at, c.entry_id), '{}'::uuid[]),
      coalesce(array_agg(c.recorded_at order by c.recorded_at, c.entry_id), '{}'::timestamptz[]),
      coalesce(array_agg(c.source order by c.recorded_at, c.entry_id), '{}'::text[]),
      coalesce(array_agg(c.round order by c.recorded_at, c.entry_id), '{}'::integer[])
    into e_ids, e_at, e_src, e_round
    from public.sened_collateral_member_entries(p_cycle_id, member_row.uid) c;
    n := coalesce(array_length(e_ids, 1), 0);
    used_idx := '{}'::integer[];

    for r in 1 .. cyc.total_rounds loop
      due := due_arr[r];
      prev := case when r > 1 then reveal_arr[r - 1] else null end;
      pick := null;

      -- Explicitly assigned to this round (oldest first).
      for i in 1 .. n loop
        if e_round[i] = r then
          pick := i;
          exit;
        end if;
      end loop;

      -- Otherwise by order: the oldest unused, unassigned entry recorded after the
      -- previous round's reveal, on the right side of the member's own win.
      if pick is null and due is not null and (r = 1 or prev is not null) then
        for i in 1 .. n loop
          if e_round[i] is null
             and i <> all (used_idx)
             and (r = 1 or e_at[i] > prev)
             and (win_no is null or r > win_no or e_at[i] <= win_rev) then
            pick := i;
            used_idx := used_idx || i;
            exit;
          end if;
        end loop;
      end if;

      member_id := member_row.uid;
      is_active := member_row.active;
      win_round := win_no;
      round_no := r;
      due_at := due;
      if pick is not null then
        cell_status := 'met';
        entry_id := e_ids[pick];
        source := e_src[pick];
      else
        cell_status := case when due is not null then 'flagged' else 'not_due' end;
        entry_id := null;
        source := null;
      end if;
      return next;
    end loop;
  end loop;
end;
$$;

-- The flagged (active member, round) pairs strictly before p_before_round: what the
-- gate looks at when round p_before_round is about to be opened.
create or replace function public.sened_draw_cycle_gate_flags(p_cycle_id uuid, p_before_round integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('memberId', g.member_id, 'round', g.round_no) order by g.round_no, g.member_id),
    '[]'::jsonb
  )
  from public.sened_draw_cycle_member_rounds(p_cycle_id, null) g
  where g.is_active
    and g.cell_status = 'flagged'
    and g.round_no < p_before_round;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reading (any active member of the group)
-- ---------------------------------------------------------------------------
create or replace function public.get_draw_cycle_contributions_v1(p_cycle_id uuid)
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
  rounds_json jsonb;
  members_json jsonb;
  events_json jsonb;
  overrides_json jsonb;
  revealed_rounds integer;
  flagged_total integer;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;
  select cycle_row.* into cyc from public.draw_cycles cycle_row where cycle_row.id = p_cycle_id;
  if found then
    select group_row.tenant_id into tenant from public.ledger_groups group_row where group_row.id = cyc.group_id;
  end if;
  -- An unknown cycle and a cycle in someone else's group read the same.
  if not found or not public.sened_ledger_can_access_group(cyc.group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'round', gs.r,
      'dueAt', (
        select public.sened_ts_iso(min(opened.at_time)) from (
          select s.opened_at as at_time from public.draw_sessions s where s.cycle_id = p_cycle_id and s.round = gs.r
          union all
          select cm2.committed_at from public.draw_commitments cm2 where cm2.cycle_id = p_cycle_id and cm2.round = gs.r
        ) opened
      ),
      'revealedAt', (
        select public.sened_ts_iso(min(rv2.revealed_at))
        from public.draw_commitments cm3
        join public.draw_reveals rv2 on rv2.draw_id = cm3.draw_id
        where cm3.cycle_id = p_cycle_id and cm3.round = gs.r
      )
    ) order by gs.r
  ), '[]'::jsonb)
  into rounds_json
  from generate_series(1, cyc.total_rounds) as gs(r);

  with cells as (
    select * from public.sened_draw_cycle_member_rounds(p_cycle_id, null)
  )
  select
    coalesce(jsonb_agg(per_member.item order by per_member.member_id), '[]'::jsonb),
    coalesce(sum(per_member.flagged) filter (where per_member.active), 0)::integer
  into members_json, flagged_total
  from (
    select
      c.member_id,
      bool_and(c.is_active) as active,
      count(*) filter (where c.cell_status = 'flagged') as flagged,
      jsonb_build_object(
        'memberId', c.member_id,
        'active', bool_and(c.is_active),
        'winRound', max(c.win_round),
        'cells', jsonb_agg(
          jsonb_build_object(
            'round', c.round_no,
            'status', c.cell_status,
            'entryId', c.entry_id,
            'source', c.source
          ) order by c.round_no
        )
      ) as item
    from cells c
    group by c.member_id
  ) per_member;

  select coalesce(jsonb_agg(jsonb_build_object(
    'at', public.sened_ts_iso(ev.created_at),
    'actorId', ev.actor_id,
    'from', ev.from_gate,
    'to', ev.to_gate,
    'reason', ev.reason
  ) order by ev.seq), '[]'::jsonb)
  into events_json
  from public.draw_cycle_gate_events ev
  where ev.cycle_id = p_cycle_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'at', public.sened_ts_iso(ov.created_at),
    'actorId', ov.actor_id,
    'round', ov.round,
    'drawId', ov.draw_id,
    'reason', ov.reason,
    'flagged', ov.flagged
  ) order by ov.created_at, ov.id), '[]'::jsonb)
  into overrides_json
  from public.draw_contribution_gate_overrides ov
  where ov.cycle_id = p_cycle_id;

  select count(distinct cm4.round) into revealed_rounds
  from public.draw_commitments cm4
  join public.draw_reveals rv4 on rv4.draw_id = cm4.draw_id
  where cm4.cycle_id = p_cycle_id;

  return jsonb_build_object(
    'cycleId', cyc.id,
    'groupId', cyc.group_id,
    'totalRounds', cyc.total_rounds,
    'contributionAmount', cyc.contribution_amount::text,
    'startedAt', public.sened_ts_iso(cyc.started_at),
    'contributionGate', public.sened_draw_cycle_gate(cyc.id),
    'nextRound', case when revealed_rounds < cyc.total_rounds then revealed_rounds + 1 else null end,
    'flaggedCount', flagged_total,
    'rounds', rounds_json,
    'members', members_json,
    'gateEvents', events_json,
    'overrides', overrides_json
  );
end;
$$;

-- The collateral view, rebuilt on the shared derivation. Output is unchanged: for
-- every winner, the rounds AFTER the one they won.
create or replace function public.get_draw_cycle_collateral_v1(p_cycle_id uuid)
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
  winner_row record;
  cell record;
  owed jsonb;
  winners jsonb := '[]'::jsonb;
  guarantees jsonb;
  flagged integer := 0;
  retained numeric(20, 2) := 0;
  revealed_rounds integer;
  next_round integer;
  eligible_n integer;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  select cycle_row.* into cyc from public.draw_cycles cycle_row where cycle_row.id = p_cycle_id;
  if found then
    select group_row.tenant_id into tenant from public.ledger_groups group_row where group_row.id = cyc.group_id;
  end if;
  -- An unknown cycle and a cycle in someone else's group read the same.
  if not found or not public.sened_ledger_can_access_group(cyc.group_id, tenant) then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;

  for winner_row in
    select distinct on (cm.round)
      cm.round as win_round,
      rv.winner_member_id as member_id,
      rv.revealed_at as revealed_at,
      rv.reserve_amount as reserve_amount
    from public.draw_commitments cm
    join public.draw_reveals rv on rv.draw_id = cm.draw_id
    where cm.cycle_id = p_cycle_id
    order by cm.round, rv.revealed_at
  loop
    retained := retained + winner_row.reserve_amount;
    owed := '[]'::jsonb;

    for cell in
      select g.round_no, g.cell_status, g.due_at, g.entry_id, g.source
      from public.sened_draw_cycle_member_rounds(p_cycle_id, winner_row.member_id) g
      where g.round_no > winner_row.win_round
      order by g.round_no
    loop
      if cell.cell_status = 'flagged' then
        flagged := flagged + 1;
      end if;
      owed := owed || jsonb_build_array(jsonb_build_object(
        'round', cell.round_no,
        'status', cell.cell_status,
        'dueAt', case when cell.due_at is null then null else public.sened_ts_iso(cell.due_at) end,
        'entryId', cell.entry_id,
        'source', cell.source
      ));
    end loop;

    select coalesce(jsonb_agg(public.sened_collateral_guarantee_json(gr.id) order by gr.proposed_at, gr.id), '[]'::jsonb)
    into guarantees
    from public.draw_collateral_guarantees gr
    where gr.cycle_id = p_cycle_id and gr.winner_member_id = winner_row.member_id;

    winners := winners || jsonb_build_array(jsonb_build_object(
      'memberId', winner_row.member_id,
      'round', winner_row.win_round,
      'revealedAt', public.sened_ts_iso(winner_row.revealed_at),
      'owed', owed,
      'guarantees', guarantees
    ));
  end loop;

  select count(distinct cm4.round) into revealed_rounds
  from public.draw_commitments cm4
  join public.draw_reveals rv4 on rv4.draw_id = cm4.draw_id
  where cm4.cycle_id = p_cycle_id;
  next_round := case when revealed_rounds < cyc.total_rounds then revealed_rounds + 1 else null end;
  if next_round is not null then
    select count(*)::integer into eligible_n
    from public.sened_draw_eligible_members(cyc.group_id, p_cycle_id, next_round);
  end if;

  return jsonb_build_object(
    'cycleId', cyc.id,
    'groupId', cyc.group_id,
    'totalRounds', cyc.total_rounds,
    'contributionAmount', cyc.contribution_amount::text,
    'potAmount', cyc.pot_amount::text,
    'reserveRatioBps', cyc.reserve_ratio_bps,
    'startedAt', public.sened_ts_iso(cyc.started_at),
    'nextRound', next_round,
    'eligibleCount', eligible_n,
    'reserveRetained', retained::text,
    'flaggedCount', flagged,
    'winners', winners
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Changing the policy (owner/treasurer), with an audit event
-- ---------------------------------------------------------------------------
create or replace function public.set_draw_cycle_contribution_gate_v1(
  p_cycle_id uuid,
  p_gate text,
  p_reason text
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
  current_gate text;
  clean_reason text := btrim(coalesce(p_reason, ''));
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;
  select cy.* into cyc from public.draw_cycles cy where cy.id = p_cycle_id;
  if found then
    select group_row.tenant_id into tenant from public.ledger_groups group_row where group_row.id = cyc.group_id;
  end if;
  -- An unknown cycle and a cycle the caller cannot manage read the same.
  if not found or not public.sened_ledger_can_manage_group(cyc.group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;
  if p_gate is null or p_gate not in ('off', 'warn', 'block')
     or char_length(clean_reason) not between 10 and 1000 then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;

  -- Serialise with opens and with other policy changes.
  perform 1 from public.draw_cycles locked where locked.id = p_cycle_id for update;
  if cyc.closed_at is not null then
    raise exception using errcode = 'P0001', message = 'draw_cycle_closed';
  end if;

  current_gate := public.sened_draw_cycle_gate(p_cycle_id);
  if current_gate = p_gate then
    return jsonb_build_object('cycle', public.sened_draw_cycle_json(cyc), 'replayed', true);
  end if;

  insert into public.draw_cycle_gate_events (cycle_id, group_id, tenant_id, from_gate, to_gate, actor_id, reason)
  values (cyc.id, cyc.group_id, cyc.tenant_id, current_gate, p_gate, actor, clean_reason);

  return jsonb_build_object('cycle', public.sened_draw_cycle_json(cyc), 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. create_draw_cycle_v1 with the policy (old arity dropped, not overloaded)
-- ---------------------------------------------------------------------------
drop function if exists public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text);

create or replace function public.create_draw_cycle_v1(
  p_group_id uuid,
  p_name text,
  p_contribution_amount numeric,
  p_total_rounds integer,
  p_reserve_ratio_bps integer,
  p_started_at timestamptz,
  p_idempotency_key text,
  p_contribution_gate text default 'off'
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
    started_at, contribution_amount, created_by, idempotency_key, contribution_gate
  ) values (
    p_group_id, tenant, clean_name, p_total_rounds,
    round(p_contribution_amount * member_count, 2),
    p_reserve_ratio_bps,
    coalesce(p_started_at, clock_timestamp()),
    round(p_contribution_amount, 2),
    actor,
    p_idempotency_key,
    p_contribution_gate
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
       or existing_row.contribution_gate <> p_contribution_gate then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    return jsonb_build_object('cycle', public.sened_draw_cycle_json(existing_row), 'replayed', true);
  end if;

  return jsonb_build_object('cycle', public.sened_draw_cycle_json(created_row), 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. open_draw_v1 with the gate (old arity dropped, not overloaded)
-- ---------------------------------------------------------------------------
drop function if exists public.open_draw_v1(uuid, integer, text);

create or replace function public.open_draw_v1(
  p_cycle_id uuid,
  p_round integer,
  p_idempotency_key text,
  p_override_reason text default null
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

  -- Serialise concurrent opens for one cycle.
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

  -- A draw still sealing for this round is continued, not duplicated (and not gated
  -- again: nothing new is being opened).
  select s.* into live_row
  from public.draw_sessions s
  where s.cycle_id = cyc.id
    and s.round = next_round
    and not exists (select 1 from public.draw_commitments cm where cm.draw_id = s.draw_id)
  order by s.opened_at desc
  limit 1;
  if found then
    return jsonb_build_object(
      'session', public.sened_draw_session_view(live_row.draw_id),
      'replayed', true
    );
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

  insert into public.draw_sessions (group_id, tenant_id, cycle_id, round, opened_by, idempotency_key)
  values (cyc.group_id, cyc.tenant_id, cyc.id, next_round, actor, p_idempotency_key)
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
-- 7. Grants. Helpers are never granted to a client role; RPCs only to signed-in users.
-- ---------------------------------------------------------------------------
revoke all on function public.sened_gate_block_mutation() from public, anon, authenticated;
revoke all on function public.sened_draw_cycle_gate(uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_cycle_member_rounds(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_cycle_gate_flags(uuid, integer) from public, anon, authenticated;

revoke all on function public.get_draw_cycle_contributions_v1(uuid) from public, anon;
revoke all on function public.get_draw_cycle_collateral_v1(uuid) from public, anon;
revoke all on function public.set_draw_cycle_contribution_gate_v1(uuid, text, text) from public, anon;
revoke all on function public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text) from public, anon;
revoke all on function public.open_draw_v1(uuid, integer, text, text) from public, anon;

grant execute on function public.get_draw_cycle_contributions_v1(uuid) to authenticated;
grant execute on function public.get_draw_cycle_collateral_v1(uuid) to authenticated;
grant execute on function public.set_draw_cycle_contribution_gate_v1(uuid, text, text) to authenticated;
grant execute on function public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text, text) to authenticated;
grant execute on function public.open_draw_v1(uuid, integer, text, text) to authenticated;
