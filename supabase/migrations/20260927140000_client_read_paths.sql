-- Read paths a client needs before it can verify anything.
--
-- `get_bank_account_binding_v1(uuid)` takes a binding id, and a client cannot
-- know its own binding id. The result was that task #14 — the voice → bank
-- verification hand-off — was blocked not by "no auth" but by the absence of a
-- *list*: `toBankVerificationIntent` needs `bankAccountBindingId`, that field is
-- the one the bank lookup is driven by, and there was no way for a browser to
-- obtain it. The same applies to the group the treasurer is acting for, which
-- the ledger correction form needs in order to post a compensating entry.
--
-- These two functions close both. They are deliberately reads scoped to
-- `auth.uid()` — a caller sees their own rows and nothing else — and they return
-- no secret: the account *fingerprints* are HMACs over masked account numbers,
-- never the numbers themselves, and the sealed reference ciphertext is not
-- included at all.
--
-- `security definer` with the same `search_path` discipline as the rest of the
-- file, and the same revoke/grant pair, because a grant naming a function that
-- does not exist is how this chain failed once already.
--
-- VERIFIED BY EXECUTION. `scripts/verify-migrations.ps1` applies every migration
-- to a throwaway Postgres 16, applies the whole set a second time to prove
-- idempotency, and then runs `scripts/verify-migrations.sql`, which exercises
-- these functions directly.

-- ── The caller's own bank account bindings ─────────────────────────────────

create or replace function public.list_bank_account_bindings_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', binding_row.id,
        'groupId', binding_row.group_id,
        'provider', binding_row.provider,
        'currency', binding_row.currency,
        'accountLabel', binding_row.account_label,
        'active', binding_row.active
      )
      order by binding_row.created_at, binding_row.id
    ),
    '[]'::jsonb
  )
  from public.bank_account_bindings binding_row
  where binding_row.user_id = auth.uid();
$$;

comment on function public.list_bank_account_bindings_v1() is
  'Every bank account binding belonging to the calling user, active or not. Exists because a client cannot otherwise know which binding id to submit; see the task #14 hand-off.';

-- ── The caller's group memberships, with the accounts each group uses ───────

create or replace function public.list_my_groups_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'groupId', group_row.id,
        'tenantId', group_row.tenant_id,
        'name', group_row.name,
        'currency', group_row.currency,
        'role', membership_row.role,
        'accounts', (
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', account_row.id,
                'code', account_row.code,
                'name', account_row.name,
                'type', account_row.account_type
              )
              order by account_row.code
            ),
            '[]'::jsonb
          )
          from public.ledger_accounts account_row
          where account_row.group_id = group_row.id
            and account_row.tenant_id = group_row.tenant_id
        )
      )
      order by group_row.name, group_row.id
    ),
    '[]'::jsonb
  )
  from public.ledger_group_memberships membership_row
  join public.ledger_groups group_row
    on group_row.id = membership_row.group_id
   and group_row.tenant_id = membership_row.tenant_id
  where membership_row.user_id = auth.uid()
    and membership_row.status = 'active';
$$;

comment on function public.list_my_groups_v1() is
  'Every active group the calling user belongs to, with its chart of accounts. Exists because a client cannot otherwise learn which group it is acting for, which the ledger correction form needs.';

revoke all on function public.list_bank_account_bindings_v1() from public, anon;
revoke all on function public.list_my_groups_v1() from public, anon;

grant execute on function public.list_bank_account_bindings_v1() to authenticated;
grant execute on function public.list_my_groups_v1() to authenticated;
