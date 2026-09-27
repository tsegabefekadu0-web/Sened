-- Group provisioning and the standard chart of accounts.
--
-- `ledger_accounts` has existed since 20260924214531_ledger_core.sql and nothing
-- has ever written a row into it: no seed, no function, no application code. The
-- consequence was concrete — `BankVerificationService` had a call site for a
-- `BankVerificationLedgerSink` and the implementation posted nothing, because it
-- had no account ids to resolve. A verification could succeed and produce no
-- ledger entry.
--
-- This migration closes that. It creates the one function a treasurer needs to
-- start a group, and it seeds the four accounts an Equb actually has.
--
-- Idempotent, per the repository's conventions: create-or-replace, an
-- `on conflict do nothing` on the account codes, and a unique constraint on
-- (group_id, code) that already exists in the baseline migration. Re-running it
-- adds nothing.
--
-- UNVERIFIED BY EXECUTION. `scripts/verify-migrations.ps1` applies every
-- migration to a throwaway Postgres 16 and runs `scripts/verify-migrations.sql`,
-- which now exercises the checks at the end of that file. That command has not
-- been run against this file — see the note in AGENTWORK.md section 6. Run it
-- before trusting this.

create or replace function public.sened_ledger_provision_group_v1(
  requested_group_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  new_group_id uuid;
  new_tenant_id uuid;
  group_row jsonb;
  account_row record;
begin
  if actor is null then
    raise exception using
      errcode = '42501',
      message = 'ledger_provision_unauthorized';
  end if;

  requested_group_name := btrim(coalesce(requested_group_name, ''));
  if char_length(requested_group_name) < 1 or char_length(requested_group_name) > 120 then
    raise exception using
      errcode = '22023',
      message = 'ledger_invalid_request';
  end if;

  -- A group belongs to the tenant of the person who created it. There is no
  -- cross-tenant path here on purpose.
  new_tenant_id := actor;
  new_group_id := gen_random_uuid();

  insert into public.ledger_groups (id, tenant_id, name, created_by)
  values (new_group_id, new_tenant_id, requested_group_name, actor);

  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status)
  values (new_group_id, new_tenant_id, actor, 'owner', 'active')
  on conflict (group_id, user_id) do nothing;

  -- The standard chart. Kept as a values list so the codes, the Amharic names
  -- and the types cannot drift apart, and so `ledger_accounts` is never empty
  -- for a group that exists.
  for account_row in
    select *
    from (
      values
        ('POT_CASH', 'የእቁብ ጥሬ ሂሳብ', 'asset'),
        ('CONTRIBUTION_INCOME', 'የስጠታ ገቢ', 'income'),
        ('PAYOUT_EXPENSE', 'የእጣ ክፍያ ወጪ', 'expense'),
        ('EQUITY_OPENING', 'የመክፈት ቀድሞ ሂሳብ', 'equity')
    ) as standard(code, name, account_type)
  loop
    insert into public.ledger_accounts (group_id, tenant_id, code, name, account_type)
    values (new_group_id, new_tenant_id, account_row.code, account_row.name, account_row.account_type)
    on conflict (group_id, code) do nothing;
  end loop;

  select jsonb_build_object(
    'groupId', group_row.id,
    'tenantId', group_row.tenant_id,
    'name', group_row.name,
    'created', true
  )
  into group_row
  from public.ledger_groups group_row
  where group_row.id = new_group_id
    and group_row.tenant_id = new_tenant_id;

  return group_row || jsonb_build_object(
    'accounts', (
      select jsonb_agg(
        jsonb_build_object(
          'id', account.id,
          'code', account.code,
          'name', account.name,
          'type', account.account_type
        )
        order by account.code
      )
      from public.ledger_accounts account
      where account.group_id = new_group_id
        and account.tenant_id = new_tenant_id
    )
  );
end;
$$;

comment on function public.sened_ledger_provision_group_v1(text) is
  'Creates a group owned by the calling user and seeds the four standard accounts: POT_CASH, CONTRIBUTION_INCOME, PAYOUT_EXPENSE, EQUITY_OPENING.';

revoke all on function public.sened_ledger_provision_group_v1(text) from public, anon;
grant execute on function public.sened_ledger_provision_group_v1(text) to authenticated;
