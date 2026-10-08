-- Draw cycles, server-created draws, and member seal / nonce submission.
--
-- WHAT WAS MISSING
--
-- 1. `draw_cycles` had no creating RPC, and nothing listed cycles or draws, so a
--    treasurer typed a cycle id by hand and draw ids were shared by hand.
-- 2. A member's seal existed only inside the treasurer's commit request, and the
--    openings (nonces) travelled by copy-paste. Worse, because the commit RPC took
--    the sealed set from the caller, a treasurer could write a "seal" for any
--    member under a nonce the treasurer chose: a seal is just H(drawId, memberId,
--    nonce) and nothing authenticated who produced it.
-- 3. Contribution, pot and reserve were typed at commit time.
--
-- THE DRAW STATE MACHINE (enforced here, not in the application)
--
--   (none) --open_draw_v1--> SEALING --commit_draw_from_seals_v1--> COMMITTED
--          COMMITTED --reveal_draw_v1--> REVEALED --record_draw_payout_v1--> PAID
--
--   SEALING    draw_sessions row exists, no draw_commitments row. Members submit
--              (or replace) their own seal. Owner/treasurer opens and commits.
--   COMMITTED  draw_commitments row exists (protocol v3). The sealed set is
--              frozen. Members release their own nonce, once, and only if it opens
--              their own committed seal. Owner/treasurer may then request the
--              reveal with the seed (open_draw_reveal_v1).
--   REVEALED   draw_reveals row exists. PAID: draw_payouts row exists.
--
--   Refused transitions: a seal after the commit (draw_already_committed); a nonce
--   before the commit (draw_nonce_too_early); a nonce after the reveal was
--   requested (draw_already_revealed); a commit of anything but the stored seals;
--   a reveal of anything but the stored nonces; a round out of order.
--
-- WHO MAY DO WHAT (identity is ALWAYS auth.uid(); no function takes a member id
-- from its arguments for a write)
--
--   create_draw_cycle_v1       owner/treasurer (sened_ledger_can_manage_group)
--   open_draw_v1               owner/treasurer
--   commit_draw_from_seals_v1  owner/treasurer
--   open_draw_reveal_v1        owner/treasurer
--   reveal_draw_v1             owner/treasurer (unchanged, plus the stored-nonce binding)
--   submit_draw_seal_v1        an active member of the group, for themselves, if on
--                              this round's eligible roster
--   submit_draw_nonce_v1       an active member of the group, for themselves, if
--                              their seal is in the committed set
--   list_draw_cycles_v1 / get_draw_cycle_v1 / get_draw_session_v1
--                              any active member of the group
--
-- HOW NONCE SECRECY BEFORE THE REVEAL IS ENFORCED
--
--   * draw_nonces has row level security enabled, NO policy, and every privilege
--     revoked from anon and authenticated. No client role can select it, through
--     PostgREST or otherwise. Only security definer functions read it.
--   * The only function that returns nonces is open_draw_reveal_v1. It requires
--     the owner/treasurer, a committed draw, every sealed member's nonce stored,
--     and a SEED THAT HASHES TO THE PUBLISHED COMMITMENT (verified here, so a
--     junk seed cannot be used to read the nonces). It then publishes the seed and
--     the nonces atomically into draw_reveal_openings, which every group member
--     can read: from that instant nobody, the treasurer included, knows more than
--     anyone else. The treasurer learns the nonces only by making them public.
--   * get_draw_session_v1 reports, per sealed member, only a boolean "released".
--   * Seals are exposed as hashes only (that is all the table holds).
--
-- DATABASE-SIDE HASHES. To verify a seed against the commitment and a nonce
-- against its seal, three PLAIN length-prefixed hashes are reimplemented below
-- (member seal, member set, commit v3) plus the ticket. The winner derivation
-- (transcript digest, rejection sampling) is deliberately NOT reimplemented; see
-- 20260926110000_draw_reveal_binding.sql. Parity with the TypeScript engine is
-- pinned by golden vectors: test/draw.sql-parity.test.ts and the harness
-- (scripts/verify-migrations.sql) use the same literals.
--
-- LEGACY. commit_draw_v1 (client-supplied seals, no session) is revoked from
-- authenticated: it is exactly the path the stored seals replace. It stays
-- defined, callable by the database owner, so history and the older harness checks
-- are untouched. Draws committed through it have no session and can still be
-- revealed through reveal_draw_v1 with client-supplied nonces (the pre-existing
-- rules); the application no longer offers that path.
--
-- DEPLOY ORDER: apply this migration together with the application release that
-- calls the new RPCs. The previous application calls commit_draw_v1 and would be
-- refused.

-- ---------------------------------------------------------------------------
-- 1. Cycles: contribution, idempotency, authorship
-- ---------------------------------------------------------------------------
alter table public.draw_cycles
  add column if not exists contribution_amount numeric(20, 2),
  add column if not exists created_by uuid references auth.users (id) on delete restrict,
  add column if not exists idempotency_key text;

alter table public.draw_cycles
  drop constraint if exists draw_cycles_contribution_positive;
alter table public.draw_cycles
  add constraint draw_cycles_contribution_positive
  check (contribution_amount is null or contribution_amount > 0);

alter table public.draw_cycles
  drop constraint if exists draw_cycles_idempotency_key_shape;
alter table public.draw_cycles
  add constraint draw_cycles_idempotency_key_shape
  check (
    idempotency_key is null
    or (
      char_length(idempotency_key) between 1 and 128
      and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )
  );

create unique index if not exists draw_cycles_group_idempotency_idx
  on public.draw_cycles (group_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.draw_cycles.contribution_amount is
  'Per-member contribution per round, fixed by the cycle. Null only for cycles created before this column existed (their pot_amount is authoritative).';

-- ---------------------------------------------------------------------------
-- 2. Sessions, seals, nonces, reveal openings
-- ---------------------------------------------------------------------------
create table if not exists public.draw_sessions (
  draw_id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  tenant_id uuid not null,
  cycle_id uuid not null,
  round integer not null check (round between 1 and 1000),
  opened_by uuid not null references auth.users (id) on delete restrict,
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 128 and
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  opened_at timestamptz not null default clock_timestamp(),
  constraint draw_sessions_group_idempotency_key unique (group_id, idempotency_key),
  constraint draw_sessions_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint draw_sessions_cycle_group_fk
    foreign key (cycle_id, group_id)
    references public.draw_cycles (id, group_id)
    on delete restrict
);

create index if not exists draw_sessions_cycle_round_idx
  on public.draw_sessions (cycle_id, round, opened_at desc);

create table if not exists public.draw_seals (
  draw_id uuid not null references public.draw_sessions (draw_id) on delete restrict,
  member_id uuid not null references auth.users (id) on delete restrict,
  sealed text not null check (sealed ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz not null default clock_timestamp(),
  primary key (draw_id, member_id)
);

create table if not exists public.draw_nonces (
  draw_id uuid not null references public.draw_sessions (draw_id) on delete restrict,
  member_id uuid not null references auth.users (id) on delete restrict,
  nonce text not null check (char_length(nonce) between 16 and 256 and nonce ~ '^[!-~]+$'),
  released_at timestamptz not null default clock_timestamp(),
  primary key (draw_id, member_id)
);

create table if not exists public.draw_reveal_openings (
  draw_id uuid primary key references public.draw_sessions (draw_id) on delete restrict,
  seed text not null check (char_length(btrim(seed)) between 16 and 256),
  member_nonces jsonb not null check (
    jsonb_typeof(member_nonces) = 'array' and jsonb_array_length(member_nonces) >= 1
  ),
  opened_by uuid not null references auth.users (id) on delete restrict,
  opened_at timestamptz not null default clock_timestamp()
);

alter table public.draw_sessions enable row level security;
alter table public.draw_seals enable row level security;
alter table public.draw_nonces enable row level security;
alter table public.draw_reveal_openings enable row level security;

-- Append-only. A seal may be replaced while the draw is still sealing (a member
-- who lost the device holding the nonce must be able to re-seal); never after.
create or replace function public.sened_draw_guard_seal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' or exists (
    select 1 from public.draw_commitments cm where cm.draw_id = old.draw_id
  ) then
    raise exception using errcode = '55000', message = 'draw_history_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists draw_sessions_block_mutation on public.draw_sessions;
create trigger draw_sessions_block_mutation
before update or delete on public.draw_sessions
for each row execute function public.sened_draw_block_mutation();

drop trigger if exists draw_seals_guard on public.draw_seals;
create trigger draw_seals_guard
before update or delete on public.draw_seals
for each row execute function public.sened_draw_guard_seal();

drop trigger if exists draw_nonces_block_mutation on public.draw_nonces;
create trigger draw_nonces_block_mutation
before update or delete on public.draw_nonces
for each row execute function public.sened_draw_block_mutation();

drop trigger if exists draw_reveal_openings_block_mutation on public.draw_reveal_openings;
create trigger draw_reveal_openings_block_mutation
before update or delete on public.draw_reveal_openings
for each row execute function public.sened_draw_block_mutation();

drop policy if exists "draw sessions members read" on public.draw_sessions;
create policy "draw sessions members read"
on public.draw_sessions
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "draw seals members read" on public.draw_seals;
create policy "draw seals members read"
on public.draw_seals
for select
to authenticated
using (
  exists (
    select 1
    from public.draw_sessions session_row
    where session_row.draw_id = draw_seals.draw_id
      and public.sened_ledger_can_access_group(session_row.group_id, session_row.tenant_id)
  )
);

-- draw_nonces: deliberately NO policy and no grant. See the header.

drop policy if exists "draw reveal openings members read" on public.draw_reveal_openings;
create policy "draw reveal openings members read"
on public.draw_reveal_openings
for select
to authenticated
using (
  exists (
    select 1
    from public.draw_sessions session_row
    where session_row.draw_id = draw_reveal_openings.draw_id
      and public.sened_ledger_can_access_group(session_row.group_id, session_row.tenant_id)
  )
);

revoke all on table public.draw_sessions from anon, authenticated;
revoke all on table public.draw_seals from anon, authenticated;
revoke all on table public.draw_nonces from anon, authenticated;
revoke all on table public.draw_reveal_openings from anon, authenticated;

grant select on table public.draw_sessions to authenticated;
grant select on table public.draw_seals to authenticated;
grant select on table public.draw_reveal_openings to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (never granted to a client role)
-- ---------------------------------------------------------------------------

-- Length-prefixed encoding identical to canonical.ts `encode` / `canonicalLine`.
create or replace function public.sened_draw_encode(p_value text)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select char_length(p_value)::text || ':' || p_value;
$$;

create or replace function public.sened_draw_line(p_name text, p_value text)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select public.sened_draw_encode(p_name) || E'\n' || public.sened_draw_encode(p_value);
$$;

-- sened-draw-member-v1: what a member's seal is a hash of.
create or replace function public.sened_draw_member_seal_hash(
  p_draw_id uuid,
  p_member_id uuid,
  p_nonce text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sened_draw_encode('sened-draw-member-v1') || E'\n' ||
      public.sened_draw_line('drawId', p_draw_id::text) || E'\n' ||
      public.sened_draw_line('memberId', p_member_id::text) || E'\n' ||
      public.sened_draw_line('nonce', p_nonce),
      'UTF8'
    )),
    'hex'
  );
$$;

-- sened-draw-member-set-v1: the digest bound into the commitment, over the
-- sealed hashes sorted by member id (byte order, as the JavaScript comparison).
create or replace function public.sened_draw_member_set_digest(
  p_draw_id uuid,
  p_members jsonb
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sened_draw_encode('sened-draw-member-set-v1') || E'\n' ||
      public.sened_draw_line('drawId', p_draw_id::text) ||
      coalesce((
        select string_agg(
          E'\n' ||
          public.sened_draw_line('member.' || (ordered.position - 1)::text || '.memberId', ordered.entry ->> 'memberId') || E'\n' ||
          public.sened_draw_line('member.' || (ordered.position - 1)::text || '.sealed', ordered.entry ->> 'sealed'),
          '' order by ordered.position
        )
        from (
          select
            item.entry as entry,
            row_number() over (order by item.entry ->> 'memberId' collate "C") as position
          from jsonb_array_elements(p_members) as item(entry)
        ) as ordered
      ), ''),
      'UTF8'
    )),
    'hex'
  );
$$;

-- sened-draw-commit-v3: the commitment a seed must reproduce.
create or replace function public.sened_draw_commit_hash_v3(
  p_group_id uuid,
  p_cycle_id uuid,
  p_round integer,
  p_draw_id uuid,
  p_roster_digest text,
  p_commitment_nonce text,
  p_member_digest text,
  p_seed text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sened_draw_encode('sened-draw-commit-v3') || E'\n' ||
      public.sened_draw_line('groupId', p_group_id::text) || E'\n' ||
      public.sened_draw_line('cycleId', p_cycle_id::text) || E'\n' ||
      public.sened_draw_line('round', p_round::text) || E'\n' ||
      public.sened_draw_line('drawId', p_draw_id::text) || E'\n' ||
      public.sened_draw_line('rosterDigest', p_roster_digest) || E'\n' ||
      public.sened_draw_line('commitmentNonce', p_commitment_nonce) || E'\n' ||
      public.sened_draw_line('memberDigest', p_member_digest) || E'\n' ||
      public.sened_draw_line('seed', p_seed),
      'UTF8'
    )),
    'hex'
  );
$$;

-- sened-draw-ticket-v1: a member's ticket is a function of identity alone.
create or replace function public.sened_draw_ticket(
  p_group_id uuid,
  p_cycle_id uuid,
  p_member_id uuid
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    sha256(convert_to(
      public.sened_draw_encode('sened-draw-ticket-v1') || E'\n' ||
      public.sened_draw_line('groupId', p_group_id::text) || E'\n' ||
      public.sened_draw_line('cycleId', p_cycle_id::text) || E'\n' ||
      public.sened_draw_line('memberId', p_member_id::text),
      'UTF8'
    )),
    'hex'
  );
$$;

create or replace function public.sened_draw_state(p_draw_id uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when exists (select 1 from public.draw_payouts po where po.draw_id = p_draw_id) then 'paid'
    when exists (select 1 from public.draw_reveals rv where rv.draw_id = p_draw_id) then 'revealed'
    when exists (select 1 from public.draw_commitments cm where cm.draw_id = p_draw_id) then 'committed'
    else 'sealing'
  end;
$$;

-- Active members of the group who have not already won this cycle: the people
-- who may seal, and exactly the roster a commit must carry.
create or replace function public.sened_draw_eligible_members(
  p_group_id uuid,
  p_cycle_id uuid,
  p_round integer
)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select membership.user_id
  from public.ledger_group_memberships membership
  where membership.group_id = p_group_id
    and membership.status = 'active'
    and not exists (
      select 1
      from public.draw_commitments sibling
      join public.draw_reveals prior on prior.draw_id = sibling.draw_id
      where sibling.cycle_id = p_cycle_id
        and sibling.round < p_round
        and prior.winner_member_id = membership.user_id
    );
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
    'nextRound', case when progress.revealed < cycle_row.total_rounds then progress.revealed + 1 else null end
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

-- The state of one draw as members see it: seal HASHES, and for each sealed
-- member only whether a nonce has been released. Never a nonce.
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
    from public.sened_draw_eligible_members(sess.group_id, sess.cycle_id, sess.round) as e(member_id);

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
    'revealRequested', exists (
      select 1 from public.draw_reveal_openings o where o.draw_id = sess.draw_id
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cycles
-- ---------------------------------------------------------------------------
create or replace function public.create_draw_cycle_v1(
  p_group_id uuid,
  p_name text,
  p_contribution_amount numeric,
  p_total_rounds integer,
  p_reserve_ratio_bps integer,
  p_started_at timestamptz,
  p_idempotency_key text
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
    started_at, contribution_amount, created_by, idempotency_key
  ) values (
    p_group_id, tenant, clean_name, p_total_rounds,
    round(p_contribution_amount * member_count, 2),
    p_reserve_ratio_bps,
    coalesce(p_started_at, clock_timestamp()),
    round(p_contribution_amount, 2),
    actor,
    p_idempotency_key
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
       or existing_row.reserve_ratio_bps <> p_reserve_ratio_bps then
      raise exception using errcode = 'P0001', message = 'draw_idempotency_conflict';
    end if;
    return jsonb_build_object('cycle', public.sened_draw_cycle_json(existing_row), 'replayed', true);
  end if;

  return jsonb_build_object('cycle', public.sened_draw_cycle_json(created_row), 'replayed', false);
end;
$$;

create or replace function public.list_draw_cycles_v1(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;
  select group_row.tenant_id into tenant
  from public.ledger_groups group_row where group_row.id = p_group_id;
  if not found or not public.sened_ledger_can_access_group(p_group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  return coalesce(
    (
      select jsonb_agg(public.sened_draw_cycle_json(cy) order by cy.started_at desc, cy.created_at desc)
      from public.draw_cycles cy
      where cy.group_id = p_group_id
    ),
    '[]'::jsonb
  );
end;
$$;

-- One cycle and every draw in it, with each draw's state. Includes draws that
-- were committed before sessions existed (legacy), flagged as such.
create or replace function public.get_draw_cycle_v1(p_cycle_id uuid)
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
  draw_rows jsonb;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;
  select cy.* into cyc from public.draw_cycles cy where cy.id = p_cycle_id;
  if found then
    select group_row.tenant_id into tenant
    from public.ledger_groups group_row where group_row.id = cyc.group_id;
  end if;
  -- An unknown cycle and a cycle in someone else's group read the same.
  if not found or not public.sened_ledger_can_access_group(cyc.group_id, tenant) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  select coalesce(jsonb_agg(listing.item order by listing.round, listing.opened_at, listing.draw_id), '[]'::jsonb)
  into draw_rows
  from (
    select
      s.round as round,
      s.opened_at as opened_at,
      s.draw_id as draw_id,
      jsonb_build_object(
        'drawId', s.draw_id,
        'round', s.round,
        'state', public.sened_draw_state(s.draw_id),
        'openedAt', s.opened_at,
        'committedAt', cm.committed_at,
        'revealedAt', rv.revealed_at,
        'winnerMemberId', rv.winner_member_id,
        'sealCount', case
          when cm.draw_id is null then (select count(*) from public.draw_seals se where se.draw_id = s.draw_id)
          else jsonb_array_length(cm.member_commitments)
        end,
        'nonceCount', (select count(*) from public.draw_nonces n where n.draw_id = s.draw_id),
        'revealRequested', exists (select 1 from public.draw_reveal_openings o where o.draw_id = s.draw_id),
        'superseded', exists (
          select 1 from public.draw_sessions later
          where later.cycle_id = s.cycle_id
            and later.round = s.round
            and (later.opened_at, later.draw_id) > (s.opened_at, s.draw_id)
        ),
        'legacy', false
      ) as item
    from public.draw_sessions s
    left join public.draw_commitments cm on cm.draw_id = s.draw_id
    left join public.draw_reveals rv on rv.draw_id = s.draw_id
    where s.cycle_id = p_cycle_id

    union all

    select
      cm.round,
      cm.committed_at,
      cm.draw_id,
      jsonb_build_object(
        'drawId', cm.draw_id,
        'round', cm.round,
        'state', public.sened_draw_state(cm.draw_id),
        'openedAt', cm.committed_at,
        'committedAt', cm.committed_at,
        'revealedAt', rv.revealed_at,
        'winnerMemberId', rv.winner_member_id,
        'sealCount', jsonb_array_length(coalesce(cm.member_commitments, '[]'::jsonb)),
        'nonceCount', 0,
        'revealRequested', false,
        'superseded', false,
        'legacy', true
      )
    from public.draw_commitments cm
    left join public.draw_reveals rv on rv.draw_id = cm.draw_id
    where cm.cycle_id = p_cycle_id
      and not exists (select 1 from public.draw_sessions s2 where s2.draw_id = cm.draw_id)
  ) as listing;

  return jsonb_build_object('cycle', public.sened_draw_cycle_json(cyc), 'draws', draw_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Opening a draw, and reading it
-- ---------------------------------------------------------------------------
create or replace function public.open_draw_v1(
  p_cycle_id uuid,
  p_round integer,
  p_idempotency_key text
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

  -- A draw still sealing for this round is continued, not duplicated.
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

  insert into public.draw_sessions (group_id, tenant_id, cycle_id, round, opened_by, idempotency_key)
  values (cyc.group_id, cyc.tenant_id, cyc.id, next_round, actor, p_idempotency_key)
  returning * into created_row;

  return jsonb_build_object(
    'session', public.sened_draw_session_view(created_row.draw_id),
    'replayed', false
  );
end;
$$;

create or replace function public.get_draw_session_v1(p_draw_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sess public.draw_sessions;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;
  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_found';
  end if;
  if not public.sened_ledger_can_access_group(sess.group_id, sess.tenant_id) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;
  return public.sened_draw_session_view(p_draw_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Member seal and nonce: identity is auth.uid(), never an argument
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

  -- Serialise with the commit: a seal either lands before it (and is in the
  -- committed set) or is refused after it.
  perform 1 from public.draw_sessions locked where locked.draw_id = p_draw_id for share;

  if p_sealed is null or p_sealed !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;
  if exists (select 1 from public.draw_commitments cm where cm.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_already_committed';
  end if;
  if not exists (
    select 1 from public.sened_draw_eligible_members(sess.group_id, sess.cycle_id, sess.round) as e(member_id)
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
-- 7. Commit from the stored seals
-- ---------------------------------------------------------------------------
create or replace function public.commit_draw_from_seals_v1(
  p_draw_id uuid,
  p_commitment text,
  p_commitment_nonce text,
  p_roster_digest text,
  p_member_digest text,
  p_participants jsonb,
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

  return jsonb_build_object(
    'round', public.sened_draw_round_response(created_row, null, null),
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Requesting the reveal: the only function that returns nonces
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
-- 9. reveal_draw_v1: same signature; a session-backed draw must reveal exactly
--    the seed and nonces that were published by open_draw_reveal_v1.
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

  -- A draw that has a session carries stored nonces: the reveal can be nothing
  -- other than what open_draw_reveal_v1 published. (Draws committed before
  -- sessions existed have none, and keep the rules below.)
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
-- 10. Privileges
-- ---------------------------------------------------------------------------
-- Internal helpers: never callable by a client role.
revoke all on function public.sened_draw_guard_seal() from public, anon, authenticated;
revoke all on function public.sened_draw_encode(text) from public, anon, authenticated;
revoke all on function public.sened_draw_line(text, text) from public, anon, authenticated;
revoke all on function public.sened_draw_member_seal_hash(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sened_draw_member_set_digest(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.sened_draw_commit_hash_v3(uuid, uuid, integer, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.sened_draw_ticket(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_state(uuid) from public, anon, authenticated;
revoke all on function public.sened_draw_eligible_members(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.sened_draw_cycle_json(public.draw_cycles) from public, anon, authenticated;
revoke all on function public.sened_draw_session_view(uuid) from public, anon, authenticated;

revoke all on function public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text) from public, anon;
revoke all on function public.list_draw_cycles_v1(uuid) from public, anon;
revoke all on function public.get_draw_cycle_v1(uuid) from public, anon;
revoke all on function public.open_draw_v1(uuid, integer, text) from public, anon;
revoke all on function public.get_draw_session_v1(uuid) from public, anon;
revoke all on function public.submit_draw_seal_v1(uuid, text) from public, anon;
revoke all on function public.submit_draw_nonce_v1(uuid, text) from public, anon;
revoke all on function public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text) from public, anon;
revoke all on function public.open_draw_reveal_v1(uuid, text) from public, anon;
revoke all on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) from public, anon;

grant execute on function public.create_draw_cycle_v1(uuid, text, numeric, integer, integer, timestamptz, text) to authenticated;
grant execute on function public.list_draw_cycles_v1(uuid) to authenticated;
grant execute on function public.get_draw_cycle_v1(uuid) to authenticated;
grant execute on function public.open_draw_v1(uuid, integer, text) to authenticated;
grant execute on function public.get_draw_session_v1(uuid) to authenticated;
grant execute on function public.submit_draw_seal_v1(uuid, text) to authenticated;
grant execute on function public.submit_draw_nonce_v1(uuid, text) to authenticated;
grant execute on function public.commit_draw_from_seals_v1(uuid, text, text, text, text, jsonb, text, timestamptz, text) to authenticated;
grant execute on function public.open_draw_reveal_v1(uuid, text) to authenticated;
grant execute on function public.reveal_draw_v1(uuid, text, text, text, jsonb, text, text, integer, uuid, text, numeric, numeric, timestamptz) to authenticated;

-- The client-seals commit is the path the stored seals replace. Not callable
-- through PostgREST any more; still defined for the database owner (history, and
-- the pre-session harness checks).
revoke all on function public.commit_draw_v1(uuid, uuid, integer, uuid, text, text, text, text, jsonb, jsonb, numeric, integer, integer, text, timestamptz, text) from public, anon, authenticated;
