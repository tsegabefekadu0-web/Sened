-- Read-only provenance for ledger entries posted from a verified bank receipt.
--
-- The link already exists: `bank_verification_intents.ledger_entry_id` is set
-- by record_bank_verification_result_v1 / finalize_bank_reconciliation_job_v1
-- when the verification sink posts the entry, and it is covered by a composite
-- foreign key to ledger_entries (id, group_id). What was missing was a way for
-- a *group member* to read it: the intents table is owner-read only
-- ("bank intents owner read"), so a member could never learn that another
-- member's contribution had been verified.
--
-- This adds a SECURITY DEFINER read function scoped to group membership that
-- returns only fields safe to show a fellow member. It never returns the
-- provider reference in any form (ciphertext, HMAC, transaction identity HMAC),
-- the request fingerprint, the idempotency key or the binding. No table policy
-- is widened.

-- Backfill: a verification that is VERIFIED but whose link was never recorded
-- (the ledger post succeeded and the process died before the result was
-- stored). Matched conservatively: same group, the sink's idempotency key, the
-- intent owner as the entry's actor, the entry type the direction implies and
-- a debit posting of the intent's amount. Idempotent: only rows still unlinked.
update public.bank_verification_intents intent_row
set ledger_entry_id = entry_row.id
from public.ledger_entries entry_row
where intent_row.state = 'VERIFIED'
  and intent_row.ledger_entry_id is null
  and entry_row.group_id = intent_row.group_id
  and entry_row.idempotency_key = 'bank-verified-' || intent_row.idempotency_key
  and entry_row.actor_id = intent_row.user_id
  and entry_row.entry_type = case intent_row.direction when 'inbound' then 'contribution' else 'disbursement' end
  and exists (
    select 1
    from public.ledger_entry_postings posting_row
    where posting_row.entry_id = entry_row.id
      and posting_row.direction = 'debit'
      and posting_row.amount = intent_row.amount
  );

create or replace function public.get_ledger_entry_provenance_v1(
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
      select jsonb_agg(
        jsonb_build_object(
          'entryId', intent_row.ledger_entry_id,
          'verificationId', intent_row.id,
          'provider', intent_row.provider,
          'verifiedAt', to_char(intent_row.verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'memberUserId', intent_row.user_id
        )
        order by intent_row.verified_at, intent_row.id
      )
      from public.bank_verification_intents intent_row
      where intent_row.group_id = p_group_id
        and intent_row.state = 'VERIFIED'
        and intent_row.verified_at is not null
        and intent_row.ledger_entry_id = any (p_entry_ids)
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.get_ledger_entry_provenance_v1(uuid, uuid[]) from public, anon;
grant execute on function public.get_ledger_entry_provenance_v1(uuid, uuid[]) to authenticated;
