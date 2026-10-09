-- Community chat backend: messages, reactions, RSVPs, voice-note storage,
-- Realtime, and server-written system lines for the ledger and the draw.
--
-- HOW TO RUN: `supabase db push` (or scripts/verify-migrations.ps1 against a
-- throwaway Postgres). Safe to re-run: every statement is idempotent.
--
-- Trust model
--   * Only active members of a group (or its tenant owner) can read or write
--     that group's chat. Membership is read through ledger_group_memberships.
--   * A member can only insert kinds text / voice / invite, and only as
--     themselves. kinds system / ledger_ref are written by the triggers below
--     (security definer) or by the service role; no client policy allows them.
--   * chat_messages is append-only: no UPDATE or DELETE policy, the privileges
--     are revoked, and a trigger refuses both for every role.
--   * Voice notes live in the private `chat-voice` bucket under
--     `<group_id>/<file>`; the first path segment is the group the caller must
--     belong to.

-- ---------------------------------------------------------------------------
-- Membership helper (security definer so RLS on the membership table is not
-- re-entered from a chat policy).
-- ---------------------------------------------------------------------------
create or replace function public.sened_chat_is_member(requested_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.ledger_groups group_row
      where group_row.id = requested_group_id
        and (
          group_row.tenant_id = auth.uid()
          or exists (
            select 1
            from public.ledger_group_memberships membership
            where membership.group_id = group_row.id
              and membership.user_id = auth.uid()
              and membership.status = 'active'
          )
        )
    );
$$;

revoke all on function public.sened_chat_is_member(uuid) from public, anon;
grant execute on function public.sened_chat_is_member(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.ledger_groups (id) on delete restrict,
  -- Null for system / ledger_ref lines, which no person wrote.
  author_id uuid default auth.uid() references auth.users (id) on delete restrict,
  kind text not null check (kind in ('text', 'voice', 'system', 'ledger_ref', 'invite')),
  body text check (body is null or char_length(body) between 1 and 2000),
  voice_path text check (voice_path is null or char_length(voice_path) between 1 and 300),
  voice_seconds integer check (voice_seconds is null or voice_seconds between 1 and 600),
  reply_to uuid,
  -- Structured detail for system lines, e.g. {"event":"contribution","entry_id":"..."}.
  meta jsonb check (meta is null or jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  constraint chat_messages_id_group_key unique (id, group_id),
  constraint chat_messages_reply_fk
    foreign key (reply_to, group_id)
    references public.chat_messages (id, group_id)
    on delete restrict,
  constraint chat_messages_shape_check check (
    (kind = 'text' and author_id is not null and body is not null and voice_path is null)
    or (kind = 'voice' and author_id is not null and voice_path is not null and voice_seconds is not null)
    or (kind = 'invite' and author_id is not null and body is not null and voice_path is null)
    or (kind in ('system', 'ledger_ref') and author_id is null and voice_path is null)
  ),
  -- A voice note can only point inside its own group's folder.
  constraint chat_messages_voice_prefix_check check (
    voice_path is null or voice_path like group_id::text || '/%'
  )
);

create index if not exists chat_messages_group_created_idx
  on public.chat_messages (group_id, created_at desc, id desc);
create index if not exists chat_messages_author_created_idx
  on public.chat_messages (author_id, created_at desc);
create index if not exists chat_messages_reply_idx
  on public.chat_messages (reply_to) where reply_to is not null;

alter table public.chat_messages enable row level security;

drop policy if exists "members read group chat" on public.chat_messages;
create policy "members read group chat"
  on public.chat_messages
  for select
  to authenticated
  using (public.sened_chat_is_member(group_id));

drop policy if exists "members write their own chat" on public.chat_messages;
create policy "members write their own chat"
  on public.chat_messages
  for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and kind in ('text', 'voice', 'invite')
    and public.sened_chat_is_member(group_id)
  );

-- No update or delete policy exists, and the privileges are not granted either.
revoke all on table public.chat_messages from public, anon, authenticated;
grant select, insert on table public.chat_messages to authenticated;
grant select, insert on table public.chat_messages to service_role;

create or replace function public.sened_chat_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'chat_messages is append-only' using errcode = '55000';
end;
$$;

drop trigger if exists chat_messages_block_mutation on public.chat_messages;
create trigger chat_messages_block_mutation
  before update or delete on public.chat_messages
  for each row execute function public.sened_chat_block_mutation();

-- A person cannot flood a room: at most 30 messages a minute each. Triggers and
-- the service role write with a null author and are not counted.
create or replace function public.sened_chat_throttle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.author_id is not null and (
    select count(*) from public.chat_messages m
    where m.author_id = new.author_id
      and m.created_at > clock_timestamp() - interval '1 minute'
  ) >= 30 then
    raise exception 'chat_rate_limited' using errcode = '54000';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_messages_throttle on public.chat_messages;
create trigger chat_messages_throttle
  before insert on public.chat_messages
  for each row execute function public.sened_chat_throttle();

-- ---------------------------------------------------------------------------
-- chat_reactions (a member may add and remove their own)
-- ---------------------------------------------------------------------------
create table if not exists public.chat_reactions (
  message_id uuid not null,
  group_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reaction text not null check (reaction in ('ack', 'smile')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (message_id, user_id, reaction),
  constraint chat_reactions_message_fk
    foreign key (message_id, group_id)
    references public.chat_messages (id, group_id)
    on delete cascade
);

create index if not exists chat_reactions_group_idx on public.chat_reactions (group_id, message_id);

alter table public.chat_reactions enable row level security;

drop policy if exists "members read reactions" on public.chat_reactions;
create policy "members read reactions"
  on public.chat_reactions for select to authenticated
  using (public.sened_chat_is_member(group_id));

drop policy if exists "members react as themselves" on public.chat_reactions;
create policy "members react as themselves"
  on public.chat_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.sened_chat_is_member(group_id));

drop policy if exists "members remove their reactions" on public.chat_reactions;
create policy "members remove their reactions"
  on public.chat_reactions for delete to authenticated
  using (user_id = auth.uid() and public.sened_chat_is_member(group_id));

revoke all on table public.chat_reactions from public, anon, authenticated;
grant select, insert, delete on table public.chat_reactions to authenticated;
grant select, insert, delete on table public.chat_reactions to service_role;

-- ---------------------------------------------------------------------------
-- chat_rsvps (one answer per member per message; they may change it)
-- ---------------------------------------------------------------------------
create table if not exists public.chat_rsvps (
  message_id uuid not null,
  group_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  response text not null check (response in ('yes', 'no')),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (message_id, user_id),
  constraint chat_rsvps_message_fk
    foreign key (message_id, group_id)
    references public.chat_messages (id, group_id)
    on delete cascade
);

create index if not exists chat_rsvps_group_idx on public.chat_rsvps (group_id, message_id);

alter table public.chat_rsvps enable row level security;

drop policy if exists "members read rsvps" on public.chat_rsvps;
create policy "members read rsvps"
  on public.chat_rsvps for select to authenticated
  using (public.sened_chat_is_member(group_id));

drop policy if exists "members answer as themselves" on public.chat_rsvps;
create policy "members answer as themselves"
  on public.chat_rsvps for insert to authenticated
  with check (user_id = auth.uid() and public.sened_chat_is_member(group_id));

drop policy if exists "members change their answer" on public.chat_rsvps;
create policy "members change their answer"
  on public.chat_rsvps for update to authenticated
  using (user_id = auth.uid() and public.sened_chat_is_member(group_id))
  with check (user_id = auth.uid() and public.sened_chat_is_member(group_id));

revoke all on table public.chat_rsvps from public, anon, authenticated;
grant select, insert, update on table public.chat_rsvps to authenticated;
grant select, insert, update on table public.chat_rsvps to service_role;

-- ---------------------------------------------------------------------------
-- System lines from the ledger and the draw. These run inside the transaction
-- that posts the entry or reveals the draw, and swallow their own failure so a
-- chat problem can never undo a money movement.
-- ---------------------------------------------------------------------------
create or replace function public.sened_chat_on_contribution()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.entry_type = 'contribution' then
    begin
      insert into public.chat_messages (group_id, author_id, kind, meta)
      values (
        new.group_id, null, 'ledger_ref',
        jsonb_build_object('event', 'contribution', 'entry_id', new.id, 'sequence', new.sequence::text)
      );
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_entries_chat_contribution on public.ledger_entries;
create trigger ledger_entries_chat_contribution
  after insert on public.ledger_entries
  for each row execute function public.sened_chat_on_contribution();

create or replace function public.sened_chat_on_draw_reveal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  commitment_row record;
begin
  begin
    select c.group_id, c.cycle_id, c.round
      into commitment_row
      from public.draw_commitments c
      where c.draw_id = new.draw_id
      limit 1;
    if found then
      insert into public.chat_messages (group_id, author_id, kind, meta)
      values (
        commitment_row.group_id, null, 'system',
        jsonb_build_object(
          'event', 'draw',
          'draw_id', new.draw_id,
          'round', commitment_row.round,
          'winner_member_id', new.winner_member_id,
          'payout_amount', new.payout_amount::text
        )
      );
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

drop trigger if exists draw_reveals_chat_announce on public.draw_reveals;
create trigger draw_reveals_chat_announce
  after insert on public.draw_reveals
  for each row execute function public.sened_chat_on_draw_reveal();

-- ---------------------------------------------------------------------------
-- Realtime: stream new messages, reactions and answers (RLS still filters who
-- receives what). Skipped where the publication does not exist (plain Postgres).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['chat_messages', 'chat_reactions', 'chat_rsvps'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Voice-note storage: private bucket, one folder per group.
-- Skipped where Supabase Storage is not installed (plain Postgres).
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('chat-voice', 'chat-voice', false, 5242880,
            array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    drop policy if exists "chat voice read by members" on storage.objects;
    create policy "chat voice read by members"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'chat-voice'
        and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and public.sened_chat_is_member(((storage.foldername(name))[1])::uuid)
      );

    drop policy if exists "chat voice upload by members" on storage.objects;
    create policy "chat voice upload by members"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'chat-voice'
        and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and public.sened_chat_is_member(((storage.foldername(name))[1])::uuid)
      );
  end if;
end;
$$;
