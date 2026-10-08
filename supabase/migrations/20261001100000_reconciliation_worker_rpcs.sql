-- Worker-side RPCs for the reconciliation drain.
--
-- WHY THIS EXISTS
-- claim/reschedule/finalize_bank_reconciliation_job_v1 are granted to
-- service_role and do not look at auth.uid(), so a cron-driven drain can run
-- them. Re-verifying a claimed job needs two more things, and both are
-- user-scoped by auth.uid(), which is NULL for a service-role caller:
--
--   1. get_bank_account_binding_v1 filters `user_id = auth.uid()`, so under
--      service_role it returns nothing, the drain throws NOT_FOUND, and every
--      job is rescheduled as PROVIDER_UNAVAILABLE forever.
--   2. post_ledger_entry_v1 raises ledger_forbidden when auth.uid() is NULL,
--      so a verification that becomes VERIFIED in the background could never be
--      posted to the ledger.
--
-- These two wrappers let service_role perform exactly those two operations on
-- behalf of the job's own user, and nothing else. Neither widens an existing
-- grant: the originals stay `authenticated`-only and are untouched; the new
-- functions are granted to service_role only.
--
-- HOW THEY ARE CONFINED
-- Each wrapper refuses unless a reconciliation job is CLAIMED with an unexpired
-- lease for that user and verification, so service_role cannot use them to read
-- an arbitrary binding or post an arbitrary entry. The ledger wrapper further
-- requires the entry to be the bank posting the sink builds (idempotency key
-- `bank-verified-<intent key>`, contribution/disbursement, no correction, every
-- posting for the intent's amount, one of them on the intent's cash account),
-- and then calls the unmodified post_ledger_entry_v1, so group membership,
-- balance, hash chaining and idempotency are all enforced by the same code as
-- the synchronous path. The acting user is the intent's owner, i.e. the same
-- actor as the synchronous path.
--
-- The identity is set with transaction-local set_config and cleared before
-- returning; an RPC call is one transaction, so it cannot leak to another call.

create or replace function public.get_bank_account_binding_for_reconciliation_v1(
  p_binding_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  result jsonb;
begin
  if p_binding_id is null or p_user_id is null then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  if not exists (
    select 1
    from public.bank_reconciliation_jobs job_row
    join public.bank_verification_intents intent_row on intent_row.id = job_row.verification_id
    where job_row.state = 'CLAIMED'
      and job_row.lease_expires_at > clock_timestamp()
      and job_row.user_id = p_user_id
      and intent_row.user_id = p_user_id
      and intent_row.bank_account_binding_id = p_binding_id
  ) then
    raise exception using errcode = '42501', message = 'bank_forbidden';
  end if;
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
  result := public.get_bank_account_binding_v1(p_binding_id);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  return result;
end;
$$;

create or replace function public.post_ledger_entry_for_reconciliation_v1(
  requested_actor_id uuid,
  requested_group_id uuid,
  requested_idempotency_key text,
  requested_occurred_at timestamptz,
  requested_entry_type text,
  requested_corrects_entry_id uuid,
  requested_rationale text,
  requested_postings jsonb
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
      and exists (
        select 1
        from jsonb_array_elements(requested_postings) posting
        where (posting ->> 'accountId') = intent_row.ledger_account_id::text
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

revoke all on function public.get_bank_account_binding_for_reconciliation_v1(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.post_ledger_entry_for_reconciliation_v1(uuid, uuid, text, timestamptz, text, uuid, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.get_bank_account_binding_for_reconciliation_v1(uuid, uuid) to service_role;
grant execute on function public.post_ledger_entry_for_reconciliation_v1(uuid, uuid, text, timestamptz, text, uuid, text, jsonb) to service_role;

-- STUCK-JOB REAPER
-- claim_bank_reconciliation_job_v1 only claims a CLAIMED job whose lease has
-- expired while `attempt < max_attempts`. A worker that dies during its LAST
-- attempt therefore leaves a job that is CLAIMED, expired and exhausted: never
-- claimable again and never moved to MANUAL_REVIEW, so nobody is told. This
-- moves those jobs to MANUAL_REVIEW, doing exactly what
-- reschedule_bank_reconciliation_job_v1 does when attempts are exhausted (job
-- to MANUAL_REVIEW with the lease cleared and a terminal_at; intent stays
-- PENDING_RECONCILIATION with reason MANUAL_REVIEW_REQUIRED; one MANUAL_REVIEW
-- event). It is a separate function so claim_bank_reconciliation_job_v1, whose
-- contract the TypeScript code depends on, is not changed. The drain calls it
-- before claiming. service_role only; returns the number of jobs reaped.
create or replace function public.reap_exhausted_bank_reconciliation_jobs_v1()
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
#variable_conflict use_column
declare
  now_value timestamptz := clock_timestamp();
  job_row public.bank_reconciliation_jobs%rowtype;
  reaped integer := 0;
begin
  for job_row in
    select j.*
    from public.bank_reconciliation_jobs j
    where j.state = 'CLAIMED'
      and j.lease_expires_at <= now_value
      and j.attempt >= j.max_attempts
    order by j.lease_expires_at, j.id
    limit 100
    for update skip locked
  loop
    update public.bank_reconciliation_jobs
    set state = 'MANUAL_REVIEW', lease_owner = null, lease_token = null, lease_expires_at = null,
        last_reason_code = 'MANUAL_REVIEW_REQUIRED', terminal_at = now_value, updated_at = now_value
    where id = job_row.id;
    update public.bank_verification_intents
    set state = 'PENDING_RECONCILIATION', reason_code = 'MANUAL_REVIEW_REQUIRED', updated_at = now_value
    where id = job_row.verification_id and state = 'PENDING_RECONCILIATION';
    insert into public.bank_verification_events (verification_id, user_id, event_type, state, reason_code, attempt)
    values (job_row.verification_id, job_row.user_id, 'MANUAL_REVIEW', 'PENDING_RECONCILIATION', 'MANUAL_REVIEW_REQUIRED', job_row.attempt);
    reaped := reaped + 1;
  end loop;
  return reaped;
end;
$$;

revoke all on function public.reap_exhausted_bank_reconciliation_jobs_v1()
  from public, anon, authenticated;
grant execute on function public.reap_exhausted_bank_reconciliation_jobs_v1() to service_role;
