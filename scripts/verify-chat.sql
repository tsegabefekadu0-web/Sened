-- Verification of the chat backend (supabase/migrations/20261016100000_chat_backend.sql).
-- Run by scripts/verify-migrations.ps1 after every migration has been applied
-- twice. Every check raises on failure. Success prints: ALL CHAT BACKEND CHECKS PASSED

begin;
do $chat$
declare
  v_group constant uuid := 'cccccccc-0000-4000-8000-000000000001';
  v_other constant uuid := 'cccccccc-0000-4000-8000-000000000002';
  v_tenant constant uuid := 'cccccccc-1111-4000-8000-000000000001';
  v_member constant uuid := 'cccccccc-1111-4000-8000-000000000002';
  v_inactive constant uuid := 'cccccccc-1111-4000-8000-000000000003';
  v_outsider constant uuid := 'cccccccc-1111-4000-8000-000000000004';
  v_msg uuid;
  v_count integer;
  v_failed boolean;
begin
  insert into auth.users (id, email) values
    (v_tenant, 'chat-tenant@example.test'), (v_member, 'chat-member@example.test'),
    (v_inactive, 'chat-inactive@example.test'), (v_outsider, 'chat-outsider@example.test')
  on conflict (id) do nothing;
  insert into public.ledger_groups (id, tenant_id, name, created_by) values
    (v_group, v_tenant, 'Chat Equb', v_tenant), (v_other, v_tenant, 'Other Equb', v_tenant);
  insert into public.ledger_group_memberships (group_id, tenant_id, user_id, role, status) values
    (v_group, v_tenant, v_member, 'member', 'active'),
    (v_group, v_tenant, v_inactive, 'member', 'inactive');

  -- CHAT 1: a member posts text as themselves and reads it back; an outsider and
  -- an inactive member see nothing.
  perform set_config('request.jwt.claim.sub', v_member::text, true);
  set local role authenticated;
  insert into public.chat_messages (group_id, kind, body) values (v_group, 'text', 'selam')
    returning id into v_msg;
  select count(*) into v_count from public.chat_messages where group_id = v_group;
  if v_count <> 1 then raise exception 'CHAT 1 FAILED: member cannot read own group chat (%)', v_count; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  set local role authenticated;
  select count(*) into v_count from public.chat_messages;
  if v_count <> 0 then raise exception 'CHAT 1 FAILED: an outsider can read chat (%)', v_count; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', v_inactive::text, true);
  set local role authenticated;
  select count(*) into v_count from public.chat_messages;
  if v_count <> 0 then raise exception 'CHAT 1 FAILED: an inactive member can read chat'; end if;
  reset role;

  -- CHAT 2: an outsider cannot post; a member cannot post as someone else, in
  -- another group, or as a system / ledger_ref line.
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  set local role authenticated;
  v_failed := false;
  begin
    insert into public.chat_messages (group_id, kind, body) values (v_group, 'text', 'x');
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 2 FAILED: an outsider posted'; end if;
  reset role;

  perform set_config('request.jwt.claim.sub', v_member::text, true);
  set local role authenticated;
  v_failed := false;
  begin
    insert into public.chat_messages (group_id, author_id, kind, body) values (v_group, v_tenant, 'text', 'spoof');
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 2 FAILED: a member posted as someone else'; end if;
  v_failed := false;
  begin
    insert into public.chat_messages (group_id, kind, body) values (v_other, 'text', 'wrong group');
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 2 FAILED: a member posted in a group they are not in'; end if;
  v_failed := false;
  begin
    insert into public.chat_messages (group_id, author_id, kind, body) values (v_group, null, 'system', 'fake');
  exception when insufficient_privilege or check_violation then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 2 FAILED: a client wrote a system line'; end if;
  v_failed := false;
  begin
    insert into public.chat_messages (group_id, author_id, kind, meta) values (v_group, null, 'ledger_ref', '{}');
  exception when insufficient_privilege or check_violation then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 2 FAILED: a client wrote a ledger_ref line'; end if;

  -- CHAT 3: append-only. No update, no delete, even for the author.
  v_failed := false;
  begin
    update public.chat_messages set body = 'edited' where id = v_msg;
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 3 FAILED: a message was edited'; end if;
  v_failed := false;
  begin
    delete from public.chat_messages where id = v_msg;
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 3 FAILED: a message was deleted'; end if;
  reset role;
  v_failed := false;
  begin
    update public.chat_messages set body = 'edited' where id = v_msg;
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 3 FAILED: even the owner role could edit a message'; end if;

  -- CHAT 4: a voice note must point into its own group's folder; replies stay in the group.
  perform set_config('request.jwt.claim.sub', v_member::text, true);
  set local role authenticated;
  v_failed := false;
  begin
    insert into public.chat_messages (group_id, kind, voice_path, voice_seconds)
      values (v_group, 'voice', v_other::text || '/a.webm', 3);
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 4 FAILED: a voice path escaped its group'; end if;
  insert into public.chat_messages (group_id, kind, voice_path, voice_seconds, reply_to)
    values (v_group, 'voice', v_group::text || '/a.webm', 3, v_msg);
  reset role;

  -- CHAT 5: reactions and RSVPs are own-row only and member-only.
  perform set_config('request.jwt.claim.sub', v_member::text, true);
  set local role authenticated;
  insert into public.chat_reactions (message_id, group_id, reaction) values (v_msg, v_group, 'ack');
  insert into public.chat_rsvps (message_id, group_id, response) values (v_msg, v_group, 'yes');
  update public.chat_rsvps set response = 'no' where message_id = v_msg;
  v_failed := false;
  begin
    insert into public.chat_reactions (message_id, group_id, user_id, reaction) values (v_msg, v_group, v_tenant, 'smile');
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 5 FAILED: reacted as someone else'; end if;
  delete from public.chat_reactions where message_id = v_msg;
  select count(*) into v_count from public.chat_reactions;
  if v_count <> 0 then raise exception 'CHAT 5 FAILED: own reaction not removable'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', v_outsider::text, true);
  set local role authenticated;
  v_failed := false;
  begin
    insert into public.chat_reactions (message_id, group_id, reaction) values (v_msg, v_group, 'ack');
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'CHAT 5 FAILED: an outsider reacted'; end if;
  select count(*) into v_count from public.chat_rsvps;
  if v_count <> 0 then raise exception 'CHAT 5 FAILED: an outsider can read RSVPs'; end if;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  -- CHAT 6: privileges.
  if has_table_privilege('anon', 'public.chat_messages', 'SELECT')
     or has_table_privilege('anon', 'public.chat_messages', 'INSERT')
     or has_table_privilege('authenticated', 'public.chat_messages', 'UPDATE')
     or has_table_privilege('authenticated', 'public.chat_messages', 'DELETE') then
    raise exception 'CHAT 6 FAILED: a chat_messages privilege is wrong';
  end if;

  -- CHAT 7: a contribution entry makes the trigger write a ledger_ref line
  -- (the entry row is inserted directly; hashes are shape-valid placeholders).
  insert into public.ledger_entries (
    group_id, tenant_id, sequence, occurred_at, entry_type, actor_id, nonce,
    previous_hash, entry_hash, request_fingerprint, idempotency_key
  ) values (
    v_group, v_tenant, 1, now(), 'contribution', v_tenant, gen_random_uuid(),
    repeat('0', 64), repeat('a', 64), repeat('b', 64), 'chat-probe-1'
  );
  select count(*) into v_count from public.chat_messages
    where group_id = v_group and kind = 'ledger_ref' and author_id is null
      and meta ->> 'event' = 'contribution';
  if v_count <> 1 then raise exception 'CHAT 7 FAILED: contribution wrote % ledger_ref lines', v_count; end if;
  insert into public.ledger_entries (
    group_id, tenant_id, sequence, occurred_at, entry_type, actor_id, nonce,
    previous_hash, entry_hash, request_fingerprint, idempotency_key
  ) values (
    v_group, v_tenant, 2, now(), 'journal', v_tenant, gen_random_uuid(),
    repeat('a', 64), repeat('c', 64), repeat('d', 64), 'chat-probe-2'
  );
  select count(*) into v_count from public.chat_messages where group_id = v_group and kind = 'ledger_ref';
  if v_count <> 1 then raise exception 'CHAT 7 FAILED: a journal entry announced itself'; end if;

  -- CHAT 8: the storage bucket is private and capped (only where Storage exists).
  if to_regclass('storage.buckets') is not null then
    if not exists (select 1 from storage.buckets where id = 'chat-voice' and public = false and file_size_limit > 0) then
      raise exception 'CHAT 8 FAILED: chat-voice bucket missing or public';
    end if;
    if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and policyname like 'chat voice%') <> 2 then
      raise exception 'CHAT 8 FAILED: voice storage policies missing';
    end if;
  end if;

  -- CHAT 9: Realtime carries the chat tables.
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if (select count(*) from pg_publication_tables where pubname = 'supabase_realtime'
          and schemaname = 'public' and tablename in ('chat_messages', 'chat_reactions', 'chat_rsvps')) <> 3 then
      raise exception 'CHAT 9 FAILED: chat tables are not in the realtime publication';
    end if;
  end if;
end;
$chat$;
rollback;
select 'ALL CHAT BACKEND CHECKS PASSED' as result;
