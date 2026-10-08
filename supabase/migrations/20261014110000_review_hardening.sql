-- Review hardening, in one migration (idempotent: every statement is create-or-replace
-- or drop-if-exists).
--
-- 1. post_ledger_entry_for_reconciliation_v1 is tightened. The first version only
--    proved "a claimed, unexpired job for this user and intent exists" and "one
--    posting is on the intent's cash account, every posting has the intent's
--    amount". That left three holes for a service_role caller:
--      a. the cash leg's DIRECTION was not checked, so money arriving could be
--         posted as a credit to the pot (or money leaving as a debit), reversing
--         the sign of the pot;
--      b. the OTHER account was not checked at all, so the income/expense side
--         could be any account in the group (or any account id the function was
--         handed);
--      c. the lease TOKEN was not checked: any caller who knew a user id and an
--         idempotency key could post while that user's job was merely claimed by
--         someone else.
--    The function now also takes the claimed job's lease token and requires it to
--    match, requires the cash leg to be the debit of an inbound / the credit of an
--    outbound intent, and requires the other leg to be the group's own
--    CONTRIBUTION_INCOME (inbound) or PAYOUT_EXPENSE (outbound) account, the same
--    pair `counterAccountCodeFor` gives the application.
--    A new argument is a new signature, so the old 8-argument function is dropped
--    (nothing else calls it; the drain is its only caller and is updated together).
--    This is a NEW migration rather than an edit of 20261001100000 because that
--    file may already have been applied somewhere; redefining is safe either way.
--
-- 2. list_group_members_v1 drops `extensions` from its search_path. It reads
--    only public and auth tables and calls no extension function, so a
--    SECURITY DEFINER function has no reason to resolve names through a schema
--    other than public.

drop function if exists public.post_ledger_entry_for_reconciliation_v1(
  uuid, uuid, text, timestamptz, text, uuid, text, jsonb
);

create or replace function public.post_ledger_entry_for_reconciliation_v1(
  requested_actor_id uuid,
  requested_group_id uuid,
  requested_idempotency_key text,
  requested_occurred_at timestamptz,
  requested_entry_type text,
  requested_corrects_entry_id uuid,
  requested_rationale text,
  requested_postings jsonb,
  requested_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  result jsonb;
begin
  if requested_actor_id is null
    or requested_group_id is null
    or requested_idempotency_key is null
    or requested_lease_token is null
    or requested_postings is null
    or jsonb_typeof(requested_postings) <> 'array'
    or requested_corrects_entry_id is not null
    or requested_entry_type not in ('contribution', 'disbursement') then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;
  if not exists (
    select 1
    from public.bank_reconciliation_jobs job_row
    join public.bank_verification_intents intent_row on intent_row.id = job_row.verification_id
    where job_row.state = 'CLAIMED'
      and job_row.lease_expires_at > clock_timestamp()
      and job_row.lease_token = requested_lease_token
      and job_row.user_id = requested_actor_id
      and intent_row.user_id = requested_actor_id
      and intent_row.group_id = requested_group_id
      and requested_idempotency_key = 'bank-verified-' || intent_row.idempotency_key
      and requested_entry_type = case intent_row.direction
        when 'inbound' then 'contribution'
        else 'disbursement'
      end
      and jsonb_array_length(requested_postings) = 2
      and not exists (
        select 1
        from jsonb_array_elements(requested_postings) posting
        where (posting ->> 'amount') is distinct from to_char(intent_row.amount, 'FM999999999999999990.00')
      )
      -- The cash leg: the intent's own cash account, debited when money arrives
      -- and credited when it leaves.
      and exists (
        select 1
        from jsonb_array_elements(requested_postings) posting
        where (posting ->> 'accountId') = intent_row.ledger_account_id::text
          and (posting ->> 'direction') = case intent_row.direction when 'inbound' then 'debit' else 'credit' end
      )
      -- The other leg: this group's income (inbound) or payout expense (outbound)
      -- account, on the opposite side.
      and exists (
        select 1
        from jsonb_array_elements(requested_postings) posting
        join public.ledger_accounts counter
          on counter.id::text = (posting ->> 'accountId')
         and counter.group_id = intent_row.group_id
         and counter.id <> intent_row.ledger_account_id
         and counter.code = case intent_row.direction when 'inbound' then 'CONTRIBUTION_INCOME' else 'PAYOUT_EXPENSE' end
        where (posting ->> 'direction') = case intent_row.direction when 'inbound' then 'credit' else 'debit' end
      )
  ) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  perform set_config('request.jwt.claim.sub', requested_actor_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', requested_actor_id::text, 'role', 'authenticated')::text,
    true
  );
  result := public.post_ledger_entry_v1(
    requested_group_id,
    requested_idempotency_key,
    requested_occurred_at,
    requested_entry_type,
    requested_corrects_entry_id,
    requested_rationale,
    requested_postings
  );
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  return result;
end;
$$;

revoke all on function public.post_ledger_entry_for_reconciliation_v1(uuid, uuid, text, timestamptz, text, uuid, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.post_ledger_entry_for_reconciliation_v1(uuid, uuid, text, timestamptz, text, uuid, text, jsonb, uuid) to service_role;

create or replace function public.list_group_members_v1(requested_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  caller_role text;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;
  if requested_group_id is null then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  select caller.role into caller_role
  from public.ledger_group_memberships caller
  where caller.group_id = requested_group_id
    and caller.user_id = actor
    and caller.status = 'active';

  -- Outsiders get the same answer whether or not the group exists.
  if caller_role is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'userId', membership.user_id,
        'role', membership.role,
        'joinedAt', membership.created_at,
        'email', case when caller_role = 'owner' then member_user.email else null end,
        'attire', membership.attire
      )
      order by membership.created_at, membership.user_id
    )
    from public.ledger_group_memberships membership
    left join auth.users member_user on member_user.id = membership.user_id
    where membership.group_id = requested_group_id
      and membership.status = 'active'
  ), '[]'::jsonb);
end;
$$;

comment on function public.list_group_members_v1(uuid) is
  'Active members of a group, for any active member. Email is included only for the owner. attire is each member''s own avatar choice (none, gabi, netela).';

revoke all on function public.list_group_members_v1(uuid) from public, anon;
grant execute on function public.list_group_members_v1(uuid) to authenticated;
