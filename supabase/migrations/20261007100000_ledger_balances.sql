-- Server-side account balances for a group, read in one snapshot.
--
-- Why: the home screen and /draw used to total the pot by summing the entries
-- list, which the entries route caps at 100, so a group past 100 entries had no
-- balance at all. Summing in Postgres has no such limit and cannot disagree
-- with the chain head it is reported against.
--
-- Shape (jsonb):
--   { groupId, headSequence, entryCount,
--     balances: [{ accountId, code, name, accountType, balance }] }
-- `headSequence` and `entryCount` are decimal strings (bigint) and `balance` is
-- an exact numeric string with two decimals, debit-positive (debits - credits)
-- for every account regardless of its type; the caller decides what a sign
-- means. Every account of the group is listed, including those with no
-- postings (balance "0.00"), ordered by code.
--
-- Snapshot: the whole result is ONE sql statement. Under READ COMMITTED every
-- statement gets a single snapshot, and post_ledger_entry_v1 inserts the entry,
-- its postings and the head update in one transaction, so a snapshot sees all
-- of an entry or none of it. The head, the entry count and every balance in the
-- result are therefore computed against the same set of committed entries:
-- sum(postings) for the group nets to zero across accounts, and headSequence
-- is the sequence of the newest entry those balances include. (Splitting this
-- into several statements would let an entry commit between them.)
--
-- Access: SECURITY DEFINER with the same gate as the other member reads
-- (sened_ledger_can_access_group); an outsider or a missing group is refused
-- with ledger_forbidden, never told which. No table policy is widened.
--
-- Cost: no running-balance table. Balances are sum() over ledger_entry_postings
-- via ledger_postings_group_account_idx (group_id, account_id, entry_id), plus
-- a heap visit per posting for direction and amount. Measured on a scratch
-- Postgres 16 this is a few milliseconds per few thousand postings, linear in
-- the group's postings, and a group's ledger is small (one entry per
-- contribution). A maintained table would add a hot row that every post must
-- update and a second source of truth to keep consistent with the chain; the
-- derived sum cannot drift, so it is preferred. No new index is added.

create or replace function public.get_ledger_balances_v1(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  tenant uuid;
  result jsonb;
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

  -- One statement, one snapshot (see the header).
  with net as (
    select
      posting.account_id,
      sum(case posting.direction when 'debit' then posting.amount else -posting.amount end) as balance
    from public.ledger_entry_postings posting
    where posting.group_id = p_group_id
    group by posting.account_id
  )
  select jsonb_build_object(
    'groupId', p_group_id,
    'headSequence', coalesce((
      select head_row.last_sequence from public.ledger_group_heads head_row
      where head_row.group_id = p_group_id
    ), 0)::text,
    'entryCount', (
      select count(*) from public.ledger_entries entry_row where entry_row.group_id = p_group_id
    )::text,
    'balances', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'accountId', account_row.id,
          'code', account_row.code,
          'name', account_row.name,
          'accountType', account_row.account_type,
          'balance', round(coalesce(net.balance, 0), 2)::text
        )
        order by account_row.code
      )
      from public.ledger_accounts account_row
      left join net on net.account_id = account_row.id
      where account_row.group_id = p_group_id
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.get_ledger_balances_v1(uuid) from public, anon;
grant execute on function public.get_ledger_balances_v1(uuid) to authenticated;
