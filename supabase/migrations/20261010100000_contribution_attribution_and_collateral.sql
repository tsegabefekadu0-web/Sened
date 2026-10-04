-- M4.2 completion: who paid a contribution that did not come through a bank
-- verification, and post-win collateral (guarantors and derived default flags).
--
-- A. MEMBER ATTRIBUTION FOR MANUAL CONTRIBUTIONS
--
--   A ledger entry's actor is whoever RECORDED it, never who paid. Until now a
--   contribution could name its payer only through bank-verification provenance
--   (bank_verification_intents.ledger_entry_id, read by
--   get_ledger_entry_provenance_v1). A treasurer's cash entry had no payer.
--
--   public.ledger_entry_attributions is an APPEND-ONLY record that lives BESIDE the
--   hash-chained entry. It does not touch ledger_entries, so no entry_hash or
--   previous_hash changes and nothing about the chain's format is different.
--
--   Rules (enforced in the RPCs AND again by a before-insert trigger, so a future
--   writer cannot bypass them):
--     * only an owner/treasurer of the entry's group records one;
--     * only for a `contribution` entry of that group (a foreign group's entry
--       reads as "not found", exactly like an absent one);
--     * the member must be an ACTIVE member of that same group;
--     * ONE attribution per entry. The first is the root row. A mistake is fixed
--       by an explicit SUPERSEDING row that names the row it replaces and carries
--       a reason of 10..1000 characters. Rows are never updated or deleted
--       (immutability triggers, like the draw tables);
--     * optional cycle id and round: which round of which cycle the payment is
--       FOR. A round needs a cycle; the cycle must be this group's.
--
--   PRECEDENCE: bank-verified provenance wins. An entry that has a VERIFIED bank
--   verification linked to it cannot be attributed by hand (attribution_bank_verified),
--   neither first nor by superseding. If a bank link appears AFTER a manual
--   attribution was recorded, the read functions still report the bank
--   verification as the effective attribution (priority 0 against 1), and the manual
--   row stays in the history unused. A treasurer's word is never shown as, or over,
--   a bank's.
--
--   A contribution already reversed by a correction cannot be newly attributed
--   (attribution_entry_corrected): crediting a payer for money that was reversed
--   would be a false statement.
--
-- B. COLLATERAL (social collateral and post-win default risk)
--
--   draw_collateral_guarantees   one immutable PROPOSAL: cycle, winner, guarantor,
--                                who proposed it.
--   draw_collateral_guarantee_events
--                                append-only EVENTS: accepted, declined, released,
--                                superseded. The state is the latest event, never a
--                                stored column, so there is no status to edit.
--
--   A guarantee without the guarantor's own consent is not a guarantee:
--     * only the owner/treasurer proposes (and supersedes);
--     * `accepted` and `declined` can ONLY be written by the guarantor (the actor
--       column must equal the guarantor, enforced by the RPC and by a trigger),
--       from the guarantor's own session; no role, treasurer included, can accept
--       for someone else;
--     * the guarantor must be an active member of the group and not the winner;
--     * the winner must actually have won a round of this cycle with rounds left;
--     * released (by the guarantor or the owner/treasurer) and superseded (owner/
--       treasurer, naming the replacement) are explicit events with a reason.
--   ADVISORY ONLY: nothing here debits a guarantor, moves money or touches the
--   ledger. It is a record of who vouched, shown to the group.
--
--   DEFAULT DERIVATION (sened_draw_cycle_collateral): nothing about "paid" or "in
--   default" is stored. get_draw_cycle_collateral_v1 derives, for every winner and
--   every round AFTER the one they won (the rounds they still owe):
--
--     met      a qualifying contribution is assigned to the round;
--     flagged  NOT met, and the round's draw has been OPENED (a draw session, or a
--              legacy commitment, exists for that round): the contribution was due;
--     not_due  NOT met and no draw for that round has been opened yet.
--
--   A qualifying contribution is a contribution entry that
--     (i)   is not reversed by a correction,
--     (ii)  is attributed to the winner: bank provenance or the current manual
--           attribution (the same precedence as above),
--     (iii) moved at least the cycle's contribution amount into POT_CASH (the sum of
--           its debit postings on POT_CASH),
--     (iv)  was RECORDED (server time, which cannot be backdated) on or after the
--           cycle's start, and
--     (v)   is not attributed to a different cycle.
--   It is assigned to a round either explicitly (a manual attribution carrying this
--   cycle and that round) or by order: the winner's remaining entries, oldest
--   first, each fill the earliest still-unmet DUE round whose previous round had
--   been revealed before the entry was recorded (an entry recorded before the
--   previous reveal cannot pay for a later round; one entry pays one round).
--
--   `flagged` is a flag, not a verdict: it says the ledger cannot show the
--   contribution, not that the member did not pay. It clears by itself the moment
--   an attributed entry exists.
--
-- DEPLOY ORDER: apply this migration together with the application release that
-- calls the new RPCs. The entries read calls get_ledger_entry_attributions_v1.

-- ---------------------------------------------------------------------------
-- 0. Shared helpers (never granted to a client role)
-- ---------------------------------------------------------------------------
create or replace function public.sened_ts_iso(p_ts timestamptz)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Like sened_ledger_can_manage_group, but for an explicit user rather than
-- auth.uid(): used by triggers, which validate the row's own actor columns.
create or replace function public.sened_ledger_user_manages_group(p_group_id uuid, p_user_id uuid)
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
      and (
        group_row.tenant_id = p_user_id
        or exists (
          select 1
          from public.ledger_group_memberships membership
          where membership.group_id = group_row.id
            and membership.tenant_id = group_row.tenant_id
            and membership.user_id = p_user_id
            and membership.status = 'active'
            and membership.role in ('owner', 'treasurer')
        )
      )
  );
$$;

create or replace function public.sened_ledger_is_active_member(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.ledger_group_memberships membership
    where membership.group_id = p_group_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- A1. The attribution table
-- ---------------------------------------------------------------------------
create table if not exists public.ledger_entry_attributions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  group_id uuid not null,
  tenant_id uuid not null,
  member_user_id uuid not null references auth.users (id) on delete restrict,
  recorded_by uuid not null references auth.users (id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  cycle_id uuid,
  round integer check (round between 1 and 1000),
  supersedes_id uuid,
  reason text,
  constraint ledger_attributions_id_group_key unique (id, group_id),
  constraint ledger_attributions_entry_fk
    foreign key (entry_id, group_id)
    references public.ledger_entries (id, group_id)
    on delete restrict,
  constraint ledger_attributions_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint ledger_attributions_cycle_fk
    foreign key (cycle_id, group_id)
    references public.draw_cycles (id, group_id)
    on delete restrict,
  constraint ledger_attributions_supersedes_fk
    foreign key (supersedes_id, group_id)
    references public.ledger_entry_attributions (id, group_id)
    on delete restrict,
  constraint ledger_attributions_round_needs_cycle check (round is null or cycle_id is not null),
  constraint ledger_attributions_supersede_shape check (
    (supersedes_id is null and reason is null)
    or (
      supersedes_id is not null
      and reason is not null
      and reason = btrim(reason)
      and char_length(reason) between 10 and 1000
    )
  )
);

-- One FIRST attribution per entry; each row can be superseded at most once, so
-- the history of an entry is a single line and its current value is the last row.
create unique index if not exists ledger_attributions_one_root_per_entry_idx
  on public.ledger_entry_attributions (entry_id)
  where supersedes_id is null;
create unique index if not exists ledger_attributions_one_successor_idx
  on public.ledger_entry_attributions (supersedes_id)
  where supersedes_id is not null;
create index if not exists ledger_attributions_member_idx
  on public.ledger_entry_attributions (group_id, member_user_id, recorded_at desc);
create index if not exists ledger_attributions_entry_idx
  on public.ledger_entry_attributions (entry_id);

comment on table public.ledger_entry_attributions is
  'Append-only: who paid a contribution entry that has no bank provenance, recorded by an owner/treasurer. Lives beside the hash-chained entry; never alters entry_hash. Corrected only by an explicit superseding row with a reason.';

alter table public.ledger_entry_attributions enable row level security;

create or replace function public.sened_attribution_block_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'attribution_history_immutable';
end;
$$;

drop trigger if exists ledger_entry_attributions_block_mutation on public.ledger_entry_attributions;
create trigger ledger_entry_attributions_block_mutation
before update or delete on public.ledger_entry_attributions
for each row execute function public.sened_attribution_block_mutation();

drop trigger if exists ledger_entry_attributions_block_truncate on public.ledger_entry_attributions;
create trigger ledger_entry_attributions_block_truncate
before truncate on public.ledger_entry_attributions
for each statement execute function public.sened_attribution_block_mutation();

-- Table-level invariants, so they hold for any writer and not only the RPCs.
create or replace function public.sened_attribution_validate_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  kind text;
  prior_entry uuid;
begin
  select entry_row.entry_type into kind
  from public.ledger_entries entry_row
  where entry_row.id = new.entry_id and entry_row.group_id = new.group_id;
  if kind is distinct from 'contribution' then
    raise exception using errcode = '22023', message = 'attribution_not_contribution';
  end if;
  if not public.sened_ledger_user_manages_group(new.group_id, new.recorded_by) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if not public.sened_ledger_is_active_member(new.group_id, new.member_user_id) then
    raise exception using errcode = 'P0002', message = 'ledger_member_not_found';
  end if;
  if exists (
    select 1
    from public.bank_verification_intents intent_row
    where intent_row.group_id = new.group_id
      and intent_row.ledger_entry_id = new.entry_id
      and intent_row.state = 'VERIFIED'
      and intent_row.verified_at is not null
  ) then
    raise exception using errcode = 'P0001', message = 'attribution_bank_verified';
  end if;
  if new.supersedes_id is not null then
    select prior.entry_id into prior_entry
    from public.ledger_entry_attributions prior
    where prior.id = new.supersedes_id;
    if prior_entry is distinct from new.entry_id then
      raise exception using errcode = '22023', message = 'ledger_invalid_request';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_entry_attributions_validate on public.ledger_entry_attributions;
create trigger ledger_entry_attributions_validate
before insert on public.ledger_entry_attributions
for each row execute function public.sened_attribution_validate_insert();

drop policy if exists "ledger attributions members read" on public.ledger_entry_attributions;
create policy "ledger attributions members read"
on public.ledger_entry_attributions
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

revoke all on table public.ledger_entry_attributions from anon, authenticated;
grant select on table public.ledger_entry_attributions to authenticated;

-- ---------------------------------------------------------------------------
-- A2. The effective attribution of one entry (bank first, then the manual tip)
-- ---------------------------------------------------------------------------
create or replace function public.sened_effective_attribution(p_group_id uuid, p_entry_id uuid)
returns table (
  member_user_id uuid,
  source text,
  recorded_by uuid,
  recorded_at timestamptz,
  cycle_id uuid,
  round integer,
  revision integer,
  reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select picked.member_user_id, picked.source, picked.recorded_by, picked.recorded_at,
         picked.cycle_id, picked.round, picked.revision, picked.reason
  from (
    select
      intent_row.user_id as member_user_id,
      'bank_verification'::text as source,
      entry_row.actor_id as recorded_by,
      intent_row.verified_at as recorded_at,
      null::uuid as cycle_id,
      null::integer as round,
      1 as revision,
      null::text as reason,
      0 as priority
    from public.bank_verification_intents intent_row
    join public.ledger_entries entry_row
      on entry_row.id = intent_row.ledger_entry_id and entry_row.group_id = intent_row.group_id
    where intent_row.group_id = p_group_id
      and intent_row.ledger_entry_id = p_entry_id
      and intent_row.state = 'VERIFIED'
      and intent_row.verified_at is not null
    union all
    select
      tip.member_user_id,
      'treasurer'::text,
      tip.recorded_by,
      tip.recorded_at,
      tip.cycle_id,
      tip.round,
      (select count(*)::integer from public.ledger_entry_attributions chain where chain.entry_id = tip.entry_id),
      tip.reason,
      1
    from public.ledger_entry_attributions tip
    where tip.group_id = p_group_id
      and tip.entry_id = p_entry_id
      and not exists (select 1 from public.ledger_entry_attributions later where later.supersedes_id = tip.id)
  ) picked
  order by picked.priority, picked.recorded_at, picked.member_user_id
  limit 1;
$$;

create or replace function public.sened_attribution_json(p_group_id uuid, p_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'entryId', p_entry_id,
    'memberUserId', eff.member_user_id,
    'source', eff.source,
    'recordedBy', eff.recorded_by,
    'recordedAt', public.sened_ts_iso(eff.recorded_at),
    'cycleId', eff.cycle_id,
    'round', eff.round,
    'revision', eff.revision,
    'reason', eff.reason
  )
  from public.sened_effective_attribution(p_group_id, p_entry_id) eff;
$$;

-- ---------------------------------------------------------------------------
-- A3. Reading (any active member of the group)
-- ---------------------------------------------------------------------------
create or replace function public.get_ledger_entry_attributions_v1(
  p_group_id uuid,
  p_entry_ids uuid[]
)
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
    raise exception using errcode = '28000', message = 'ledger_forbidden';
  end if;
  select group_row.tenant_id into tenant
  from public.ledger_groups group_row
  where group_row.id = p_group_id;
  if not found or not public.sened_ledger_can_access_group(p_group_id, tenant) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if p_entry_ids is null or cardinality(p_entry_ids) = 0 then
    return '[]'::jsonb;
  end if;
  if cardinality(p_entry_ids) > 500 then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  return coalesce(
    (
      select jsonb_agg(public.sened_attribution_json(entry_row.group_id, entry_row.id) order by entry_row.sequence)
      from public.ledger_entries entry_row
      where entry_row.group_id = p_group_id
        and entry_row.entry_type = 'contribution'
        and entry_row.id = any (p_entry_ids)
        and exists (select 1 from public.sened_effective_attribution(entry_row.group_id, entry_row.id))
    ),
    '[]'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- A4. Writing (owner/treasurer): record, and supersede with a reason
-- ---------------------------------------------------------------------------
-- Error contract (message, SQLSTATE):
--   ledger_forbidden               42501  no session, not an owner/treasurer of the group, or an unknown group
--   ledger_invalid_request         22023  null/bad argument, round without cycle, bad reason
--   attribution_not_contribution   22023  the entry is not a contribution
--   ledger_entry_not_found         P0002  no such entry in THIS group (another group's entry reads the same)
--   ledger_member_not_found        P0002  the member is not an active member of the group
--   ledger_cycle_not_found         P0002  the cycle is not this group's
--   attribution_bank_verified      P0001  a verified bank receipt already names the payer
--   attribution_entry_corrected    P0001  the contribution was reversed by a correction
--   attribution_exists             P0001  record: the entry already has a different attribution
--   attribution_not_found          P0002  supersede: there is nothing to supersede
--   attribution_unchanged          P0001  supersede: it would change nothing
--   attribution_conflict           P0001  a concurrent writer won
create or replace function public.sened_attribute_entry(
  p_mode text,
  p_group_id uuid,
  p_entry_id uuid,
  p_member_user_id uuid,
  p_cycle_id uuid,
  p_round integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
  entry_row public.ledger_entries;
  cyc public.draw_cycles;
  tip_row public.ledger_entry_attributions;
  clean_reason text;
  same_values boolean;
  has_tip boolean;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  select group_row.tenant_id into tenant
  from public.ledger_groups group_row
  where group_row.id = p_group_id;
  if not found or not public.sened_ledger_can_manage_group(p_group_id, tenant) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if p_entry_id is null or p_member_user_id is null
     or (p_round is not null and (p_cycle_id is null or p_round < 1 or p_round > 1000)) then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;
  if p_mode = 'supersede' then
    clean_reason := btrim(coalesce(p_reason, ''));
    if char_length(clean_reason) not between 10 and 1000 then
      raise exception using errcode = '22023', message = 'ledger_invalid_request';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sened-attribution:' || p_entry_id::text, 0));

  select ledger_row.* into entry_row
  from public.ledger_entries ledger_row
  where ledger_row.id = p_entry_id and ledger_row.group_id = p_group_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_entry_not_found';
  end if;
  if entry_row.entry_type <> 'contribution' then
    raise exception using errcode = '22023', message = 'attribution_not_contribution';
  end if;
  if not public.sened_ledger_is_active_member(p_group_id, p_member_user_id) then
    raise exception using errcode = 'P0002', message = 'ledger_member_not_found';
  end if;
  if p_cycle_id is not null then
    select cycle_row.* into cyc
    from public.draw_cycles cycle_row
    where cycle_row.id = p_cycle_id and cycle_row.group_id = p_group_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'ledger_cycle_not_found';
    end if;
    if p_round is not null and p_round > cyc.total_rounds then
      raise exception using errcode = '22023', message = 'ledger_invalid_request';
    end if;
  end if;
  if exists (
    select 1 from public.ledger_entries fix
    where fix.group_id = p_group_id and fix.corrects_entry_id = p_entry_id
  ) then
    raise exception using errcode = 'P0001', message = 'attribution_entry_corrected';
  end if;
  if exists (
    select 1
    from public.bank_verification_intents intent_row
    where intent_row.group_id = p_group_id
      and intent_row.ledger_entry_id = p_entry_id
      and intent_row.state = 'VERIFIED'
      and intent_row.verified_at is not null
  ) then
    raise exception using errcode = 'P0001', message = 'attribution_bank_verified';
  end if;

  select tip.* into tip_row
  from public.ledger_entry_attributions tip
  where tip.entry_id = p_entry_id
    and not exists (select 1 from public.ledger_entry_attributions later where later.supersedes_id = tip.id);
  has_tip := found;
  if has_tip then
    same_values := tip_row.member_user_id = p_member_user_id
      and tip_row.cycle_id is not distinct from p_cycle_id
      and tip_row.round is not distinct from p_round;
  end if;

  if p_mode = 'record' then
    if has_tip then
      if same_values then
        return jsonb_build_object('attribution', public.sened_attribution_json(p_group_id, p_entry_id), 'replayed', true);
      end if;
      raise exception using errcode = 'P0001', message = 'attribution_exists';
    end if;
    insert into public.ledger_entry_attributions
      (entry_id, group_id, tenant_id, member_user_id, recorded_by, cycle_id, round)
    values
      (p_entry_id, p_group_id, tenant, p_member_user_id, actor, p_cycle_id, p_round);
  elsif p_mode = 'supersede' then
    if not has_tip then
      raise exception using errcode = 'P0002', message = 'attribution_not_found';
    end if;
    if same_values then
      if tip_row.supersedes_id is not null and tip_row.reason = clean_reason and tip_row.recorded_by = actor then
        return jsonb_build_object('attribution', public.sened_attribution_json(p_group_id, p_entry_id), 'replayed', true);
      end if;
      raise exception using errcode = 'P0001', message = 'attribution_unchanged';
    end if;
    insert into public.ledger_entry_attributions
      (entry_id, group_id, tenant_id, member_user_id, recorded_by, cycle_id, round, supersedes_id, reason)
    values
      (p_entry_id, p_group_id, tenant, p_member_user_id, actor, p_cycle_id, p_round, tip_row.id, clean_reason);
  else
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  return jsonb_build_object('attribution', public.sened_attribution_json(p_group_id, p_entry_id), 'replayed', false);
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'attribution_conflict';
end;
$$;

create or replace function public.record_ledger_entry_attribution_v1(
  p_group_id uuid,
  p_entry_id uuid,
  p_member_user_id uuid,
  p_cycle_id uuid default null,
  p_round integer default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.sened_attribute_entry('record', p_group_id, p_entry_id, p_member_user_id, p_cycle_id, p_round, null);
$$;

create or replace function public.supersede_ledger_entry_attribution_v1(
  p_group_id uuid,
  p_entry_id uuid,
  p_member_user_id uuid,
  p_reason text,
  p_cycle_id uuid default null,
  p_round integer default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.sened_attribute_entry('supersede', p_group_id, p_entry_id, p_member_user_id, p_cycle_id, p_round, p_reason);
$$;

-- ---------------------------------------------------------------------------
-- B1. Guarantee tables (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.draw_collateral_guarantees (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  tenant_id uuid not null,
  cycle_id uuid not null,
  winner_member_id uuid not null references auth.users (id) on delete restrict,
  guarantor_member_id uuid not null references auth.users (id) on delete restrict,
  proposed_by uuid not null references auth.users (id) on delete restrict,
  proposed_at timestamptz not null default clock_timestamp(),
  constraint draw_guarantees_id_group_key unique (id, group_id),
  constraint draw_guarantees_guarantor_not_winner check (guarantor_member_id <> winner_member_id),
  constraint draw_guarantees_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint draw_guarantees_cycle_fk
    foreign key (cycle_id, group_id)
    references public.draw_cycles (id, group_id)
    on delete restrict
);

create index if not exists draw_guarantees_cycle_winner_idx
  on public.draw_collateral_guarantees (cycle_id, winner_member_id, proposed_at);
create index if not exists draw_guarantees_guarantor_idx
  on public.draw_collateral_guarantees (group_id, guarantor_member_id);

create table if not exists public.draw_collateral_guarantee_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  guarantee_id uuid not null,
  group_id uuid not null,
  event_type text not null check (event_type in ('accepted', 'declined', 'released', 'superseded')),
  actor_id uuid not null references auth.users (id) on delete restrict,
  reason text,
  successor_guarantee_id uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint draw_guarantee_events_guarantee_fk
    foreign key (guarantee_id, group_id)
    references public.draw_collateral_guarantees (id, group_id)
    on delete restrict,
  constraint draw_guarantee_events_successor_fk
    foreign key (successor_guarantee_id)
    references public.draw_collateral_guarantees (id)
    on delete restrict
    deferrable initially deferred,
  constraint draw_guarantee_events_reason_shape check (
    (event_type = 'accepted' and reason is null)
    or (event_type = 'declined' and (reason is null or (reason = btrim(reason) and char_length(reason) between 1 and 1000)))
    or (event_type in ('released', 'superseded') and reason is not null
        and reason = btrim(reason) and char_length(reason) between 10 and 1000)
  ),
  constraint draw_guarantee_events_successor_shape check (
    (event_type = 'superseded' and successor_guarantee_id is not null)
    or (event_type <> 'superseded' and successor_guarantee_id is null)
  )
);

-- A guarantee is accepted at most once and ends at most once.
create unique index if not exists draw_guarantee_events_one_accept_idx
  on public.draw_collateral_guarantee_events (guarantee_id)
  where event_type = 'accepted';
create unique index if not exists draw_guarantee_events_one_end_idx
  on public.draw_collateral_guarantee_events (guarantee_id)
  where event_type in ('declined', 'released', 'superseded');
create index if not exists draw_guarantee_events_guarantee_seq_idx
  on public.draw_collateral_guarantee_events (guarantee_id, seq desc);

comment on table public.draw_collateral_guarantees is
  'Advisory social collateral: one immutable proposal that a member vouches for a winner''s remaining contributions. Never moves money.';
comment on table public.draw_collateral_guarantee_events is
  'Append-only events of a guarantee. accepted/declined are written only by the guarantor (own consent); released/superseded carry a reason. The state is the latest event.';

alter table public.draw_collateral_guarantees enable row level security;
alter table public.draw_collateral_guarantee_events enable row level security;

create or replace function public.sened_collateral_block_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'collateral_history_immutable';
end;
$$;

drop trigger if exists draw_collateral_guarantees_block_mutation on public.draw_collateral_guarantees;
create trigger draw_collateral_guarantees_block_mutation
before update or delete on public.draw_collateral_guarantees
for each row execute function public.sened_collateral_block_mutation();

drop trigger if exists draw_collateral_guarantee_events_block_mutation on public.draw_collateral_guarantee_events;
create trigger draw_collateral_guarantee_events_block_mutation
before update or delete on public.draw_collateral_guarantee_events
for each row execute function public.sened_collateral_block_mutation();

drop trigger if exists draw_collateral_guarantees_block_truncate on public.draw_collateral_guarantees;
create trigger draw_collateral_guarantees_block_truncate
before truncate on public.draw_collateral_guarantees
for each statement execute function public.sened_collateral_block_mutation();

drop trigger if exists draw_collateral_guarantee_events_block_truncate on public.draw_collateral_guarantee_events;
create trigger draw_collateral_guarantee_events_block_truncate
before truncate on public.draw_collateral_guarantee_events
for each statement execute function public.sened_collateral_block_mutation();

-- The state of a guarantee: its latest event, or 'proposed' while there is none.
create or replace function public.sened_collateral_guarantee_state(p_guarantee_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select ev.event_type
      from public.draw_collateral_guarantee_events ev
      where ev.guarantee_id = p_guarantee_id
      order by ev.seq desc
      limit 1
    ),
    'proposed'
  );
$$;

-- The round a member won in a cycle (their earliest revealed draw), or null.
create or replace function public.sened_collateral_win_round(p_cycle_id uuid, p_member_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select min(cm.round)
  from public.draw_commitments cm
  join public.draw_reveals rv on rv.draw_id = cm.draw_id
  where cm.cycle_id = p_cycle_id
    and rv.winner_member_id = p_member_id;
$$;

-- Backstop for a new proposal, independent of which function wrote it.
create or replace function public.sened_collateral_validate_guarantee()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  win_round integer;
  total integer;
  open_count integer;
begin
  if not public.sened_ledger_user_manages_group(new.group_id, new.proposed_by) then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  if not public.sened_ledger_is_active_member(new.group_id, new.guarantor_member_id) then
    raise exception using errcode = 'P0002', message = 'collateral_member_not_found';
  end if;
  win_round := public.sened_collateral_win_round(new.cycle_id, new.winner_member_id);
  if win_round is null then
    raise exception using errcode = 'P0001', message = 'collateral_winner_not_found';
  end if;
  select cycle_row.total_rounds into total from public.draw_cycles cycle_row where cycle_row.id = new.cycle_id;
  if win_round >= total then
    raise exception using errcode = 'P0001', message = 'collateral_no_remaining_rounds';
  end if;
  if exists (
    select 1
    from public.draw_collateral_guarantees other
    where other.cycle_id = new.cycle_id
      and other.winner_member_id = new.winner_member_id
      and other.guarantor_member_id = new.guarantor_member_id
      and other.id <> new.id
      and public.sened_collateral_guarantee_state(other.id) in ('proposed', 'accepted')
  ) then
    raise exception using errcode = 'P0001', message = 'collateral_exists';
  end if;
  select count(*) into open_count
  from public.draw_collateral_guarantees other
  where other.cycle_id = new.cycle_id
    and other.winner_member_id = new.winner_member_id
    and other.id <> new.id
    and public.sened_collateral_guarantee_state(other.id) in ('proposed', 'accepted');
  if open_count >= 5 then
    raise exception using errcode = 'P0001', message = 'collateral_limit';
  end if;
  return new;
end;
$$;

drop trigger if exists draw_collateral_guarantees_validate on public.draw_collateral_guarantees;
create trigger draw_collateral_guarantees_validate
before insert on public.draw_collateral_guarantees
for each row execute function public.sened_collateral_validate_guarantee();

-- Backstop for an event: WHO may write which event, and which transitions exist.
-- This is where "the guarantor must consent themselves" is held at table level.
create or replace function public.sened_collateral_validate_event()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  guarantee_row public.draw_collateral_guarantees;
  current_state text;
begin
  select gr.* into guarantee_row
  from public.draw_collateral_guarantees gr
  where gr.id = new.guarantee_id;
  if not found or guarantee_row.group_id <> new.group_id then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  current_state := public.sened_collateral_guarantee_state(new.guarantee_id);

  if new.event_type in ('accepted', 'declined') then
    if new.actor_id <> guarantee_row.guarantor_member_id
       or not public.sened_ledger_is_active_member(new.group_id, new.actor_id) then
      raise exception using errcode = '42501', message = 'collateral_forbidden';
    end if;
    if current_state <> 'proposed' then
      raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
    end if;
  elsif new.event_type = 'released' then
    if not (
      (new.actor_id = guarantee_row.guarantor_member_id and public.sened_ledger_is_active_member(new.group_id, new.actor_id))
      or public.sened_ledger_user_manages_group(new.group_id, new.actor_id)
    ) then
      raise exception using errcode = '42501', message = 'collateral_forbidden';
    end if;
    if current_state not in ('proposed', 'accepted') then
      raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
    end if;
  else
    if not public.sened_ledger_user_manages_group(new.group_id, new.actor_id) then
      raise exception using errcode = '42501', message = 'collateral_forbidden';
    end if;
    if current_state not in ('proposed', 'accepted') then
      raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists draw_collateral_guarantee_events_validate on public.draw_collateral_guarantee_events;
create trigger draw_collateral_guarantee_events_validate
before insert on public.draw_collateral_guarantee_events
for each row execute function public.sened_collateral_validate_event();

drop policy if exists "draw guarantees members read" on public.draw_collateral_guarantees;
create policy "draw guarantees members read"
on public.draw_collateral_guarantees
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "draw guarantee events members read" on public.draw_collateral_guarantee_events;
create policy "draw guarantee events members read"
on public.draw_collateral_guarantee_events
for select
to authenticated
using (
  exists (
    select 1
    from public.draw_collateral_guarantees gr
    where gr.id = draw_collateral_guarantee_events.guarantee_id
      and public.sened_ledger_can_access_group(gr.group_id, gr.tenant_id)
  )
);

revoke all on table public.draw_collateral_guarantees from anon, authenticated;
revoke all on table public.draw_collateral_guarantee_events from anon, authenticated;
grant select on table public.draw_collateral_guarantees to authenticated;
grant select on table public.draw_collateral_guarantee_events to authenticated;

create or replace function public.sened_collateral_guarantee_json(p_guarantee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'guaranteeId', gr.id,
    'cycleId', gr.cycle_id,
    'winnerMemberId', gr.winner_member_id,
    'guarantorMemberId', gr.guarantor_member_id,
    'proposedBy', gr.proposed_by,
    'proposedAt', public.sened_ts_iso(gr.proposed_at),
    'state', coalesce(last_event.event_type, 'proposed'),
    'stateAt', public.sened_ts_iso(coalesce(last_event.occurred_at, gr.proposed_at)),
    'stateBy', coalesce(last_event.actor_id, gr.proposed_by),
    'acceptedAt', (
      select public.sened_ts_iso(acc.occurred_at)
      from public.draw_collateral_guarantee_events acc
      where acc.guarantee_id = gr.id and acc.event_type = 'accepted'
    ),
    'reason', last_event.reason,
    'successorGuaranteeId', last_event.successor_guarantee_id
  )
  from public.draw_collateral_guarantees gr
  left join lateral (
    select ev.event_type, ev.occurred_at, ev.actor_id, ev.reason, ev.successor_guarantee_id
    from public.draw_collateral_guarantee_events ev
    where ev.guarantee_id = gr.id
    order by ev.seq desc
    limit 1
  ) last_event on true
  where gr.id = p_guarantee_id;
$$;

-- ---------------------------------------------------------------------------
-- B2. Guarantee RPCs
-- ---------------------------------------------------------------------------
-- Error contract (message, SQLSTATE):
--   collateral_forbidden            42501  no session / not allowed / unknown id (an unknown guarantee reads the same)
--   collateral_invalid_request      22023  null argument, bad reason, guarantor is the winner
--   collateral_member_not_found     P0002  the guarantor is not an active member
--   collateral_winner_not_found     P0001  the member has not won a round of this cycle
--   collateral_no_remaining_rounds  P0001  they won the last round: nothing left to guarantee
--   collateral_cycle_closed         P0001  the cycle is closed
--   collateral_exists               P0001  that guarantor already has an open guarantee for that winner
--   collateral_limit                P0001  five open guarantees per winner
--   collateral_state_conflict       P0001  the transition does not exist from the current state
create or replace function public.propose_collateral_guarantee_v1(
  p_cycle_id uuid,
  p_winner_member_id uuid,
  p_guarantor_member_id uuid
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
  win_round integer;
  existing_id uuid;
  created_id uuid;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  select cycle_row.* into cyc from public.draw_cycles cycle_row where cycle_row.id = p_cycle_id;
  if found then
    select group_row.tenant_id into tenant from public.ledger_groups group_row where group_row.id = cyc.group_id;
  end if;
  if not found or not public.sened_ledger_can_manage_group(cyc.group_id, tenant) then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  if p_winner_member_id is null or p_guarantor_member_id is null or p_winner_member_id = p_guarantor_member_id then
    raise exception using errcode = '22023', message = 'collateral_invalid_request';
  end if;

  perform 1 from public.draw_cycles locked where locked.id = p_cycle_id for update;

  if cyc.closed_at is not null then
    raise exception using errcode = 'P0001', message = 'collateral_cycle_closed';
  end if;
  win_round := public.sened_collateral_win_round(p_cycle_id, p_winner_member_id);
  if win_round is null then
    raise exception using errcode = 'P0001', message = 'collateral_winner_not_found';
  end if;
  if win_round >= cyc.total_rounds then
    raise exception using errcode = 'P0001', message = 'collateral_no_remaining_rounds';
  end if;
  if not public.sened_ledger_is_active_member(cyc.group_id, p_guarantor_member_id) then
    raise exception using errcode = 'P0002', message = 'collateral_member_not_found';
  end if;

  select gr.id into existing_id
  from public.draw_collateral_guarantees gr
  where gr.cycle_id = p_cycle_id
    and gr.winner_member_id = p_winner_member_id
    and gr.guarantor_member_id = p_guarantor_member_id
    and public.sened_collateral_guarantee_state(gr.id) in ('proposed', 'accepted')
  limit 1;
  if found then
    return jsonb_build_object('guarantee', public.sened_collateral_guarantee_json(existing_id), 'replayed', true);
  end if;

  insert into public.draw_collateral_guarantees
    (group_id, tenant_id, cycle_id, winner_member_id, guarantor_member_id, proposed_by)
  values
    (cyc.group_id, tenant, p_cycle_id, p_winner_member_id, p_guarantor_member_id, actor)
  returning id into created_id;

  return jsonb_build_object('guarantee', public.sened_collateral_guarantee_json(created_id), 'replayed', false);
end;
$$;

-- THE GUARANTOR'S OWN CONSENT. The caller's identity is auth.uid() and must BE the
-- guarantor: an owner or treasurer cannot accept (or decline) on someone's behalf.
create or replace function public.respond_collateral_guarantee_v1(
  p_guarantee_id uuid,
  p_accept boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  guarantee_row public.draw_collateral_guarantees;
  current_state text;
  clean_reason text;
  wanted text;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  select gr.* into guarantee_row from public.draw_collateral_guarantees gr where gr.id = p_guarantee_id;
  if not found
     or guarantee_row.guarantor_member_id <> actor
     or not public.sened_ledger_is_active_member(guarantee_row.group_id, actor) then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  if p_accept is null then
    raise exception using errcode = '22023', message = 'collateral_invalid_request';
  end if;
  wanted := case when p_accept then 'accepted' else 'declined' end;
  clean_reason := case when p_accept then null else nullif(btrim(coalesce(p_reason, '')), '') end;
  if clean_reason is not null and char_length(clean_reason) > 1000 then
    raise exception using errcode = '22023', message = 'collateral_invalid_request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sened-guarantee:' || p_guarantee_id::text, 0));
  current_state := public.sened_collateral_guarantee_state(p_guarantee_id);
  if current_state = wanted then
    return jsonb_build_object('guarantee', public.sened_collateral_guarantee_json(p_guarantee_id), 'replayed', true);
  end if;
  if current_state <> 'proposed' then
    raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
  end if;

  insert into public.draw_collateral_guarantee_events (guarantee_id, group_id, event_type, actor_id, reason)
  values (p_guarantee_id, guarantee_row.group_id, wanted, actor, clean_reason);

  return jsonb_build_object('guarantee', public.sened_collateral_guarantee_json(p_guarantee_id), 'replayed', false);
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
end;
$$;


-- Released by the guarantor (withdrawing their own word) or by an owner/treasurer,
-- always with a reason. A guarantee that already ended cannot be released again.
create or replace function public.release_collateral_guarantee_v1(
  p_guarantee_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  guarantee_row public.draw_collateral_guarantees;
  current_state text;
  clean_reason text;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  select gr.* into guarantee_row from public.draw_collateral_guarantees gr where gr.id = p_guarantee_id;
  if not found or not (
    (guarantee_row.guarantor_member_id = actor and public.sened_ledger_is_active_member(guarantee_row.group_id, actor))
    or public.sened_ledger_user_manages_group(guarantee_row.group_id, actor)
  ) then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  clean_reason := btrim(coalesce(p_reason, ''));
  if char_length(clean_reason) not between 10 and 1000 then
    raise exception using errcode = '22023', message = 'collateral_invalid_request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sened-guarantee:' || p_guarantee_id::text, 0));
  current_state := public.sened_collateral_guarantee_state(p_guarantee_id);
  if current_state = 'released' then
    return jsonb_build_object('guarantee', public.sened_collateral_guarantee_json(p_guarantee_id), 'replayed', true);
  end if;
  if current_state not in ('proposed', 'accepted') then
    raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
  end if;

  insert into public.draw_collateral_guarantee_events (guarantee_id, group_id, event_type, actor_id, reason)
  values (p_guarantee_id, guarantee_row.group_id, 'released', actor, clean_reason);

  return jsonb_build_object('guarantee', public.sened_collateral_guarantee_json(p_guarantee_id), 'replayed', false);
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
end;
$$;

-- Replace a guarantor: the old guarantee ends as `superseded` (pointing at its
-- successor) and a new proposal for the new guarantor begins, which that member
-- must accept themselves. Owner/treasurer only.
create or replace function public.supersede_collateral_guarantee_v1(
  p_guarantee_id uuid,
  p_new_guarantor_member_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  guarantee_row public.draw_collateral_guarantees;
  cyc public.draw_cycles;
  current_state text;
  clean_reason text;
  successor_id uuid;
  new_id uuid;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  select gr.* into guarantee_row from public.draw_collateral_guarantees gr where gr.id = p_guarantee_id;
  if not found or not public.sened_ledger_user_manages_group(guarantee_row.group_id, actor) then
    raise exception using errcode = '42501', message = 'collateral_forbidden';
  end if;
  clean_reason := btrim(coalesce(p_reason, ''));
  if p_new_guarantor_member_id is null
     or p_new_guarantor_member_id = guarantee_row.winner_member_id
     or p_new_guarantor_member_id = guarantee_row.guarantor_member_id
     or char_length(clean_reason) not between 10 and 1000 then
    raise exception using errcode = '22023', message = 'collateral_invalid_request';
  end if;

  perform 1 from public.draw_cycles locked where locked.id = guarantee_row.cycle_id for update;
  select cycle_row.* into cyc from public.draw_cycles cycle_row where cycle_row.id = guarantee_row.cycle_id;
  current_state := public.sened_collateral_guarantee_state(p_guarantee_id);

  if current_state = 'superseded' then
    -- A repeat of the same replacement is a replay; anything else is a conflict.
    select ev.successor_guarantee_id into successor_id
    from public.draw_collateral_guarantee_events ev
    where ev.guarantee_id = p_guarantee_id and ev.event_type = 'superseded';
    if exists (
      select 1 from public.draw_collateral_guarantees successor
      where successor.id = successor_id and successor.guarantor_member_id = p_new_guarantor_member_id
    ) then
      return jsonb_build_object(
        'guarantee', public.sened_collateral_guarantee_json(successor_id),
        'superseded', public.sened_collateral_guarantee_json(p_guarantee_id),
        'replayed', true
      );
    end if;
  end if;
  if current_state not in ('proposed', 'accepted') then
    raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
  end if;
  if cyc.closed_at is not null then
    raise exception using errcode = 'P0001', message = 'collateral_cycle_closed';
  end if;
  if not public.sened_ledger_is_active_member(guarantee_row.group_id, p_new_guarantor_member_id) then
    raise exception using errcode = 'P0002', message = 'collateral_member_not_found';
  end if;

  new_id := gen_random_uuid();
  -- The successor foreign key is deferred, so the ending event may be written first
  -- (which also frees the old guarantee's slot before the new proposal is counted).
  insert into public.draw_collateral_guarantee_events
    (guarantee_id, group_id, event_type, actor_id, reason, successor_guarantee_id)
  values
    (p_guarantee_id, guarantee_row.group_id, 'superseded', actor, clean_reason, new_id);
  insert into public.draw_collateral_guarantees
    (id, group_id, tenant_id, cycle_id, winner_member_id, guarantor_member_id, proposed_by)
  values
    (new_id, guarantee_row.group_id, guarantee_row.tenant_id, guarantee_row.cycle_id,
     guarantee_row.winner_member_id, p_new_guarantor_member_id, actor);

  return jsonb_build_object(
    'guarantee', public.sened_collateral_guarantee_json(new_id),
    'superseded', public.sened_collateral_guarantee_json(p_guarantee_id),
    'replayed', false
  );
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'collateral_state_conflict';
end;
$$;

-- ---------------------------------------------------------------------------
-- B3. The derived collateral view (any active member of the group)
-- ---------------------------------------------------------------------------
-- The contribution entries that can count toward `p_member_id`'s obligations in a
-- cycle. See the header for the five conditions. `round` is the explicit round of
-- a manual attribution, or null (assigned by order).
create or replace function public.sened_collateral_member_entries(p_cycle_id uuid, p_member_id uuid)
returns table (
  entry_id uuid,
  recorded_at timestamptz,
  source text,
  round integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select entry_row.id, entry_row.recorded_at, eff.source, eff.round
  from public.draw_cycles cyc
  join public.ledger_entries entry_row
    on entry_row.group_id = cyc.group_id
   and entry_row.entry_type = 'contribution'
   and entry_row.recorded_at >= cyc.started_at
  cross join lateral public.sened_effective_attribution(entry_row.group_id, entry_row.id) eff
  where cyc.id = p_cycle_id
    and eff.member_user_id = p_member_id
    and (eff.cycle_id is null or eff.cycle_id = cyc.id)
    and not exists (
      select 1 from public.ledger_entries fix
      where fix.group_id = entry_row.group_id and fix.corrects_entry_id = entry_row.id
    )
    and (
      select coalesce(sum(posting.amount), 0)
      from public.ledger_entry_postings posting
      join public.ledger_accounts account_row
        on account_row.id = posting.account_id and account_row.group_id = posting.group_id
      where posting.entry_id = entry_row.id
        and posting.direction = 'debit'
        and account_row.code = 'POT_CASH'
    ) >= greatest(coalesce(cyc.contribution_amount, 0.01), 0.01);
$$;

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
  owed jsonb;
  winners jsonb := '[]'::jsonb;
  guarantees jsonb;
  used uuid[];
  round_no integer;
  due_at timestamptz;
  prev_at timestamptz;
  found_entry uuid;
  found_source text;
  status text;
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
    used := array[]::uuid[];

    for round_no in (winner_row.win_round + 1) .. cyc.total_rounds loop
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
      -- Explicitly assigned to this round by a manual attribution.
      select c.entry_id, c.source into found_entry, found_source
      from public.sened_collateral_member_entries(p_cycle_id, winner_row.member_id) c
      where c.round = round_no
      order by c.recorded_at, c.entry_id
      limit 1;
      -- Otherwise the oldest unused unassigned entry recorded after the previous reveal.
      if found_entry is null and due_at is not null and prev_at is not null then
        select c.entry_id, c.source into found_entry, found_source
        from public.sened_collateral_member_entries(p_cycle_id, winner_row.member_id) c
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
        flagged := flagged + 1;
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
-- Grants. Helpers are never granted to a client role; RPCs only to signed-in users.
-- ---------------------------------------------------------------------------
revoke all on function public.sened_ts_iso(timestamptz) from public, anon, authenticated;
revoke all on function public.sened_ledger_user_manages_group(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_ledger_is_active_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_attribution_block_mutation() from public, anon, authenticated;
revoke all on function public.sened_attribution_validate_insert() from public, anon, authenticated;
revoke all on function public.sened_effective_attribution(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_attribution_json(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.sened_collateral_block_mutation() from public, anon, authenticated;
revoke all on function public.sened_collateral_guarantee_state(uuid) from public, anon, authenticated;
revoke all on function public.sened_collateral_win_round(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_collateral_validate_guarantee() from public, anon, authenticated;
revoke all on function public.sened_collateral_validate_event() from public, anon, authenticated;
revoke all on function public.sened_collateral_guarantee_json(uuid) from public, anon, authenticated;
revoke all on function public.sened_collateral_member_entries(uuid, uuid) from public, anon, authenticated;

revoke all on function public.get_ledger_entry_attributions_v1(uuid, uuid[]) from public, anon;
revoke all on function public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer) from public, anon;
revoke all on function public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer) from public, anon;
revoke all on function public.propose_collateral_guarantee_v1(uuid, uuid, uuid) from public, anon;
revoke all on function public.respond_collateral_guarantee_v1(uuid, boolean, text) from public, anon;
revoke all on function public.release_collateral_guarantee_v1(uuid, text) from public, anon;
revoke all on function public.supersede_collateral_guarantee_v1(uuid, uuid, text) from public, anon;
revoke all on function public.get_draw_cycle_collateral_v1(uuid) from public, anon;

grant execute on function public.get_ledger_entry_attributions_v1(uuid, uuid[]) to authenticated;
grant execute on function public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer) to authenticated;
grant execute on function public.propose_collateral_guarantee_v1(uuid, uuid, uuid) to authenticated;
grant execute on function public.respond_collateral_guarantee_v1(uuid, boolean, text) to authenticated;
grant execute on function public.release_collateral_guarantee_v1(uuid, text) to authenticated;
grant execute on function public.supersede_collateral_guarantee_v1(uuid, uuid, text) to authenticated;
grant execute on function public.get_draw_cycle_collateral_v1(uuid) to authenticated;
