create table if not exists public.ledger_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  currency text not null default 'ETB' check (currency = 'ETB'),
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint ledger_groups_id_tenant_key unique (id, tenant_id)
);

create table if not exists public.ledger_group_memberships (
  group_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  role text not null check (role in ('owner', 'treasurer', 'member')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (group_id, user_id),
  constraint ledger_memberships_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict
);

create index if not exists ledger_memberships_user_tenant_idx
  on public.ledger_group_memberships (user_id, tenant_id);

create index if not exists ledger_memberships_tenant_idx
  on public.ledger_group_memberships (tenant_id, group_id);

create table if not exists public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  tenant_id uuid not null,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9._:-]{0,63}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  account_type text not null check (
    account_type in ('asset', 'liability', 'equity', 'income', 'expense')
  ),
  created_at timestamptz not null default clock_timestamp(),
  constraint ledger_accounts_id_group_key unique (id, group_id),
  constraint ledger_accounts_group_code_key unique (group_id, code),
  constraint ledger_accounts_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict
);

create index if not exists ledger_accounts_group_tenant_idx
  on public.ledger_accounts (group_id, tenant_id);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  tenant_id uuid not null,
  sequence bigint not null check (sequence > 0),
  occurred_at timestamptz not null check (
    occurred_at >= timestamptz '1900-01-01 00:00:00+00' and
    occurred_at < timestamptz '2101-01-01 00:00:00+00'
  ),
  recorded_at timestamptz not null default clock_timestamp(),
  entry_type text not null check (
    entry_type in ('journal', 'contribution', 'disbursement', 'adjustment', 'correction')
  ),
  corrects_entry_id uuid,
  rationale text,
  actor_id uuid not null references auth.users (id) on delete restrict,
  nonce uuid not null,
  previous_hash text not null check (previous_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text not null check (entry_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 128 and
    idempotency_key = btrim(idempotency_key) and
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  constraint ledger_entries_id_group_key unique (id, group_id),
  constraint ledger_entries_group_hash_key unique (group_id, entry_hash),
  constraint ledger_entries_group_sequence_key unique (group_id, sequence),
  constraint ledger_entries_group_idempotency_key unique (group_id, idempotency_key),
  constraint ledger_entries_group_nonce_key unique (group_id, nonce),
  constraint ledger_entries_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint ledger_entries_correction_shape_check check (
    (
      entry_type = 'correction' and
      corrects_entry_id is not null and
      corrects_entry_id <> id and
      rationale is not null and
      char_length(btrim(rationale)) between 10 and 1000 and
      rationale = btrim(rationale)
    ) or
    (
      entry_type <> 'correction' and
      corrects_entry_id is null and
      rationale is null
    )
  ),
  constraint ledger_entries_correction_fk
    foreign key (corrects_entry_id, group_id)
    references public.ledger_entries (id, group_id)
    on delete restrict
    deferrable initially deferred
);

create index if not exists ledger_entries_group_occurred_idx
  on public.ledger_entries (group_id, occurred_at desc, sequence desc);

create index if not exists ledger_entries_group_actor_idx
  on public.ledger_entries (group_id, actor_id, recorded_at desc);

create unique index if not exists ledger_entries_one_correction_per_original_idx
  on public.ledger_entries (group_id, corrects_entry_id)
  where corrects_entry_id is not null;

create table if not exists public.ledger_entry_postings (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null,
  group_id uuid not null,
  tenant_id uuid not null,
  account_id uuid not null,
  direction text not null check (direction in ('debit', 'credit')),
  amount numeric(20, 2) not null check (amount > 0),
  ordinal smallint not null check (ordinal between 1 and 100),
  created_at timestamptz not null default clock_timestamp(),
  constraint ledger_postings_entry_ordinal_key unique (entry_id, ordinal),
  constraint ledger_postings_entry_account_direction_key unique (entry_id, account_id, direction),
  constraint ledger_postings_entry_group_fk
    foreign key (entry_id, group_id)
    references public.ledger_entries (id, group_id)
    on delete restrict,
  constraint ledger_postings_account_group_fk
    foreign key (account_id, group_id)
    references public.ledger_accounts (id, group_id)
    on delete restrict,
  constraint ledger_postings_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict
);

create index if not exists ledger_postings_group_account_idx
  on public.ledger_entry_postings (group_id, account_id, entry_id);

create index if not exists ledger_postings_entry_idx
  on public.ledger_entry_postings (entry_id, ordinal);

create table if not exists public.ledger_group_heads (
  group_id uuid primary key,
  tenant_id uuid not null,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  last_hash text not null default repeat('0', 64) check (last_hash ~ '^[0-9a-f]{64}$'),
  last_entry_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  constraint ledger_group_heads_group_tenant_fk
    foreign key (group_id, tenant_id)
    references public.ledger_groups (id, tenant_id)
    on delete restrict,
  constraint ledger_group_heads_last_entry_fk
    foreign key (last_entry_id, group_id)
    references public.ledger_entries (id, group_id)
    on delete restrict
    deferrable initially deferred
);

create index if not exists ledger_group_heads_tenant_idx
  on public.ledger_group_heads (tenant_id, group_id);

create or replace function public.sened_ledger_is_tenant_owner(
  requested_group_id uuid,
  requested_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.ledger_groups group_row
    where group_row.id = requested_group_id
      and group_row.tenant_id = requested_tenant_id
      and group_row.tenant_id = auth.uid()
  );
$$;

create or replace function public.sened_ledger_can_access_group(
  requested_group_id uuid,
  requested_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.ledger_groups group_row
    where group_row.id = requested_group_id
      and group_row.tenant_id = requested_tenant_id
      and (
        group_row.tenant_id = auth.uid() or
        exists (
          select 1
          from public.ledger_group_memberships membership
          where membership.group_id = group_row.id
            and membership.tenant_id = group_row.tenant_id
            and membership.user_id = auth.uid()
            and membership.status = 'active'
        )
      )
  );
$$;

create or replace function public.sened_ledger_can_manage_group(
  requested_group_id uuid,
  requested_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.ledger_groups group_row
    where group_row.id = requested_group_id
      and group_row.tenant_id = requested_tenant_id
      and (
        group_row.tenant_id = auth.uid() or
        exists (
          select 1
          from public.ledger_group_memberships membership
          where membership.group_id = group_row.id
            and membership.tenant_id = group_row.tenant_id
            and membership.user_id = auth.uid()
            and membership.status = 'active'
            and membership.role in ('owner', 'treasurer')
        )
      )
  );
$$;

create or replace function public.sened_ledger_encode(value text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select char_length(value)::text || ':' || value;
$$;

create or replace function public.sened_ledger_initialize_group_head()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.ledger_group_heads (group_id, tenant_id)
  values (new.id, new.tenant_id)
  on conflict (group_id) do nothing;
  return new;
end;
$$;

drop trigger if exists ledger_groups_initialize_head on public.ledger_groups;
create trigger ledger_groups_initialize_head
after insert on public.ledger_groups
for each row execute function public.sened_ledger_initialize_group_head();

create or replace function public.sened_ledger_block_history_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'ledger_history_immutable';
end;
$$;

drop trigger if exists ledger_entries_block_mutation on public.ledger_entries;
create trigger ledger_entries_block_mutation
before update or delete on public.ledger_entries
for each row execute function public.sened_ledger_block_history_mutation();

drop trigger if exists ledger_postings_block_mutation on public.ledger_entry_postings;
create trigger ledger_postings_block_mutation
before update or delete on public.ledger_entry_postings
for each row execute function public.sened_ledger_block_history_mutation();

create or replace function public.sened_ledger_validate_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  debit_total numeric(38, 2) := 0;
  credit_total numeric(38, 2) := 0;
  original_entry public.ledger_entries%rowtype;
begin
  select
    coalesce(sum(posting.amount) filter (where posting.direction = 'debit'), 0),
    coalesce(sum(posting.amount) filter (where posting.direction = 'credit'), 0)
  into debit_total, credit_total
  from public.ledger_entry_postings posting
  where posting.entry_id = new.id
    and posting.group_id = new.group_id;

  if not exists (
    select 1
    from public.ledger_entry_postings posting
    where posting.entry_id = new.id
      and posting.group_id = new.group_id
  ) then
    raise exception using errcode = '23514', message = 'ledger_entry_has_no_postings';
  end if;

  if debit_total <> credit_total then
    raise exception using errcode = '23514', message = 'ledger_entry_unbalanced';
  end if;

  if new.entry_type = 'correction' then
    select source.*
    into original_entry
    from public.ledger_entries source
    where source.id = new.corrects_entry_id
      and source.group_id = new.group_id;

    if not found or original_entry.id = new.id then
      raise exception using errcode = '23514', message = 'ledger_invalid_correction_target';
    end if;

    if new.occurred_at < original_entry.occurred_at then
      raise exception using errcode = '23514', message = 'ledger_invalid_correction_time';
    end if;

    if exists (
      select 1
      from public.ledger_entries correction
      where correction.group_id = new.group_id
        and correction.corrects_entry_id = new.corrects_entry_id
        and correction.id <> new.id
    ) then
      raise exception using errcode = '23514', message = 'ledger_invalid_correction_duplicate';
    end if;

    if exists (
      with expected as (
        select
          posting.account_id,
          case posting.direction
            when 'debit' then 'credit'
            else 'debit'
          end as direction,
          sum(posting.amount) as amount
        from public.ledger_entry_postings posting
        where posting.entry_id = new.corrects_entry_id
          and posting.group_id = new.group_id
        group by posting.account_id, posting.direction
      ),
      actual as (
        select
          posting.account_id,
          posting.direction,
          sum(posting.amount) as amount
        from public.ledger_entry_postings posting
        where posting.entry_id = new.id
          and posting.group_id = new.group_id
        group by posting.account_id, posting.direction
      )
      select 1
      from expected
      full outer join actual
        on actual.account_id = expected.account_id
        and actual.direction = expected.direction
      where expected.account_id is null
        or actual.account_id is null
        or expected.amount is distinct from actual.amount
    ) then
      raise exception using errcode = '23514', message = 'ledger_invalid_correction_amounts';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ledger_entries_validate_at_commit on public.ledger_entries;
create constraint trigger ledger_entries_validate_at_commit
after insert on public.ledger_entries
deferrable initially deferred
for each row execute function public.sened_ledger_validate_entry();

create or replace function public.post_ledger_entry_v1(
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
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
  head public.ledger_group_heads%rowtype;
  existing_entry public.ledger_entries%rowtype;
  posting jsonb;
  posting_count integer := 0;
  new_entry_id uuid;
  nonce uuid;
  next_sequence bigint;
  previous_hash text;
  recorded timestamptz;
  account_id uuid;
  direction text;
  amount numeric(20, 2);
  canonical_text text;
  request_fingerprint text;
  entry_hash text;
  response_entry jsonb;
  response_postings jsonb;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  -- Authorization is the caller's role in THIS group, read from
  -- ledger_group_memberships by sened_ledger_can_manage_group below. The JWT's
  -- app_metadata is deliberately not consulted: nothing sets it, and a global
  -- claim cannot express "treasurer of group A, member of group B".

  select group_row.tenant_id
  into tenant
  from public.ledger_groups group_row
  where group_row.id = requested_group_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'ledger_group_not_found';
  end if;

  if not public.sened_ledger_can_manage_group(requested_group_id, tenant) then
    raise exception using errcode = '42501', message = 'ledger_forbidden';
  end if;

  if requested_idempotency_key is null
    or char_length(requested_idempotency_key) not between 1 and 128
    or requested_idempotency_key <> btrim(requested_idempotency_key)
    or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  if requested_occurred_at is null
    or requested_occurred_at < timestamptz '1900-01-01 00:00:00+00'
    or requested_occurred_at >= timestamptz '2101-01-01 00:00:00+00' then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  if requested_entry_type is null
    or requested_entry_type not in ('journal', 'contribution', 'disbursement', 'adjustment', 'correction') then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  if requested_entry_type = 'correction' then
    if requested_corrects_entry_id is null
      or requested_rationale is null
      or requested_rationale <> btrim(requested_rationale)
      or char_length(requested_rationale) not between 10 and 1000 then
      raise exception using errcode = '22023', message = 'ledger_invalid_correction';
    end if;
  elsif requested_corrects_entry_id is not null or requested_rationale is not null then
    raise exception using errcode = '22023', message = 'ledger_invalid_correction';
  end if;

  if jsonb_typeof(requested_postings) is distinct from 'array'
    or jsonb_array_length(requested_postings) not between 2 and 100 then
    raise exception using errcode = '22023', message = 'ledger_invalid_request';
  end if;

  canonical_text := 'sened-ledger-request-v1' || chr(10)
    || public.sened_ledger_encode('actorId') || chr(10)
    || public.sened_ledger_encode(actor::text) || chr(10)
    || public.sened_ledger_encode('groupId') || chr(10)
    || public.sened_ledger_encode(requested_group_id::text) || chr(10)
    || public.sened_ledger_encode('idempotencyKey') || chr(10)
    || public.sened_ledger_encode(requested_idempotency_key) || chr(10)
    || public.sened_ledger_encode('occurredAt') || chr(10)
    || public.sened_ledger_encode(to_char(requested_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || chr(10)
    || public.sened_ledger_encode('entryType') || chr(10)
    || public.sened_ledger_encode(requested_entry_type) || chr(10)
    || public.sened_ledger_encode('correctsEntryId') || chr(10)
    || public.sened_ledger_encode(coalesce(requested_corrects_entry_id::text, '')) || chr(10)
    || public.sened_ledger_encode('rationale') || chr(10)
    || public.sened_ledger_encode(coalesce(requested_rationale, '')) || chr(10)
    || public.sened_ledger_encode('posting.count') || chr(10)
    || public.sened_ledger_encode(jsonb_array_length(requested_postings)::text);

  for posting in select value from jsonb_array_elements(requested_postings)
  loop
    posting_count := posting_count + 1;
    if jsonb_typeof(posting) is distinct from 'object'
      or posting - array['accountId', 'direction', 'amount'] <> '{}'::jsonb
      or jsonb_typeof(posting -> 'accountId') is distinct from 'string'
      or jsonb_typeof(posting -> 'direction') is distinct from 'string'
      or jsonb_typeof(posting -> 'amount') is distinct from 'string'
      or (posting ->> 'accountId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (posting ->> 'direction') not in ('debit', 'credit')
      or (posting ->> 'amount') !~ '^(0|[1-9][0-9]{0,17})\.[0-9]{2}$' then
      raise exception using errcode = '22023', message = 'ledger_invalid_posting';
    end if;

    account_id := (posting ->> 'accountId')::uuid;
    direction := posting ->> 'direction';
    amount := (posting ->> 'amount')::numeric(20, 2);
    if amount <= 0 then
      raise exception using errcode = '22023', message = 'ledger_invalid_posting';
    end if;

    if not exists (
      select 1
      from public.ledger_accounts account_row
      where account_row.id = account_id
        and account_row.group_id = requested_group_id
        and account_row.tenant_id = tenant
    ) then
      raise exception using errcode = 'P0002', message = 'ledger_account_not_found';
    end if;

    canonical_text := canonical_text || chr(10)
      || public.sened_ledger_encode('posting.' || posting_count::text || '.accountId') || chr(10)
      || public.sened_ledger_encode(account_id::text) || chr(10)
      || public.sened_ledger_encode('posting.' || posting_count::text || '.direction') || chr(10)
      || public.sened_ledger_encode(direction) || chr(10)
      || public.sened_ledger_encode('posting.' || posting_count::text || '.amount') || chr(10)
      || public.sened_ledger_encode(amount::text);
  end loop;

  request_fingerprint := encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex');

  insert into public.ledger_group_heads (group_id, tenant_id)
  values (requested_group_id, tenant)
  on conflict (group_id) do nothing;

  select head_row.*
  into head
  from public.ledger_group_heads head_row
  where head_row.group_id = requested_group_id
  for update;

  select source.*
  into existing_entry
  from public.ledger_entries source
  where source.group_id = requested_group_id
    and source.idempotency_key = requested_idempotency_key;

  if found then
    if existing_entry.request_fingerprint <> request_fingerprint then
      raise exception using errcode = 'P0001', message = 'ledger_idempotency_conflict';
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', posting.id,
          'ordinal', posting.ordinal,
          'accountId', posting.account_id,
          'direction', posting.direction,
          'amount', posting.amount::text
        ) order by posting.ordinal
      ),
      '[]'::jsonb
    )
    into response_postings
    from public.ledger_entry_postings posting
    where posting.entry_id = existing_entry.id
      and posting.group_id = requested_group_id;

    response_entry := jsonb_build_object(
      'id', existing_entry.id,
      'groupId', existing_entry.group_id,
      'tenantId', existing_entry.tenant_id,
      'sequence', existing_entry.sequence::text,
      'occurredAt', to_char(existing_entry.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'recordedAt', to_char(existing_entry.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'entryType', existing_entry.entry_type,
      'correctsEntryId', existing_entry.corrects_entry_id,
      'rationale', existing_entry.rationale,
      'actorId', existing_entry.actor_id,
      'nonce', existing_entry.nonce,
      'previousHash', existing_entry.previous_hash,
      'entryHash', existing_entry.entry_hash,
      'requestFingerprint', existing_entry.request_fingerprint,
      'idempotencyKey', existing_entry.idempotency_key,
      'postings', response_postings
    );
    return jsonb_build_object('entry', response_entry, 'replayed', true);
  end if;

  new_entry_id := gen_random_uuid();
  nonce := gen_random_uuid();
  next_sequence := head.last_sequence + 1;
  previous_hash := head.last_hash;
  recorded := clock_timestamp();

  canonical_text := 'sened-ledger-entry-v1' || chr(10)
    || public.sened_ledger_encode('id') || chr(10)
    || public.sened_ledger_encode(new_entry_id::text) || chr(10)
    || public.sened_ledger_encode('groupId') || chr(10)
    || public.sened_ledger_encode(requested_group_id::text) || chr(10)
    || public.sened_ledger_encode('tenantId') || chr(10)
    || public.sened_ledger_encode(tenant::text) || chr(10)
    || public.sened_ledger_encode('sequence') || chr(10)
    || public.sened_ledger_encode(next_sequence::text) || chr(10)
    || public.sened_ledger_encode('occurredAt') || chr(10)
    || public.sened_ledger_encode(to_char(requested_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || chr(10)
    || public.sened_ledger_encode('recordedAt') || chr(10)
    || public.sened_ledger_encode(to_char(recorded at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) || chr(10)
    || public.sened_ledger_encode('entryType') || chr(10)
    || public.sened_ledger_encode(requested_entry_type) || chr(10)
    || public.sened_ledger_encode('correctsEntryId') || chr(10)
    || public.sened_ledger_encode(coalesce(requested_corrects_entry_id::text, '')) || chr(10)
    || public.sened_ledger_encode('rationale') || chr(10)
    || public.sened_ledger_encode(coalesce(requested_rationale, '')) || chr(10)
    || public.sened_ledger_encode('actorId') || chr(10)
    || public.sened_ledger_encode(actor::text) || chr(10)
    || public.sened_ledger_encode('nonce') || chr(10)
    || public.sened_ledger_encode(nonce::text) || chr(10)
    || public.sened_ledger_encode('previousHash') || chr(10)
    || public.sened_ledger_encode(previous_hash) || chr(10)
    || public.sened_ledger_encode('requestFingerprint') || chr(10)
    || public.sened_ledger_encode(request_fingerprint) || chr(10)
    || public.sened_ledger_encode('idempotencyKey') || chr(10)
    || public.sened_ledger_encode(requested_idempotency_key) || chr(10)
    || public.sened_ledger_encode('posting.count') || chr(10)
    || public.sened_ledger_encode(jsonb_array_length(requested_postings)::text);

  posting_count := 0;
  for posting in select value from jsonb_array_elements(requested_postings)
  loop
    posting_count := posting_count + 1;
    account_id := (posting ->> 'accountId')::uuid;
    direction := posting ->> 'direction';
    amount := (posting ->> 'amount')::numeric(20, 2);
    canonical_text := canonical_text || chr(10)
      || public.sened_ledger_encode('posting.' || posting_count::text || '.accountId') || chr(10)
      || public.sened_ledger_encode(account_id::text) || chr(10)
      || public.sened_ledger_encode('posting.' || posting_count::text || '.direction') || chr(10)
      || public.sened_ledger_encode(direction) || chr(10)
      || public.sened_ledger_encode('posting.' || posting_count::text || '.amount') || chr(10)
      || public.sened_ledger_encode(amount::text);
  end loop;

  entry_hash := encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex');

  insert into public.ledger_entries (
    id,
    group_id,
    tenant_id,
    sequence,
    occurred_at,
    recorded_at,
    entry_type,
    corrects_entry_id,
    rationale,
    actor_id,
    nonce,
    previous_hash,
    entry_hash,
    request_fingerprint,
    idempotency_key
  ) values (
    new_entry_id,
    requested_group_id,
    tenant,
    next_sequence,
    requested_occurred_at,
    recorded,
    requested_entry_type,
    requested_corrects_entry_id,
    requested_rationale,
    actor,
    nonce,
    previous_hash,
    entry_hash,
    request_fingerprint,
    requested_idempotency_key
  );

  posting_count := 0;
  for posting in select value from jsonb_array_elements(requested_postings)
  loop
    posting_count := posting_count + 1;
    account_id := (posting ->> 'accountId')::uuid;
    direction := posting ->> 'direction';
    amount := (posting ->> 'amount')::numeric(20, 2);
    insert into public.ledger_entry_postings (
      entry_id,
      group_id,
      tenant_id,
      account_id,
      direction,
      amount,
      ordinal
    ) values (
      new_entry_id,
      requested_group_id,
      tenant,
      account_id,
      direction,
      amount,
      posting_count
    );
  end loop;

  update public.ledger_group_heads
  set
    last_sequence = next_sequence,
    last_hash = entry_hash,
    last_entry_id = new_entry_id,
    updated_at = recorded
  where ledger_group_heads.group_id = requested_group_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', posting.id,
        'ordinal', posting.ordinal,
        'accountId', posting.account_id,
        'direction', posting.direction,
        'amount', posting.amount::text
      ) order by posting.ordinal
    ),
    '[]'::jsonb
  )
  into response_postings
  from public.ledger_entry_postings posting
  where posting.entry_id = new_entry_id
    and posting.group_id = requested_group_id;

  response_entry := jsonb_build_object(
    'id', new_entry_id,
    'groupId', requested_group_id,
    'tenantId', tenant,
    'sequence', next_sequence::text,
    'occurredAt', to_char(requested_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'recordedAt', to_char(recorded at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'entryType', requested_entry_type,
    'correctsEntryId', requested_corrects_entry_id,
    'rationale', requested_rationale,
    'actorId', actor,
    'nonce', nonce,
    'previousHash', previous_hash,
    'entryHash', entry_hash,
    'requestFingerprint', request_fingerprint,
    'idempotencyKey', requested_idempotency_key,
    'postings', response_postings
  );
  return jsonb_build_object('entry', response_entry, 'replayed', false);
end;
$$;

alter table public.ledger_groups enable row level security;
alter table public.ledger_group_memberships enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.ledger_entry_postings enable row level security;
alter table public.ledger_group_heads enable row level security;

drop policy if exists "ledger group members read groups" on public.ledger_groups;
create policy "ledger group members read groups"
on public.ledger_groups
for select
to authenticated
using (public.sened_ledger_can_access_group(id, tenant_id));

drop policy if exists "members read own ledger memberships" on public.ledger_group_memberships;
create policy "members read own ledger memberships"
on public.ledger_group_memberships
for select
to authenticated
using (user_id = auth.uid() or tenant_id = auth.uid());

drop policy if exists "ledger group members read accounts" on public.ledger_accounts;
create policy "ledger group members read accounts"
on public.ledger_accounts
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "ledger group members read entries" on public.ledger_entries;
create policy "ledger group members read entries"
on public.ledger_entries
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "ledger group members read postings" on public.ledger_entry_postings;
create policy "ledger group members read postings"
on public.ledger_entry_postings
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

drop policy if exists "ledger group members read heads" on public.ledger_group_heads;
create policy "ledger group members read heads"
on public.ledger_group_heads
for select
to authenticated
using (public.sened_ledger_can_access_group(group_id, tenant_id));

revoke all on table public.ledger_groups from anon, authenticated;
revoke all on table public.ledger_group_memberships from anon, authenticated;
revoke all on table public.ledger_accounts from anon, authenticated;
revoke all on table public.ledger_entries from anon, authenticated;
revoke all on table public.ledger_entry_postings from anon, authenticated;
revoke all on table public.ledger_group_heads from anon, authenticated;

grant select on table public.ledger_groups to authenticated;
grant select on table public.ledger_group_memberships to authenticated;
grant select on table public.ledger_accounts to authenticated;
grant select on table public.ledger_entries to authenticated;
grant select on table public.ledger_entry_postings to authenticated;
grant select on table public.ledger_group_heads to authenticated;

revoke all on function public.sened_ledger_is_tenant_owner(uuid, uuid) from public, anon;
revoke all on function public.sened_ledger_can_access_group(uuid, uuid) from public, anon;
revoke all on function public.sened_ledger_can_manage_group(uuid, uuid) from public, anon;
revoke all on function public.sened_ledger_encode(text) from public, anon, authenticated;
revoke all on function public.sened_ledger_initialize_group_head() from public, anon, authenticated;
revoke all on function public.sened_ledger_block_history_mutation() from public, anon, authenticated;
revoke all on function public.sened_ledger_validate_entry() from public, anon, authenticated;
revoke all on function public.post_ledger_entry_v1(uuid, text, timestamptz, text, uuid, text, jsonb) from public, anon;

grant execute on function public.sened_ledger_is_tenant_owner(uuid, uuid) to authenticated;
grant execute on function public.sened_ledger_can_access_group(uuid, uuid) to authenticated;
grant execute on function public.sened_ledger_can_manage_group(uuid, uuid) to authenticated;
grant execute on function public.post_ledger_entry_v1(uuid, text, timestamptz, text, uuid, text, jsonb) to authenticated;
