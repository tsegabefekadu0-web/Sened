-- A seal after the seal deadline is refused (draw_seal_deadline_passed).
--
-- Before: submit_draw_seal_v1 took a seal at any time until the commit. A member who had
-- been recorded as missed by a cancel path (or was about to be) could still seal after
-- draw_sessions.seal_deadline, and then no longer counted as missed; the deadline that
-- the cancel path waits for was not a deadline for sealing at all.
--
-- Now the deadline closes sealing. This cannot strand a round:
--   * all eligible members sealed before the deadline: commit_draw_from_seals_v1 has no
--     deadline check and still commits (nothing here touches it);
--   * somebody is missing after the deadline: nobody can seal any more, and
--     cancel_draw_v1 (allowed once the deadline has passed) records the missing members
--     as MISSED and ends the session; a new session may then exclude them;
--   * before the deadline nothing changes.
-- A re-submission of the same seal after the deadline is refused too: "closed" is closed.
--
-- A NEW migration that redefines the one function; the earlier file is history a deployed
-- database may already have applied. Idempotent (create or replace; grants are kept).

create or replace function public.submit_draw_seal_v1(p_draw_id uuid, p_sealed text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  sess public.draw_sessions;
  previous text;
  stored_at timestamptz;
begin
  if actor is null then
    raise exception using errcode = '28000', message = 'draw_forbidden';
  end if;

  select s.* into sess from public.draw_sessions s where s.draw_id = p_draw_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'draw_not_found';
  end if;
  if not exists (
    select 1 from public.ledger_group_memberships membership
    where membership.group_id = sess.group_id
      and membership.tenant_id = sess.tenant_id
      and membership.user_id = actor
      and membership.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'draw_forbidden';
  end if;

  -- Serialise with the commit and the cancel: a seal either lands before them (and is in
  -- the committed set) or is refused after.
  perform 1 from public.draw_sessions locked where locked.draw_id = p_draw_id for share;

  if p_sealed is null or p_sealed !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'draw_invalid_request';
  end if;
  if exists (select 1 from public.draw_cancellations x where x.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_cancelled';
  end if;
  if exists (select 1 from public.draw_commitments cm where cm.draw_id = p_draw_id) then
    raise exception using errcode = 'P0001', message = 'draw_already_committed';
  end if;
  -- The seal deadline closes sealing. Commit (all sealed) and cancel (somebody missing)
  -- are the two ways out, and both stay open after it.
  if clock_timestamp() >= sess.seal_deadline then
    raise exception using errcode = 'P0001', message = 'draw_seal_deadline_passed';
  end if;
  if not exists (
    select 1 from public.sened_draw_session_eligible(p_draw_id) as e(member_id)
    where e.member_id = actor
  ) then
    raise exception using errcode = 'P0001', message = 'draw_not_eligible';
  end if;

  select se.sealed into previous
  from public.draw_seals se
  where se.draw_id = p_draw_id and se.member_id = actor;

  insert into public.draw_seals (draw_id, member_id, sealed)
  values (p_draw_id, actor, p_sealed)
  on conflict (draw_id, member_id) do update
    set sealed = excluded.sealed, sealed_at = clock_timestamp()
    where public.draw_seals.sealed is distinct from excluded.sealed;

  select se.sealed_at into stored_at
  from public.draw_seals se
  where se.draw_id = p_draw_id and se.member_id = actor;

  return jsonb_build_object(
    'drawId', p_draw_id,
    'memberId', actor,
    'sealed', p_sealed,
    'replaced', previous is not null and previous <> p_sealed,
    'unchanged', previous is not null and previous = p_sealed,
    'sealedAt', stored_at
  );
end;
$$;
