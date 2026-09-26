create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

create table if not exists public.bank_account_bindings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  tenant_id uuid not null default auth.uid(),
  group_id uuid not null,
  ledger_account_id uuid not null,
  provider text not null check (provider in ('telebirr', 'cbe', 'awash')),
  currency text not null default 'ETB' check (currency = 'ETB'),
  account_label text not null check (char_length(btrim(account_label)) between 1 and 120),
  account_fingerprint_hmac text not null check (account_fingerprint_hmac ~ '^[0-9a-f]{64}$'),
  sender_fingerprint_hmac text not null check (sender_fingerprint_hmac ~ '^[0-9a-f]{64}$'),
  receiver_fingerprint_hmac text not null check (receiver_fingerprint_hmac ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  constraint bank_bindings_id_user_key unique (id, user_id),
  constraint bank_bindings_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint bank_bindings_account_group_fk
    foreign key (ledger_account_id, group_id)
    references public.ledger_accounts (id, group_id)
    on delete restrict
);

create index if not exists bank_bindings_user_provider_idx
  on public.bank_account_bindings (user_id, provider, id);

create table if not exists public.bank_verification_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  tenant_id uuid not null,
  group_id uuid not null,
  bank_account_binding_id uuid not null,
  ledger_account_id uuid not null,
  provider text not null check (provider in ('telebirr', 'cbe', 'awash')),
  provider_reference_hmac text not null check (provider_reference_hmac ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 128 and
    idempotency_key = btrim(idempotency_key) and
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  amount numeric(20, 2) not null check (amount > 0),
  currency text not null default 'ETB' check (currency = 'ETB'),
  direction text not null check (direction in ('inbound', 'outbound')),
  occurred_at timestamptz not null check (
    occurred_at >= timestamptz '1900-01-01 00:00:00+00' and
    occurred_at < timestamptz '2101-01-01 00:00:00+00'
  ),
  state text not null default 'PENDING_RECONCILIATION' check (
    state in ('PENDING_RECONCILIATION', 'VERIFIED', 'REJECTED')
  ),
  reason_code text not null default 'AWAITING_PROVIDER_EVIDENCE' check (
    reason_code in (
      'AWAITING_PROVIDER_EVIDENCE',
      'PROVIDER_TIMEOUT',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_NOT_FOUND',
      'PROVIDER_UNSETTLED',
      'PROVIDER_RESPONSE_INVALID',
      'EVIDENCE_INCOMPLETE',
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'DIRECTION_MISMATCH',
      'SENDER_MISMATCH',
      'RECEIVER_MISMATCH',
      'TIMESTAMP_MISMATCH',
      'MANUAL_REVIEW_REQUIRED',
      'VERIFIED'
    )
  ),
  evidence_fingerprint text check (evidence_fingerprint is null or evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_transaction_identity_hmac text check (
    provider_transaction_identity_hmac is null or provider_transaction_identity_hmac ~ '^[0-9a-f]{64}$'
  ),
  ledger_entry_id uuid,
  verified_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint bank_intents_user_idempotency_key unique (user_id, idempotency_key),
  constraint bank_intents_provider_reference_key unique (provider, provider_reference_hmac),
  constraint bank_intents_binding_user_fk
    foreign key (bank_account_binding_id, user_id)
    references public.bank_account_bindings (id, user_id)
    on delete restrict,
  constraint bank_intents_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint bank_intents_account_group_fk
    foreign key (ledger_account_id, group_id)
    references public.ledger_accounts (id, group_id)
    on delete restrict,
  constraint bank_intents_ledger_entry_group_fk
    foreign key (ledger_entry_id, group_id)
    references public.ledger_entries (id, group_id)
    on delete restrict,
  constraint bank_intents_verified_evidence_check check (
    state <> 'VERIFIED' or (
      evidence_fingerprint is not null and
      provider_transaction_identity_hmac is not null and
      verified_at is not null
    )
  ),
  constraint bank_intents_terminal_ledger_check check (
    state = 'VERIFIED' or ledger_entry_id is null
  )
);

create unique index if not exists bank_intents_provider_transaction_identity_key
  on public.bank_verification_intents (provider, provider_transaction_identity_hmac)
  where provider_transaction_identity_hmac is not null;

create index if not exists bank_intents_user_state_idx
  on public.bank_verification_intents (user_id, state, updated_at desc);

create index if not exists bank_intents_group_idx
  on public.bank_verification_intents (group_id, created_at desc);

create table if not exists public.bank_verification_events (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references public.bank_verification_intents (id) on delete restrict,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  event_type text not null check (
    event_type in (
      'INTENT_CREATED',
      'VERIFICATION_PENDING',
      'VERIFIED',
      'REJECTED',
      'RETRY_SCHEDULED',
      'MANUAL_REVIEW',
      'REVERSAL_PLANNED'
    )
  ),
  state text not null check (state in ('PENDING_RECONCILIATION', 'VERIFIED', 'REJECTED')),
  reason_code text not null check (
    reason_code in (
      'AWAITING_PROVIDER_EVIDENCE',
      'PROVIDER_TIMEOUT',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_NOT_FOUND',
      'PROVIDER_UNSETTLED',
      'PROVIDER_RESPONSE_INVALID',
      'EVIDENCE_INCOMPLETE',
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'DIRECTION_MISMATCH',
      'SENDER_MISMATCH',
      'RECEIVER_MISMATCH',
      'TIMESTAMP_MISMATCH',
      'MANUAL_REVIEW_REQUIRED',
      'VERIFIED'
    )
  ),
  attempt smallint not null default 0 check (attempt between 0 and 100),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists bank_verification_events_intent_idx
  on public.bank_verification_events (verification_id, created_at, id);

create table if not exists public.bank_reconciliation_jobs (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null unique references public.bank_verification_intents (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
  provider text not null check (provider in ('telebirr', 'cbe', 'awash')),
  state text not null default 'QUEUED' check (
    state in ('QUEUED', 'CLAIMED', 'RETRY_SCHEDULED', 'SUCCEEDED', 'MANUAL_REVIEW')
  ),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_reason_code text check (
    last_reason_code is null or last_reason_code in (
      'AWAITING_PROVIDER_EVIDENCE',
      'PROVIDER_TIMEOUT',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_NOT_FOUND',
      'PROVIDER_UNSETTLED',
      'PROVIDER_RESPONSE_INVALID',
      'EVIDENCE_INCOMPLETE',
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'DIRECTION_MISMATCH',
      'SENDER_MISMATCH',
      'RECEIVER_MISMATCH',
      'TIMESTAMP_MISMATCH',
      'MANUAL_REVIEW_REQUIRED',
      'VERIFIED'
    )
  ),
  terminal_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint bank_jobs_attempt_bound check (attempt <= max_attempts),
  constraint bank_jobs_lease_shape check (
    (state = 'CLAIMED' and lease_owner is not null and lease_token is not null and lease_expires_at is not null) or
    (state <> 'CLAIMED' and lease_owner is null and lease_token is null and lease_expires_at is null)
  ),
  constraint bank_jobs_terminal_shape check (
    (state in ('SUCCEEDED', 'MANUAL_REVIEW') and terminal_at is not null) or
    (state not in ('SUCCEEDED', 'MANUAL_REVIEW') and terminal_at is null)
  )
);

create index if not exists bank_jobs_claim_idx
  on public.bank_reconciliation_jobs (state, next_attempt_at, lease_expires_at, created_at);

create index if not exists bank_jobs_user_idx
  on public.bank_reconciliation_jobs (user_id, verification_id);

create table if not exists private.bank_verification_secrets (
  verification_id uuid primary key references public.bank_verification_intents (id) on delete cascade,
  provider text not null check (provider in ('telebirr', 'cbe', 'awash')),
  provider_reference_ciphertext text not null check (char_length(provider_reference_ciphertext) between 16 and 16384),
  provider_reference_hmac text not null check (provider_reference_hmac ~ '^[0-9a-f]{64}$'),
  expected_sender_hmac text not null check (expected_sender_hmac ~ '^[0-9a-f]{64}$'),
  expected_receiver_hmac text not null check (expected_receiver_hmac ~ '^[0-9a-f]{64}$'),
  key_version text not null check (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.bank_account_bindings enable row level security;
alter table public.bank_verification_intents enable row level security;
alter table public.bank_verification_events enable row level security;
alter table public.bank_reconciliation_jobs enable row level security;
alter table private.bank_verification_secrets enable row level security;

create or replace function public.sened_bank_intent_response(
  intent_row public.bank_verification_intents%rowtype,
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
      'ledgerEntryId', intent_row.ledger_entry_id
    ),
    'replayed', replayed
  )
  from private.bank_verification_secrets secret_row
  where secret_row.verification_id = intent_row.id;
$$;

create or replace function public.sened_bank_intent_json(
  intent_row public.bank_verification_intents%rowtype
)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select (public.sened_bank_intent_response(intent_row, false) -> 'intent');
$$;

create or replace function public.sened_bank_job_json(
  job_row public.bank_reconciliation_jobs%rowtype
)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'id', job_row.id,
    'verificationId', job_row.verification_id,
    'userId', job_row.user_id,
    'provider', job_row.provider,
    'state', job_row.state,
    'attempt', job_row.attempt,
    'maxAttempts', job_row.max_attempts,
    'nextAttemptAt', to_char(job_row.next_attempt_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseToken', job_row.lease_token,
    'leaseExpiresAt', case when job_row.lease_expires_at is null then null else to_char(job_row.lease_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'lastReasonCode', job_row.last_reason_code,
    'terminalAt', case when job_row.terminal_at is null then null else to_char(job_row.terminal_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'createdAt', to_char(job_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(job_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$$;

create or replace function public.sened_bank_block_event_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'bank_verification_event_immutable';
end;
$$;

drop trigger if exists bank_verification_events_block_mutation on public.bank_verification_events;
create trigger bank_verification_events_block_mutation
before update or delete on public.bank_verification_events
for each row execute function public.sened_bank_block_event_mutation();

create or replace function public.get_bank_account_binding_v1(p_binding_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'id', binding_row.id,
    'userId', binding_row.user_id,
    'groupId', binding_row.group_id,
    'tenantId', binding_row.tenant_id,
    'ledgerAccountId', binding_row.ledger_account_id,
    'provider', binding_row.provider,
    'currency', binding_row.currency,
    'accountLabel', binding_row.account_label,
    'accountFingerprintHmac', binding_row.account_fingerprint_hmac,
    'senderFingerprintHmac', binding_row.sender_fingerprint_hmac,
    'receiverFingerprintHmac', binding_row.receiver_fingerprint_hmac,
    'active', binding_row.active
  )
  from public.bank_account_bindings binding_row
  where binding_row.id = p_binding_id
    and binding_row.user_id = auth.uid()
    and binding_row.active;
$$;

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
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
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

  request_fingerprint := encode(sha256(convert_to(
    'sened-bank-verification-request-v1' || chr(0) ||
    p_provider || chr(0) ||
    p_binding_id::text || chr(0) ||
    p_provider_reference_hmac || chr(0) ||
    p_amount::text || chr(0) ||
    p_currency || chr(0) ||
    p_direction || chr(0) ||
    to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || chr(0) ||
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

create or replace function public.get_bank_verification_intent_v1(p_verification_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select public.sened_bank_intent_json(intent_row)
  from public.bank_verification_intents intent_row
  where intent_row.id = p_verification_id
    and intent_row.user_id = auth.uid();
$$;

create or replace function public.append_bank_verification_event_v1(
  p_verification_id uuid,
  p_event_type text,
  p_state text,
  p_reason_code text,
  p_attempt integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  actor uuid := auth.uid();
  intent_row public.bank_verification_intents%rowtype;
  event_id uuid := gen_random_uuid();
  created_at_value timestamptz := clock_timestamp();
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'bank_forbidden';
  end if;
  if p_event_type not in ('INTENT_CREATED', 'VERIFICATION_PENDING', 'VERIFIED', 'REJECTED', 'RETRY_SCHEDULED', 'MANUAL_REVIEW', 'REVERSAL_PLANNED')
    or (p_event_type <> 'REVERSAL_PLANNED' and coalesce(auth.role(), '') <> 'service_role')
    or p_state not in ('PENDING_RECONCILIATION', 'VERIFIED', 'REJECTED')
    or p_reason_code is null
    or p_attempt is null
    or p_attempt not between 0 and 100 then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  select intent_row.*
  into intent_row
  from public.bank_verification_intents intent_row
  where intent_row.id = p_verification_id
    and intent_row.user_id = actor;
  if not found then
    raise exception using errcode = 'P0002', message = 'bank_verification_not_found';
  end if;
  insert into public.bank_verification_events (
    id,
    verification_id,
    user_id,
    event_type,
    state,
    reason_code,
    attempt,
    created_at
  ) values (
    event_id,
    p_verification_id,
    actor,
    p_event_type,
    p_state,
    p_reason_code,
    p_attempt,
    created_at_value
  );
  return jsonb_build_object(
    'id', event_id,
    'verificationId', p_verification_id,
    'userId', actor,
    'eventType', p_event_type,
    'state', p_state,
    'reasonCode', p_reason_code,
    'attempt', p_attempt,
    'createdAt', to_char(created_at_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

create or replace function public.record_bank_verification_result_v1(
  p_verification_id uuid,
  p_state text,
  p_reason_code text,
  p_evidence_fingerprint text,
  p_provider_transaction_identity_hmac text,
  p_ledger_entry_id uuid,
  p_next_attempt_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  actor uuid := auth.uid();
  intent_row public.bank_verification_intents%rowtype;
  job_row public.bank_reconciliation_jobs%rowtype;
  updated_row public.bank_verification_intents%rowtype;
  now_value timestamptz := clock_timestamp();
  event_type text;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'bank_forbidden';
  end if;
  if p_state not in ('PENDING_RECONCILIATION', 'VERIFIED', 'REJECTED')
    or p_reason_code not in (
      'AWAITING_PROVIDER_EVIDENCE',
      'PROVIDER_TIMEOUT',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_NOT_FOUND',
      'PROVIDER_UNSETTLED',
      'PROVIDER_RESPONSE_INVALID',
      'EVIDENCE_INCOMPLETE',
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'DIRECTION_MISMATCH',
      'SENDER_MISMATCH',
      'RECEIVER_MISMATCH',
      'TIMESTAMP_MISMATCH',
      'MANUAL_REVIEW_REQUIRED',
      'VERIFIED'
    ) then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  if (p_state = 'VERIFIED' and p_reason_code <> 'VERIFIED')
    or (p_state <> 'VERIFIED' and p_reason_code = 'VERIFIED') then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  select intent_row.*
  into intent_row
  from public.bank_verification_intents intent_row
  where intent_row.id = p_verification_id
    and intent_row.user_id = actor
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'bank_verification_not_found';
  end if;
  if intent_row.state <> 'PENDING_RECONCILIATION' then
    if intent_row.state = p_state then
      return public.sened_bank_intent_json(intent_row);
    end if;
    raise exception using errcode = 'P0001', message = 'bank_idempotency_conflict';
  end if;
  if p_state = 'VERIFIED' and (
    p_evidence_fingerprint is null or
    p_evidence_fingerprint !~ '^[0-9a-f]{64}$' or
    p_provider_transaction_identity_hmac is null or
    p_provider_transaction_identity_hmac !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  if p_state <> 'VERIFIED' and p_ledger_entry_id is not null then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  event_type := case p_state
    when 'VERIFIED' then 'VERIFIED'
    when 'REJECTED' then 'REJECTED'
    else 'VERIFICATION_PENDING'
  end;
  update public.bank_verification_intents
  set
    state = p_state,
    reason_code = p_reason_code,
    evidence_fingerprint = p_evidence_fingerprint,
    provider_transaction_identity_hmac = p_provider_transaction_identity_hmac,
    ledger_entry_id = p_ledger_entry_id,
    verified_at = case when p_state = 'VERIFIED' then now_value else null end,
    rejected_at = case when p_state = 'REJECTED' then now_value else null end,
    updated_at = now_value
  where id = p_verification_id
  returning * into updated_row;
  select job_row.*
  into job_row
  from public.bank_reconciliation_jobs job_row
  where job_row.verification_id = p_verification_id
  for update;
  if found then
    if p_state = 'PENDING_RECONCILIATION' then
      if p_next_attempt_at is null then
        update public.bank_reconciliation_jobs
        set state = 'MANUAL_REVIEW', lease_owner = null, lease_token = null, lease_expires_at = null, last_reason_code = 'MANUAL_REVIEW_REQUIRED', terminal_at = now_value, updated_at = now_value
        where id = job_row.id;
      else
        update public.bank_reconciliation_jobs
        set state = 'RETRY_SCHEDULED', next_attempt_at = p_next_attempt_at, lease_owner = null, lease_token = null, lease_expires_at = null, last_reason_code = p_reason_code, updated_at = now_value
        where id = job_row.id;
      end if;
    else
      update public.bank_reconciliation_jobs
      set state = 'SUCCEEDED', lease_owner = null, lease_token = null, lease_expires_at = null, terminal_at = now_value, last_reason_code = p_reason_code, updated_at = now_value
      where id = job_row.id;
    end if;
  end if;
  insert into public.bank_verification_events (
    verification_id,
    user_id,
    event_type,
    state,
    reason_code,
    attempt
  ) values (
    p_verification_id,
    actor,
    event_type,
    p_state,
    p_reason_code,
    0
  );
  return public.sened_bank_intent_json(updated_row);
end;
$$;

create or replace function public.enqueue_bank_reconciliation_job_v1(
  p_verification_id uuid,
  p_max_attempts integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  actor uuid := auth.uid();
  intent_row public.bank_verification_intents%rowtype;
  job_row public.bank_reconciliation_jobs%rowtype;
  max_attempts_value integer := coalesce(p_max_attempts, 5);
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'bank_forbidden';
  end if;
  if max_attempts_value not between 1 and 20 then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  select intent_row.*
  into intent_row
  from public.bank_verification_intents intent_row
  where intent_row.id = p_verification_id
    and intent_row.user_id = actor;
  if not found then
    raise exception using errcode = 'P0002', message = 'bank_verification_not_found';
  end if;
  insert into public.bank_reconciliation_jobs (
    verification_id,
    user_id,
    provider,
    max_attempts,
    next_attempt_at
  ) values (
    intent_row.id,
    actor,
    intent_row.provider,
    max_attempts_value,
    clock_timestamp()
  )
  on conflict (verification_id) do nothing;
  select job_row.*
  into job_row
  from public.bank_reconciliation_jobs job_row
  where job_row.verification_id = intent_row.id;
  return public.sened_bank_job_json(job_row);
end;
$$;

create or replace function public.claim_bank_reconciliation_job_v1(
  p_worker_id text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  worker_id_value text := btrim(p_worker_id);
  lease_seconds_value integer := coalesce(p_lease_seconds, 60);
  now_value timestamptz := clock_timestamp();
  job_row public.bank_reconciliation_jobs%rowtype;
  intent_row public.bank_verification_intents%rowtype;
begin
  if worker_id_value is null or char_length(worker_id_value) not between 1 and 128 or lease_seconds_value not between 1 and 900 then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  select job_row.*
  into job_row
  from public.bank_reconciliation_jobs job_row
  where job_row.state in ('QUEUED', 'RETRY_SCHEDULED')
    and job_row.next_attempt_at <= now_value
    and job_row.attempt < job_row.max_attempts
  order by job_row.next_attempt_at, job_row.created_at, job_row.id
  limit 1
  for update skip locked;
  if not found then
    select job_row.*
    into job_row
    from public.bank_reconciliation_jobs job_row
    where job_row.state = 'CLAIMED'
      and job_row.lease_expires_at <= now_value
      and job_row.attempt < job_row.max_attempts
    order by job_row.lease_expires_at, job_row.created_at, job_row.id
    limit 1
    for update skip locked;
  end if;
  if not found then
    return null;
  end if;
  update public.bank_reconciliation_jobs
  set
    state = 'CLAIMED',
    attempt = job_row.attempt + 1,
    lease_owner = worker_id_value,
    lease_token = gen_random_uuid(),
    lease_expires_at = now_value + make_interval(secs => lease_seconds_value),
    updated_at = now_value
  where id = job_row.id
  returning * into job_row;
  select intent_row.*
  into intent_row
  from public.bank_verification_intents intent_row
  where intent_row.id = job_row.verification_id;
  if not found then
    raise exception using errcode = '23503', message = 'bank_verification_not_found';
  end if;
  return jsonb_build_object(
    'job', public.sened_bank_job_json(job_row),
    'intent', public.sened_bank_intent_json(intent_row)
  );
end;
$$;

create or replace function public.get_bank_reconciliation_job_v1(p_verification_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select public.sened_bank_job_json(job_row)
  from public.bank_reconciliation_jobs job_row
  where job_row.verification_id = p_verification_id
    and (auth.uid() is null or job_row.user_id = auth.uid());
$$;

create or replace function public.reschedule_bank_reconciliation_job_v1(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_reason_code text,
  p_next_attempt_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  now_value timestamptz := clock_timestamp();
  job_row public.bank_reconciliation_jobs%rowtype;
  intent_row public.bank_verification_intents%rowtype;
begin
  select job_row.*
  into job_row
  from public.bank_reconciliation_jobs job_row
  where job_row.id = p_job_id
  for update;
  if not found or job_row.state <> 'CLAIMED' or job_row.lease_owner <> btrim(p_worker_id) or job_row.lease_token <> p_lease_token then
    raise exception using errcode = 'P0001', message = 'bank_invalid_lease';
  end if;
  if p_next_attempt_at is null or p_reason_code not in (
    'PROVIDER_TIMEOUT',
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_NOT_FOUND',
    'PROVIDER_UNSETTLED',
    'PROVIDER_RESPONSE_INVALID',
    'EVIDENCE_INCOMPLETE',
    'MANUAL_REVIEW_REQUIRED'
  ) then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  select intent_row.*
  into intent_row
  from public.bank_verification_intents intent_row
  where intent_row.id = job_row.verification_id
  for update;
  if job_row.attempt >= job_row.max_attempts then
    update public.bank_reconciliation_jobs
    set state = 'MANUAL_REVIEW', lease_owner = null, lease_token = null, lease_expires_at = null, last_reason_code = 'MANUAL_REVIEW_REQUIRED', terminal_at = now_value, updated_at = now_value
    where id = job_row.id
    returning * into job_row;
    update public.bank_verification_intents
    set state = 'PENDING_RECONCILIATION', reason_code = 'MANUAL_REVIEW_REQUIRED', updated_at = now_value
    where id = job_row.verification_id;
    insert into public.bank_verification_events (verification_id, user_id, event_type, state, reason_code, attempt)
    values (job_row.verification_id, job_row.user_id, 'MANUAL_REVIEW', 'PENDING_RECONCILIATION', 'MANUAL_REVIEW_REQUIRED', job_row.attempt);
  else
    update public.bank_reconciliation_jobs
    set state = 'RETRY_SCHEDULED', next_attempt_at = p_next_attempt_at, lease_owner = null, lease_token = null, lease_expires_at = null, last_reason_code = p_reason_code, updated_at = now_value
    where id = job_row.id
    returning * into job_row;
    update public.bank_verification_intents
    set state = 'PENDING_RECONCILIATION', reason_code = p_reason_code, updated_at = now_value
    where id = job_row.verification_id;
    insert into public.bank_verification_events (verification_id, user_id, event_type, state, reason_code, attempt)
    values (job_row.verification_id, job_row.user_id, 'RETRY_SCHEDULED', 'PENDING_RECONCILIATION', p_reason_code, job_row.attempt);
  end if;
  return public.sened_bank_job_json(job_row);
end;
$$;

create or replace function public.finalize_bank_reconciliation_job_v1(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_state text,
  p_reason_code text,
  p_evidence_fingerprint text,
  p_provider_transaction_identity_hmac text,
  p_ledger_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  now_value timestamptz := clock_timestamp();
  job_row public.bank_reconciliation_jobs%rowtype;
  intent_row public.bank_verification_intents%rowtype;
  event_type text;
begin
  if p_state not in ('VERIFIED', 'REJECTED') then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  if p_reason_code not in (
    'AMOUNT_MISMATCH',
    'CURRENCY_MISMATCH',
    'DIRECTION_MISMATCH',
    'SENDER_MISMATCH',
    'RECEIVER_MISMATCH',
    'TIMESTAMP_MISMATCH',
    'VERIFIED'
  ) then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  if p_state = 'VERIFIED' and (
    p_evidence_fingerprint is null or p_evidence_fingerprint !~ '^[0-9a-f]{64}$' or
    p_provider_transaction_identity_hmac is null or p_provider_transaction_identity_hmac !~ '^[0-9a-f]{64}$'
  ) then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  if p_state = 'REJECTED' and p_ledger_entry_id is not null then
    raise exception using errcode = '22023', message = 'bank_invalid_request';
  end if;
  select job_row.*
  into job_row
  from public.bank_reconciliation_jobs job_row
  where job_row.id = p_job_id
  for update;
  if not found or job_row.state <> 'CLAIMED' or job_row.lease_owner <> btrim(p_worker_id) or job_row.lease_token <> p_lease_token then
    raise exception using errcode = 'P0001', message = 'bank_invalid_lease';
  end if;
  select intent_row.*
  into intent_row
  from public.bank_verification_intents intent_row
  where intent_row.id = job_row.verification_id
  for update;
  event_type := case p_state when 'VERIFIED' then 'VERIFIED' else 'REJECTED' end;
  update public.bank_verification_intents
  set state = p_state,
      reason_code = p_reason_code,
      evidence_fingerprint = p_evidence_fingerprint,
      provider_transaction_identity_hmac = p_provider_transaction_identity_hmac,
      ledger_entry_id = p_ledger_entry_id,
      verified_at = case when p_state = 'VERIFIED' then now_value else null end,
      rejected_at = case when p_state = 'REJECTED' then now_value else null end,
      updated_at = now_value
  where id = job_row.verification_id;
  update public.bank_reconciliation_jobs
  set state = 'SUCCEEDED', lease_owner = null, lease_token = null, lease_expires_at = null, last_reason_code = p_reason_code, terminal_at = now_value, updated_at = now_value
  where id = job_row.id
  returning * into job_row;
  insert into public.bank_verification_events (verification_id, user_id, event_type, state, reason_code, attempt)
  values (job_row.verification_id, job_row.user_id, event_type, p_state, p_reason_code, job_row.attempt);
  return public.sened_bank_job_json(job_row);
end;
$$;

create or replace function public.plan_bank_compensating_reversal_v1(p_verification_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  actor uuid := auth.uid();
  intent_row public.bank_verification_intents%rowtype;
  event_id uuid := gen_random_uuid();
  now_value timestamptz := clock_timestamp();
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'bank_forbidden';
  end if;
  select intent_row.*
  into intent_row
  from public.bank_verification_intents intent_row
  where intent_row.id = p_verification_id
    and intent_row.user_id = actor;
  if not found then
    raise exception using errcode = 'P0002', message = 'bank_verification_not_found';
  end if;
  insert into public.bank_verification_events (
    id,
    verification_id,
    user_id,
    event_type,
    state,
    reason_code,
    attempt,
    created_at
  ) values (
    event_id,
    p_verification_id,
    actor,
    'REVERSAL_PLANNED',
    intent_row.state,
    intent_row.reason_code,
    0,
    now_value
  );
  return jsonb_build_object(
    'id', event_id,
    'verificationId', p_verification_id,
    'userId', actor,
    'eventType', 'REVERSAL_PLANNED',
    'state', intent_row.state,
    'reasonCode', intent_row.reason_code,
    'attempt', 0,
    'createdAt', to_char(now_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

drop policy if exists "bank bindings owner read" on public.bank_account_bindings;
create policy "bank bindings owner read"
on public.bank_account_bindings
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "bank intents owner read" on public.bank_verification_intents;
create policy "bank intents owner read"
on public.bank_verification_intents
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "bank events owner read" on public.bank_verification_events;
create policy "bank events owner read"
on public.bank_verification_events
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "bank jobs owner read" on public.bank_reconciliation_jobs;
create policy "bank jobs owner read"
on public.bank_reconciliation_jobs
for select
to authenticated
using (user_id = auth.uid());

revoke all on table public.bank_account_bindings from anon, authenticated;
revoke all on table public.bank_verification_intents from anon, authenticated;
revoke all on table public.bank_verification_events from anon, authenticated;
revoke all on table public.bank_reconciliation_jobs from anon, authenticated;
revoke all on table private.bank_verification_secrets from anon, authenticated;

revoke all on function public.sened_bank_intent_response(public.bank_verification_intents, boolean) from public, anon, authenticated;
revoke all on function public.sened_bank_intent_json(public.bank_verification_intents) from public, anon, authenticated;
revoke all on function public.sened_bank_job_json(public.bank_reconciliation_jobs) from public, anon, authenticated;
revoke all on function public.sened_bank_block_event_mutation() from public, anon, authenticated;
revoke all on function public.get_bank_account_binding_v1(uuid) from public, anon;
revoke all on function public.create_bank_verification_intent_v1(uuid, text, text, text, text, numeric, text, text, timestamptz, text) from public, anon;
revoke all on function public.get_bank_verification_intent_v1(uuid) from public, anon;
revoke all on function public.append_bank_verification_event_v1(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.record_bank_verification_result_v1(uuid, text, text, text, text, uuid, timestamptz) from public, anon;
revoke all on function public.enqueue_bank_reconciliation_job_v1(uuid, integer) from public, anon;
revoke all on function public.claim_bank_reconciliation_job_v1(text, integer) from public, anon, authenticated;
revoke all on function public.get_bank_reconciliation_job_v1(uuid) from public, anon;
revoke all on function public.reschedule_bank_reconciliation_job_v1(uuid, text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.finalize_bank_reconciliation_job_v1(uuid, text, uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.plan_bank_compensating_reversal_v1(uuid) from public, anon;

grant execute on function public.get_bank_account_binding_v1(uuid) to authenticated;
grant execute on function public.create_bank_verification_intent_v1(uuid, text, text, text, text, numeric, text, text, timestamptz, text) to authenticated;
grant execute on function public.get_bank_verification_intent_v1(uuid) to authenticated;
grant execute on function public.record_bank_verification_result_v1(uuid, text, text, text, text, uuid, timestamptz) to authenticated;
grant execute on function public.enqueue_bank_reconciliation_job_v1(uuid, integer) to authenticated;
grant execute on function public.get_bank_reconciliation_job_v1(uuid) to authenticated;
grant execute on function public.plan_bank_compensating_reversal_v1(uuid) to authenticated;
grant execute on function public.claim_bank_reconciliation_job_v1(text, integer) to service_role;
grant execute on function public.reschedule_bank_reconciliation_job_v1(uuid, text, uuid, text, timestamptz) to service_role;
grant execute on function public.finalize_bank_reconciliation_job_v1(uuid, text, uuid, text, text, text, uuid) to service_role;
