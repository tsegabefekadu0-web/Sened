-- M4.2 follow-up: HOW a manual contribution was paid (channel) and a short note,
-- recorded beside the entry.
--
-- WHERE IT LIVES
--
--   Two columns on public.ledger_entry_attributions (20261010100000), not a new
--   table and not the ledger entry. Why:
--
--     * The entry's format is hash-chained. Adding a channel or note to
--       ledger_entries or its postings would change what entry_hash covers.
--       Nothing here touches ledger_entries, so no hash and no chain head moves.
--     * The attribution row already IS the per-contribution metadata record, with
--       the semantics channel and note need: append-only (update/delete/truncate
--       refused), a single line of history per entry, and correction only by a
--       superseding row that names the row it replaces and carries a reason of 10..1000
--       characters. A sibling table would copy all of that (table, immutability
--       triggers, unique indexes, RLS, two RPCs, a read function) and then have to be
--       kept consistent with the attribution it describes.
--     * The only cost of not splitting is that a channel/note cannot exist without a
--       payer. That matches every writer: the record form and the offline draft both
--       REQUIRE a payer for a contribution, and the treasurer-side "who paid"
--       control is the one place that corrects it.
--
--   Existing rows keep channel = null and note = null (a column add is not an UPDATE,
--   so the immutability trigger is not involved). Nothing is rewritten.
--
-- THE VALUES
--
--   channel  one of telebirr | cbe | awash | cash | other, or null (not said). The
--            first three are the bank_verification_intents providers.
--   note     optional text, trimmed, 1..280 characters, NO control characters
--            (C0, DEL, C1) and no invisible bidirectional/zero-width formatting
--            characters (U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF), so a note
--            is one honest line that renders as written. It is data, never markup.
--
--   Both are enforced twice: here, as CHECK constraints on the table (any writer), and
--   in the RPC (a refusal is `ledger_invalid_request`, 22023, like every other bad
--   argument).
--
-- PROVENANCE RULE (decision: REFUSE, do not merely ignore)
--
--   A bank-verified entry's channel is the PROVIDER of the verification (telebirr, cbe
--   or awash), and the treasurer's word is never shown as, or over, a bank's
--   (20261010100000). So:
--
--     * record and supersede are refused with `attribution_bank_verified` for an
--       entry a verified bank receipt names, whatever channel or note they carry. A
--       manual channel can therefore never contradict the provenance: it cannot be
--       written at all. (Refusing is stricter than "refuse only a contradicting
--       channel" and needs no second rule to keep consistent. A note on a verified
--       entry is refused too: the bank row has no note.)
--     * if a bank link appears AFTER a manual row was recorded, the read functions
--       report the bank: `channel` is the verification's provider and `note` is null.
--       The manual row, with its channel and note, stays in the history unused.
--
-- RPC CHANGES (additive; one signature each, so PostgREST has nothing to choose
-- between)
--
--   record_ledger_entry_attribution_v1(group, entry, member, cycle, round
--                                      [, channel, note])
--   supersede_ledger_entry_attribution_v1(group, entry, member, reason, cycle, round
--                                         [, channel, note])
--
--   The old arities are dropped and recreated with the two new parameters defaulting to
--   null, so a caller that sends nothing new behaves as before.
--
--   record: a null/empty channel or note means none. An attribution that repeats the
--   existing one INCLUDING channel and note is a replay (replayed: true), not a second
--   row; one that differs in any of member, cycle, round, channel or note is
--   `attribution_exists`.
--
--   supersede: channel and note are KEPT when the argument is null (so a correction of
--   the payer alone does not silently wipe them) and CLEARED when it is the empty
--   string. The superseding row stores the resulting full state. A correction that
--   changes none of member, cycle, round, channel, note is `attribution_unchanged`; the
--   same correction repeated by the same actor with the same reason is a replay.
--
-- READ: sened_attribution_json (and so get_ledger_entry_attributions_v1) gains
-- `channel` and `note` keys. sened_effective_attribution is NOT changed (its return
-- type is part of an earlier migration that the idempotency pass re-applies), so the
-- channel/note come from a small sibling helper.
--
-- DEPLOY ORDER: apply this migration together with the application release that sends
-- and reads channel/note. An older application keeps working against it (it never sends
-- the new arguments and ignores the new keys).

-- ---------------------------------------------------------------------------
-- 1. Columns and table-level constraints
-- ---------------------------------------------------------------------------
alter table public.ledger_entry_attributions add column if not exists channel text;
alter table public.ledger_entry_attributions add column if not exists note text;

alter table public.ledger_entry_attributions drop constraint if exists ledger_attributions_channel_values;
alter table public.ledger_entry_attributions
  add constraint ledger_attributions_channel_values
  check (channel is null or channel in ('telebirr', 'cbe', 'awash', 'cash', 'other'));

alter table public.ledger_entry_attributions drop constraint if exists ledger_attributions_note_shape;
alter table public.ledger_entry_attributions
  add constraint ledger_attributions_note_shape
  check (
    note is null
    or (
      note = btrim(note)
      and char_length(note) between 1 and 280
      and note !~ '[\u0001-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]'
    )
  );

comment on column public.ledger_entry_attributions.channel is
  'How the contribution was paid, as the treasurer recorded it: telebirr, cbe, awash, cash or other. Null = not said. Never set for a bank-verified entry (refused); the bank provider is the channel there.';
comment on column public.ledger_entry_attributions.note is
  'Optional one-line note (1..280 characters, trimmed, no control characters) the treasurer recorded with the payer. Plain text only.';

-- ---------------------------------------------------------------------------
-- 2. Reading: channel and note of the EFFECTIVE attribution
-- ---------------------------------------------------------------------------
create or replace function public.sened_attribution_channel_note(p_group_id uuid, p_entry_id uuid, p_source text)
returns table (channel text, note text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  (
    -- bank first: the channel is the verification's provider, there is no note
    select intent_row.provider::text, null::text
    from public.bank_verification_intents intent_row
    where p_source = 'bank_verification'
      and intent_row.group_id = p_group_id
      and intent_row.ledger_entry_id = p_entry_id
      and intent_row.state = 'VERIFIED'
      and intent_row.verified_at is not null
    order by intent_row.verified_at, intent_row.user_id
    limit 1
  )
  union all
  (
    select tip.channel, tip.note
    from public.ledger_entry_attributions tip
    where p_source = 'treasurer'
      and tip.group_id = p_group_id
      and tip.entry_id = p_entry_id
      and not exists (select 1 from public.ledger_entry_attributions later where later.supersedes_id = tip.id)
    limit 1
  );
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
    'reason', eff.reason,
    'channel', cn.channel,
    'note', cn.note
  )
  from public.sened_effective_attribution(p_group_id, p_entry_id) eff
  left join lateral public.sened_attribution_channel_note(p_group_id, p_entry_id, eff.source) cn on true;
$$;

-- ---------------------------------------------------------------------------
-- 3. Writing
-- ---------------------------------------------------------------------------
-- Error contract: as 20261010100000, plus
--   ledger_invalid_request   22023  a channel outside the list, or a note that is not
--                                   1..280 characters of plain text
drop function if exists public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer);
drop function if exists public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer);
drop function if exists public.sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text);

create or replace function public.sened_attribute_entry(
  p_mode text,
  p_group_id uuid,
  p_entry_id uuid,
  p_member_user_id uuid,
  p_cycle_id uuid,
  p_round integer,
  p_reason text,
  p_channel text,
  p_note text
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
  in_channel text := p_channel;
  in_note text;
  new_channel text;
  new_note text;
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

  -- Channel and note: validated before anything is read. null = "not given"; the empty
  -- string = "none" (record) or "clear it" (supersede). A note is trimmed first; what is
  -- left must be 1..280 characters with no control or invisible formatting characters.
  if in_channel is not null and in_channel <> '' and in_channel not in ('telebirr', 'cbe', 'awash', 'cash', 'other') then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;
  if p_note is not null then
    in_note := btrim(p_note);
    if in_note <> '' and (
         char_length(in_note) > 280
         or in_note ~ '[\u0001-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]'
       ) then
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
  -- Bank provenance wins, and a manual channel/note is part of a manual record: the
  -- whole write is refused, so a channel can never contradict the provider.
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

  if p_mode = 'supersede' and has_tip then
    new_channel := case when in_channel is null then tip_row.channel else nullif(in_channel, '') end;
    new_note := case when in_note is null then tip_row.note else nullif(in_note, '') end;
  else
    new_channel := nullif(in_channel, '');
    new_note := nullif(in_note, '');
  end if;

  if has_tip then
    same_values := tip_row.member_user_id = p_member_user_id
      and tip_row.cycle_id is not distinct from p_cycle_id
      and tip_row.round is not distinct from p_round
      and tip_row.channel is not distinct from new_channel
      and tip_row.note is not distinct from new_note;
  end if;

  if p_mode = 'record' then
    if has_tip then
      if same_values then
        return jsonb_build_object('attribution', public.sened_attribution_json(p_group_id, p_entry_id), 'replayed', true);
      end if;
      raise exception using errcode = 'P0001', message = 'attribution_exists';
    end if;
    insert into public.ledger_entry_attributions
      (entry_id, group_id, tenant_id, member_user_id, recorded_by, cycle_id, round, channel, note)
    values
      (p_entry_id, p_group_id, tenant, p_member_user_id, actor, p_cycle_id, p_round, new_channel, new_note);
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
      (entry_id, group_id, tenant_id, member_user_id, recorded_by, cycle_id, round, supersedes_id, reason, channel, note)
    values
      (p_entry_id, p_group_id, tenant, p_member_user_id, actor, p_cycle_id, p_round, tip_row.id, clean_reason, new_channel, new_note);
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
  p_round integer default null,
  p_channel text default null,
  p_note text default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.sened_attribute_entry('record', p_group_id, p_entry_id, p_member_user_id, p_cycle_id, p_round, null, p_channel, p_note);
$$;

create or replace function public.supersede_ledger_entry_attribution_v1(
  p_group_id uuid,
  p_entry_id uuid,
  p_member_user_id uuid,
  p_reason text,
  p_cycle_id uuid default null,
  p_round integer default null,
  p_channel text default null,
  p_note text default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.sened_attribute_entry('supersede', p_group_id, p_entry_id, p_member_user_id, p_cycle_id, p_round, p_reason, p_channel, p_note);
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.sened_attribution_channel_note(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sened_attribution_json(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sened_attribute_entry(text, uuid, uuid, uuid, uuid, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text) from public, anon;
revoke all on function public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer, text, text) from public, anon;
grant execute on function public.record_ledger_entry_attribution_v1(uuid, uuid, uuid, uuid, integer, text, text) to authenticated;
grant execute on function public.supersede_ledger_entry_attribution_v1(uuid, uuid, uuid, text, uuid, integer, text, text) to authenticated;
