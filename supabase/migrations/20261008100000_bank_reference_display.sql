-- Masked display form of the bank transaction reference.
--
-- The verified badge on the home feed should be able to say which receipt it
-- stands for ("Telebirr Verified · ••••2F42"). Until now only ciphertext and
-- HMACs of the reference were stored, so nothing safe existed to show.
--
-- This adds `bank_verification_intents.reference_display`: four bullets and the
-- last 1-4 characters of the reference (never more than half of it), computed
-- by the server from the plaintext at the one moment it has it (intent
-- creation; see src/lib/banking/referenceMask.ts for the rule and why it is
-- safe to show to group members). The full reference stays encrypted in
-- private.bank_verification_secrets.
--
-- The database cannot mask what it cannot read, so it does not try: the CHECK
-- constraint accepts only the masked SHAPE (U+2022 x4, then 1-4 printable
-- ASCII characters). A full reference (longer than 4 characters, or without the
-- bullets) can therefore never be stored in this column, whoever writes it.
-- Rows that existed before this migration stay NULL and are filled by
-- scripts/backfill-reference-display.ts, which holds the vault key; NULL simply
-- renders as no reference.
--
-- Rollout: apply this migration before deploying the application that sends
-- p_reference_display. The old 10-argument create_bank_verification_intent_v1 is
-- dropped, not overloaded: two overloads that both accept a 10-argument call are
-- ambiguous to PostgREST. The new function's extra argument is optional, so
-- callers that omit it (older code, the harness) keep working.

alter table public.bank_verification_intents
  add column if not exists reference_display text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bank_verification_intents'::regclass
      and conname = 'bank_intents_reference_display_masked'
  ) then
    alter table public.bank_verification_intents
      add constraint bank_intents_reference_display_masked
      check (reference_display is null or reference_display ~ '^\u2022{4}[!-~]{1,4}$');
  end if;
end
$$;

comment on column public.bank_verification_intents.reference_display is
  'Masked bank reference for display: four U+2022 bullets then the last 1-4 characters (at most half the reference). Never the full reference; enforced by bank_intents_reference_display_masked.';

create or replace function public.sened_bank_intent_response(
  intent_row public.bank_verification_intents,
  replayed boolean
)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'intent', jsonb_build_object(
      'verificationId', intent_row.id,
      'userId', intent_row.user_id,
      'groupId', intent_row.group_id,
      'tenantId', intent_row.tenant_id,
      'bankAccountBindingId', intent_row.bank_account_binding_id,
      'ledgerAccountId', intent_row.ledger_account_id,
      'provider', intent_row.provider,
      'providerReferenceHmac', intent_row.provider_reference_hmac,
      'sealedProviderReference', jsonb_build_object(
        'provider', secret_row.provider,
        'ciphertext', secret_row.provider_reference_ciphertext,
        'hmac', secret_row.provider_reference_hmac,
        'keyVersion', secret_row.key_version
      ),
      'amount', intent_row.amount::text,
      'currency', intent_row.currency,
      'direction', intent_row.direction,
      'occurredAt', to_char(intent_row.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'idempotencyKey', intent_row.idempotency_key,
      'requestFingerprint', intent_row.request_fingerprint,
      'state', intent_row.state,
      'reasonCode', intent_row.reason_code,
      'evidenceFingerprint', intent_row.evidence_fingerprint,
      'providerTransactionIdentityHmac', intent_row.provider_transaction_identity_hmac,
      'createdAt', to_char(intent_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(intent_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'ledgerEntryId', intent_row.ledger_entry_id,
      'referenceDisplay', intent_row.reference_display
    ),
    'replayed', replayed
  )
  from private.bank_verification_secrets secret_row
  where secret_row.verification_id = intent_row.id;
$$;


drop function if exists public.create_bank_verification_intent_v1(
  uuid, text, text, text, text, numeric, text, text, timestamptz, text
);

create or replace function public.create_bank_verification_intent_v1(
  p_binding_id uuid,
  p_provider text,
  p_provider_reference_hmac text,
  p_provider_reference_ciphertext text,
  p_provider_reference_key_version text,
  p_amount numeric,
  p_currency text,
  p_direction text,
  p_occurred_at timestamptz,
  p_idempotency_key text,
  p_reference_display text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
#variable_conflict use_column
declare
  actor uuid := auth.uid();
  binding_row public.bank_account_bindings%rowtype;
  existing_row public.bank_verification_intents%rowtype;
  created_row public.bank_verification_intents%rowtype;
  request_fingerprint text;
  created_at_value timestamptz := clock_timestamp();
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'bank_forbidden';
  end if;
  if p_provider not in ('telebirr', 'cbe', 'awash')
    or p_currency <> 'ETB'
    or p_direction not in ('inbound', 'outbound')
    or p_provider_reference_hmac !~ '^[0-9a-f]{64}$'
    or p_provider_reference_key_version !~ '^[A-Za-z0-9._-]{1,32}$'
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 1 and 128
    or p_idempotency_key <> btrim(p_idempotency_key)
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or (p_reference_display is not null and p_reference_display !~ '^\u2022{4}[!-~]{1,4}$')
    or p_amount is null
    or p_amount <= 0
    or p_occurred_at is null
    or p_occurred_at < timestamptz '1900-01-01 00:00:00+00'
    or p_occurred_at >= timestamptz '2101-01-01 00:00:00+00' then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;

  select binding_row.*
  into binding_row
  from public.bank_account_bindings binding_row
  where binding_row.id = p_binding_id
    and binding_row.user_id = actor
    and binding_row.active
    and binding_row.provider = p_provider
    and binding_row.currency = p_currency
    and public.sened_ledger_can_access_group(binding_row.group_id, binding_row.tenant_id);

  if not found then
    raise exception using errcode = 'P0002', message = 'bank_binding_not_found';
  end if;

  -- Only the group's owner or treasurer may record a verification. A plain
  -- member can see the group but not write to it; the role is read from
  -- ledger_group_memberships, never from the JWT.
  if not public.sened_ledger_can_manage_group(binding_row.group_id, binding_row.tenant_id) then
    raise exception using errcode = '42501', message = 'bank_forbidden';
  end if;

  request_fingerprint := encode(sha256(convert_to(
    'sened-bank-verification-request-v1' || chr(31) ||
    p_provider || chr(31) ||
    p_binding_id::text || chr(31) ||
    p_provider_reference_hmac || chr(31) ||
    p_amount::text || chr(31) ||
    p_currency || chr(31) ||
    p_direction || chr(31) ||
    to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || chr(31) ||
    p_idempotency_key,
    'UTF8'
  )), 'hex');

  insert into public.bank_verification_intents (
    user_id,
    tenant_id,
    group_id,
    bank_account_binding_id,
    ledger_account_id,
    provider,
    provider_reference_hmac,
    idempotency_key,
    request_fingerprint,
    amount,
    currency,
    direction,
    occurred_at,
    state,
    reason_code,
    reference_display,
    created_at,
    updated_at
  ) values (
    actor,
    binding_row.tenant_id,
    binding_row.group_id,
    binding_row.id,
    binding_row.ledger_account_id,
    p_provider,
    p_provider_reference_hmac,
    p_idempotency_key,
    request_fingerprint,
    p_amount,
    p_currency,
    p_direction,
    p_occurred_at,
    'PENDING_RECONCILIATION',
    'AWAITING_PROVIDER_EVIDENCE',
    p_reference_display,
    created_at_value,
    created_at_value
  )
  on conflict (user_id, idempotency_key) do nothing
  returning * into created_row;

  if not found then
    select existing_row.*
    into existing_row
    from public.bank_verification_intents existing_row
    where existing_row.user_id = actor
      and existing_row.idempotency_key = p_idempotency_key;
    if not found then
      raise exception using errcode = 'P0001', message = 'bank_idempotency_conflict';
    end if;
    if existing_row.request_fingerprint <> request_fingerprint then
      raise exception using errcode = 'P0001', message = 'bank_idempotency_conflict';
    end if;
    return public.sened_bank_intent_response(existing_row, true);
  end if;

  insert into private.bank_verification_secrets (
    verification_id,
    provider,
    provider_reference_ciphertext,
    provider_reference_hmac,
    expected_sender_hmac,
    expected_receiver_hmac,
    key_version
  ) values (
    created_row.id,
    p_provider,
    p_provider_reference_ciphertext,
    p_provider_reference_hmac,
    binding_row.sender_fingerprint_hmac,
    binding_row.receiver_fingerprint_hmac,
    p_provider_reference_key_version
  );

  insert into public.bank_verification_events (
    verification_id,
    user_id,
    event_type,
    state,
    reason_code,
    attempt
  ) values (
    created_row.id,
    actor,
    'INTENT_CREATED',
    'PENDING_RECONCILIATION',
    'AWAITING_PROVIDER_EVIDENCE',
    0
  );

  insert into public.bank_reconciliation_jobs (
    verification_id,
    user_id,
    provider,
    state,
    next_attempt_at,
    created_at,
    updated_at
  ) values (
    created_row.id,
    actor,
    p_provider,
    'QUEUED',
    created_at_value,
    created_at_value,
    created_at_value
  );

  return public.sened_bank_intent_response(created_row, false);
end;
$$;

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
          'memberUserId', intent_row.user_id,
          'referenceMasked', intent_row.reference_display
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

revoke all on function public.create_bank_verification_intent_v1(uuid, text, text, text, text, numeric, text, text, timestamptz, text, text) from public, anon;
grant execute on function public.create_bank_verification_intent_v1(uuid, text, text, text, text, numeric, text, text, timestamptz, text, text) to authenticated;

revoke all on function public.sened_bank_intent_response(public.bank_verification_intents, boolean) from public, anon, authenticated;

-- BACKFILL SUPPORT (service_role only)
--
-- Rows created before this migration have no display form, and SQL cannot mask
-- what it cannot decrypt. scripts/backfill-reference-display.ts holds the vault
-- key, so it needs to (1) read the sealed reference of rows still missing a
-- display and (2) write the masked result back. private.bank_verification_secrets
-- is not exposed through PostgREST, hence these two functions, granted to
-- service_role only (the reconciliation drain's pattern). The write refuses
-- anything but the masked shape, never overwrites an existing display, and does
-- not touch any other column.

create or replace function public.list_bank_reference_display_backfill_v1(
  p_after uuid default null,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select coalesce(jsonb_agg(row_json order by row_id), '[]'::jsonb)
  from (
    select
      intent_row.id as row_id,
      jsonb_build_object(
        'verificationId', intent_row.id,
        'provider', secret_row.provider,
        'ciphertext', secret_row.provider_reference_ciphertext,
        'hmac', secret_row.provider_reference_hmac,
        'keyVersion', secret_row.key_version
      ) as row_json
    from public.bank_verification_intents intent_row
    join private.bank_verification_secrets secret_row on secret_row.verification_id = intent_row.id
    where intent_row.reference_display is null
      and (p_after is null or intent_row.id > p_after)
    order by intent_row.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) pending;
$$;

create or replace function public.set_bank_reference_display_v1(
  p_verification_id uuid,
  p_reference_display text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if p_reference_display is null or p_reference_display !~ '^\u2022{4}[!-~]{1,4}$' then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  update public.bank_verification_intents intent_row
  set reference_display = p_reference_display
  where intent_row.id = p_verification_id
    and intent_row.reference_display is null;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.list_bank_reference_display_backfill_v1(uuid, integer) from public, anon, authenticated;
revoke all on function public.set_bank_reference_display_v1(uuid, text) from public, anon, authenticated;
grant execute on function public.list_bank_reference_display_backfill_v1(uuid, integer) to service_role;
grant execute on function public.set_bank_reference_display_v1(uuid, text) to service_role;
