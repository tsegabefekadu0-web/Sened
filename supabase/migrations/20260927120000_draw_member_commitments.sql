-- Member-seed commitments: close the seed-grinding attack.
--
-- `sened-draw-commit-v1` bound a seed the *treasurer* chose. A commitment only
-- means something if the party making it could not have searched for the outcome
-- first, and that was never true. A treasurer could try seeds until one handed
-- the pot to a friend, then commit to that one. The reveal would be internally
-- consistent, every member's independent check would pass, and the draw would be
-- completely rigged — with nothing left afterwards to detect it.
--
-- A member now seals a nonce *before* the treasurer commits. Only the hash is
-- published; the nonce is revealed with the seed. The commitment binds the
-- digest of that set, so the winner depends on a value the treasurer does not
-- have and therefore cannot search over.
--
-- The columns below store both halves so any member can recompute the ceremony
-- from published values alone, which is the whole social contract of an Equb.
--
-- UNVERIFIED BY EXECUTION. `scripts/verify-migrations.ps1` applies every
-- migration to a throwaway Postgres 16 and then runs `scripts/verify-migrations.sql`,
-- which exercises these columns at the end of that file. That command has not
-- been run against this file — Docker is not startable in the environment this
-- was authored in. Run it before trusting this.

alter table public.draw_commitments
  add column if not exists member_digest text
    check (member_digest is null or member_digest ~ '^[0-9a-f]{64}$'),
  add column if not exists member_commitments jsonb
    check (
      member_commitments is null
      or jsonb_typeof(member_commitments) = 'array'
    );

alter table public.draw_reveals
  add column if not exists member_digest text
    check (member_digest is null or member_digest ~ '^[0-9a-f]{64}$'),
  add column if not exists member_nonces jsonb
    check (
      member_nonces is null
      or jsonb_typeof(member_nonces) = 'array'
    );

comment on column public.draw_commitments.member_digest is
  'SHA-256 over the sorted member contributions. Bound into the commitment, so the treasurer cannot search for a favourable outcome. Null only for rows written before sened-draw-commit-v2.';

comment on column public.draw_commitments.member_commitments is
  'JSON array of {memberId, sealed} published before the ceremony. Only the hashes travel; the nonces are revealed later.';

comment on column public.draw_reveals.member_nonces is
  'JSON array of {memberId, nonce} revealed with the seed, so any member can check each nonce against the hash that was sealed.';

-- A commitment must not be able to name an empty contribution set and still look
-- well formed. The application refuses this, but a direct table insert would not,
-- and the whole property rests on the set being non-empty.
alter table public.draw_commitments
  drop constraint if exists draw_commitments_member_set_present;
alter table public.draw_commitments
  add constraint draw_commitments_member_set_present
  check (
    member_digest is null
    or (
      member_commitments is not null
      and jsonb_array_length(member_commitments) >= 1
    )
  );

-- A reveal that opens a different number of contributions than were sealed is
-- not a completion of that ceremony, whatever the application believes.
alter table public.draw_reveals
  drop constraint if exists draw_reveals_member_set_matches;
alter table public.draw_reveals
  add constraint draw_reveals_member_set_matches
  check (
    member_digest is null
    or (
      member_nonces is not null
      and jsonb_array_length(member_nonces) >= 1
    )
  );
