-- Free-plan hardening.
--   1. Cap avatar uploads (client already sends <= 256px WebP, a few KB).
--   2. A no-op RPC the keep-alive workflow calls so the project is never idle-paused.
-- Idempotent: safe to re-run.

update storage.buckets
set file_size_limit = 524288,
    allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png']
where id = 'avatars';

create or replace function public.sened_keepalive()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$ select 1 $$;

revoke all on function public.sened_keepalive() from public;
grant execute on function public.sened_keepalive() to anon, authenticated;
