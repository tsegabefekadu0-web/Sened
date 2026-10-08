-- M4.2 follow-up: (1) a payment recorded after a win now clears an earlier missed round,
-- decided at the moment the payment was recorded; (2) the contribution gate is checked
-- again when a draw is COMMITTED, not only when it is opened.
--
-- ---------------------------------------------------------------------------------
-- A. GAP 1: A POST-WIN PAYMENT AND AN EARLIER MISSED ROUND
-- ---------------------------------------------------------------------------------
--
--   20261011100000 split a winner's entries at the reveal W of their win (round w): an
--   entry recorded AFTER W could only pay rounds after w, so a winner who missed an
--   earlier round could only clear it with an explicit cycle+round attribution, even
--   when they had no later obligation at all.
--
--   THE RULE, for the member's entries that carry no explicit round, taken in recorded
--   order (recorded_at, entry id). Let t be the entry's recorded time. A round r is
--   "reachable" by the entry when r = 1 or round r-1 was revealed strictly before t.
--   A round is "met" when an explicit cycle+round attribution names it or an earlier
--   entry in this pass took it; "due at t" means its draw was opened strictly before t.
--
--     * An entry recorded AT OR BEFORE the member's reveal W, or by a member who has not
--       won: the earliest unmet, reachable round that is due now (for a winner only
--       rounds <= w). EXACTLY THE PRIOR RULE.
--     * An entry recorded AFTER W (so after the win at round w), in this order:
--         1. the earliest unmet, reachable round AFTER w that was DUE AT t;
--         2. otherwise the earliest unmet round <= w (all of those were revealed or
--            opened before W < t, so they are reachable and due);
--         3. otherwise (the prepayment) the earliest unmet round after w that is
--            reachable and due NOW but was not due at t. That is only ever the round
--            that follows the last one revealed at t, and it is taken only when it
--            opens, as before.
--
--   Post-win obligations therefore keep priority (step 1), a later flagged round is
--   never starved by an earlier one that an older payment could have taken, and a
--   payment with nothing due after the win clears the earliest missed round (step 2)
--   instead of waiting for a round that may or may not exist. Explicit cycle+round
--   attributions still win: they claim their round before any entry is placed by
--   order. One entry pays one round; an amount under the cycle's contribution is not a
--   qualifying entry at all; an overpayment does not carry over. A non-winner has no
--   steps 2 or 3 to choose between, so nothing changes for them.
--
--   WHY THIS DOES NOT FLAP. The grid is recomputed on every read, so a rule that read
--   "what is due now" for the choice between step 1 and step 2 would let a payment
--   move: recorded while no post-win round was due it clears the missed round, and the
--   moment round w+1 is opened it would jump to w+1. The choice is therefore made on
--   the state AT THE ENTRY'S OWN TIME: step 1 looks at what was due before t and step 2
--   is reached exactly when nothing post-win was due and unmet before t. Entries are
--   placed in recorded order, each seeing only the explicit claims and the entries
--   before it, and the only facts it reads about rounds are reveal times and open times
--   that lie before t, which never change. By induction on the recorded order, once an
--   entry has a round it keeps it whatever is opened, revealed or recorded afterwards.
--   The one entry that is not placed yet, the prepayment of step 3, can only become
--   placed on the single round that follows the last one revealed at t, when that round
--   opens; it never moves between rounds. What CAN reassign an entry is a deliberate
--   edit of the data: an explicit attribution claims its round and the entry that held
--   it falls to the next choice; a reversed payment stops counting and later entries
--   close up. The harness proves this on a timeline.
--
--   WHAT DIFFERS FROM 20261011100000 (and so from get_draw_cycle_collateral_v1 before it):
--   only a winner who had an UNMET round <= w when a post-win entry was recorded with
--   nothing post-win due and unmet then. The entry used to wait for round w+1 (where it
--   made the round `met` when it opened); it now clears the earlier round, and w+1 is
--   flagged when it opens unless something else pays it. Nothing else changes, and the
--   output shapes of get_draw_cycle_contributions_v1 and get_draw_cycle_collateral_v1
--   are untouched.
--
-- ---------------------------------------------------------------------------------
-- B. GAP 2: THE GATE AT COMMIT
-- ---------------------------------------------------------------------------------
--
--   The gate was checked only by open_draw_v1. A flag that appeared after the draw was
--   opened (a payment reversed) and a policy switched to `block` while members were
--   sealing both slipped through. commit_draw_from_seals_v1 now reads the cycle's
--   EFFECTIVE policy and the flagged (active member, round < this round) pairs at commit
--   time:
--     off    nothing is computed.
--     warn   allowed; the flagged pairs are returned (contributionGate.flagged).
--     block  refused with draw_contribution_gate_blocked (P0001, DETAIL = JSON array of
--            {memberId, round}) unless the flagged set is COVERED by the override given
--            when this draw was opened (every flagged pair is one that override named: the
--            set may be the same or smaller, it may not have gained a pair), or the caller
--            supplies p_override_reason (10..1000 characters, trimmed), which is recorded
--            with every pair flagged now and stage = 'commit'.
--   Sealed seals stay valid when a commit is refused: nothing is written, so the
--   treasurer can record the missing payment and commit, or override.
--   An override given at open does NOT carry over when the set has gained a pair, and a
--   draw opened under off or warn has no recorded override, so a flag found at commit
--   after a switch to `block` always needs one.
--
--   WHY THE EXISTING OVERRIDES TABLE with a `stage` column, not a sibling table. It is
--   the same fact (an owner/treasurer let a draw proceed past this named set of flags,
--   with a reason), read by the same screen and compared with the same recorded set: one
--   list in time order, one RLS policy, one immutability trigger, one place a reviewer
--   looks. A sibling would copy the table, the triggers, the policy and the read, and
--   "the override in force for this draw" would need a union. The only structural change
--   is that a draw may now have one override per stage: the unique constraint on draw_id
--   becomes unique (draw_id, stage). Existing rows are stage 'open'.
--
--   The commit function gains an optional trailing p_override_reason. As in the earlier
--   migrations the old signature is dropped first, so PostgREST has exactly one
--   function of that name to choose.
--
-- DEPLOY ORDER: apply together with the application release; the new application sends
-- p_override_reason on every commit (null when none).

-- ---------------------------------------------------------------------------
-- 1. The derivation, with the post-win fill
-- ---------------------------------------------------------------------------
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
  claimed integer[];
  n integer;
  i integer;
  pick integer;
  due timestamptz;
  prev timestamptz;
  post_win boolean;
  top_round integer;
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

    -- claimed[r] = index of the entry that pays round r (0 = nobody yet).
    claimed := array_fill(0, array[cyc.total_rounds]);

    -- Explicit cycle+round attributions claim their round first (oldest entry per round).
    -- Any further entry naming the same round pays nothing and is not placed by order.
    for r in 1 .. cyc.total_rounds loop
      for i in 1 .. n loop
        if e_round[i] = r then
          claimed[r] := i;
          exit;
        end if;
      end loop;
    end loop;

    -- The rest are placed one at a time in recorded order, each by the state at ITS
    -- time (see the header): a placed entry never moves because of what happens later.
    for i in 1 .. n loop
      continue when e_round[i] is not null;
      pick := null;
      post_win := win_no is not null and e_at[i] > win_rev;

      if post_win then
        -- 1. The earliest unmet round after the win that had been opened before this entry.
        for r in (win_no + 1) .. cyc.total_rounds loop
          if claimed[r] = 0
             and due_arr[r] is not null and due_arr[r] < e_at[i]
             and reveal_arr[r - 1] is not null and reveal_arr[r - 1] < e_at[i] then
            pick := r;
            exit;
          end if;
        end loop;
        -- 2. Nothing after the win was due and unmet: the earliest unmet round up to the win.
        if pick is null then
          for r in 1 .. win_no loop
            if claimed[r] = 0
               and due_arr[r] is not null
               and (r = 1 or (reveal_arr[r - 1] is not null and reveal_arr[r - 1] < e_at[i])) then
              pick := r;
              exit;
            end if;
          end loop;
        end if;
        -- 3. The prepayment: the next round after the win, once it is open.
        if pick is null then
          for r in (win_no + 1) .. cyc.total_rounds loop
            if claimed[r] = 0
               and due_arr[r] is not null
               and reveal_arr[r - 1] is not null and reveal_arr[r - 1] < e_at[i] then
              pick := r;
              exit;
            end if;
          end loop;
        end if;
      else
        -- Before the win (or no win): the earliest unmet round that is open now and that
        -- the entry could reach; a winner's earlier entries only pay up to their win.
        top_round := case when win_no is null then cyc.total_rounds else win_no end;
        for r in 1 .. top_round loop
          if claimed[r] = 0
             and due_arr[r] is not null
             and (r = 1 or (reveal_arr[r - 1] is not null and reveal_arr[r - 1] < e_at[i])) then
            pick := r;
            exit;
          end if;
        end loop;
      end if;

      if pick is not null then
        claimed[pick] := i;
      end if;
    end loop;

    for r in 1 .. cyc.total_rounds loop
      pick := nullif(claimed[r], 0);
      member_id := member_row.uid;
      is_active := member_row.active;
      win_round := win_no;
      round_no := r;
      due_at := due_arr[r];
      if pick is not null then
        cell_status := 'met';
        entry_id := e_ids[pick];
        source := e_src[pick];
      else
        cell_status := case when due_arr[r] is not null then 'flagged' else 'not_due' end;
        entry_id := null;
        source := null;
      end if;
      return next;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Overrides: one per draw per stage
-- ---------------------------------------------------------------------------
alter table public.draw_contribution_gate_overrides
  add column if not exists stage text not null default 'open';

alter table public.draw_contribution_gate_overrides
  drop constraint if exists draw_contribution_gate_overrides_stage_check;
alter table public.draw_contribution_gate_overrides
  add constraint draw_contribution_gate_overrides_stage_check check (stage in ('open', 'commit'));

-- The column draw_id was unique (one override per draw); it is now unique per stage.
alter table public.draw_contribution_gate_overrides
  drop constraint if exists draw_contribution_gate_overrides_draw_id_key;
create unique index if not exists draw_gate_overrides_draw_stage_idx
  on public.draw_contribution_gate_overrides (draw_id, stage);

comment on column public.draw_contribution_gate_overrides.stage is
  'Where the override was given: open (open_draw_v1) or commit (commit_draw_from_seals_v1). At most one per draw per stage.';

-- The pairs the draw's OPEN override named; '[]' when it was opened without one.
create or replace function public.sened_draw_open_override_flags(p_draw_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select ov.flagged
      from public.draw_contribution_gate_overrides ov
      where ov.draw_id = p_draw_id and ov.stage = 'open'
    ),
    '[]'::jsonb
  );
$$;

-- True when every (memberId, round) pair of p_flagged is also in p_acknowledged.
create or replace function public.sened_draw_flags_covered(p_flagged jsonb, p_acknowledged jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select not exists (
    select 1
    from jsonb_array_elements(p_flagged) f(item)
    where not exists (
      select 1
      from jsonb_array_elements(p_acknowledged) a(item)
      where a.item ->> 'memberId' = f.item ->> 'memberId'
        and a.item ->> 'round' = f.item ->> 'round'
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. The grid read: each override says which stage gave it
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
    'flagged', ov.flagged,
    'stage', ov.stage
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

-- ---------------------------------------------------------------------------
-- 4. Commit with the gate (old arity dropped, not overloaded)
-- ---------------------------------------------------------------------------
drop function if exists public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text);

create or replace function public.commit_draw_from_seals_v1(
  p_draw_id uuid,
  p_commitment text,
  p_commitment_nonce text,
  p_roster_digest text,
  p_member_digest text,
  p_participants jsonb,
  p_idempotency_key text,
  p_occurred_at timestamptz,
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
  other_count integer;
  clean_override text := btrim(p_override_reason);
  gate_policy text;
  flagged jsonb := '[]'::jsonb;
  acknowledged jsonb := '[]'::jsonb;
  carried_over boolean := false;
  overridden boolean := false;
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

  -- Serialise with seal and nonce submission, then read the seals.
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

  select cy.* into cyc from public.draw_cycles cy where cy.id = sess.cycle_id;
  if sess.round > cyc.total_rounds then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
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

  -- The roster is not typed: it is exactly the active members who have not won
  -- this cycle, each at the cycle's contribution, each with their derived ticket.
  select count(*)::integer into eligible_count
  from public.sened_draw_eligible_members(sess.group_id, sess.cycle_id, sess.round);
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
         from public.sened_draw_eligible_members(sess.group_id, sess.cycle_id, sess.round) as e(member_id)
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

  -- THE SEALED SET IS WHATEVER IS STORED. Nothing the caller sends can add,
  -- drop or alter a seal. Seals from members no longer eligible are not used.
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object('memberId', se.member_id, 'sealed', se.sealed)
        order by se.member_id::text collate "C"
      ),
      '[]'::jsonb
    ),
    count(*)::integer,
    (count(*) filter (where se.member_id <> actor))::integer
  into sealed_set, seal_count, other_count
  from public.draw_seals se
  where se.draw_id = p_draw_id
    and exists (
      select 1
      from public.sened_draw_eligible_members(sess.group_id, sess.cycle_id, sess.round) as e(member_id)
      where e.member_id = se.member_id
    );

  -- The fairness property needs a secret the committer does not hold: at least
  -- one seal from somebody else (unless the committer is the only one left, in
  -- which case there is nothing to choose).
  if seal_count < 1 or (eligible_count > 1 and other_count < 1) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_missing';
  end if;
  if p_member_digest is distinct from public.sened_draw_member_set_digest(p_draw_id, sealed_set) then
    raise exception using errcode = 'P0001', message = 'draw_member_commitment_mismatch';
  end if;

  -- THE GATE, AGAIN. The policy and the flags are read now, not as they were when the
  -- draw was opened: a payment reversed since, or a policy switched to `block` while
  -- members were sealing, is seen here. Serialised with policy changes and opens.
  perform 1 from public.draw_cycles locked where locked.id = sess.cycle_id for share;
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
    committed_at, protocol_version
  ) values (
    p_draw_id, sess.group_id, sess.tenant_id, sess.cycle_id, sess.round, p_commitment,
    p_commitment_nonce, p_roster_digest, p_member_digest, sealed_set, p_participants,
    cyc.pot_amount, cyc.total_rounds, cyc.reserve_ratio_bps, actor, p_idempotency_key,
    coalesce(p_occurred_at, clock_timestamp()), 'v3'
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

-- ---------------------------------------------------------------------------
-- 5. Grants. Helpers are never granted to a client role.
-- ---------------------------------------------------------------------------
revoke all on function public.sened_draw_open_override_flags(uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_flags_covered(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.sened_draw_cycle_member_rounds(uuid, uuid) from public, anon, authenticated;

revoke all on function public.get_draw_cycle_contributions_v1(uuid) from public, anon;
revoke all on function public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text) from public, anon;

grant execute on function public.get_draw_cycle_contributions_v1(uuid) to authenticated;
grant execute on function public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text, text) to authenticated;
