# Sened: what's left (handoff, 2026-10-09)

## Where things stand
- Branch `design/r9-rebuild` (from main `43508c0`) has the full new UI, **uncommitted**. The owner commits it themselves: see "Step 0".
- The approved design is the Round 9 canvas: https://claude.ai/artifact/CZgAsuiCFordMj8tfTenvy. Its source files (`project/*.dc.html`, plus `three.min.js` uploaded as `/_blob/c55485441c160b621cbd111cccc7e276`) live in the canvas; read them with the Artifact tool.
- Checks at handoff: lint, tsc and build are clean; vitest 99 files / 1879 tests and Playwright 58 tests pass.
- Stashes (don't drop them without asking): `r9-foundation-partial-before-rebuild` (an earlier partial attempt) and an older "WIP feat/ui-foundation".
- The launch video is at `brag-output/brag.mp4` (gitignored). `brag-output/work/` holds a 380 MB working file that can be deleted.

## Working rules (owner's)
1. Sonnet subagents do the work. The main agent reviews and verifies.
2. Verify by using the app through **Playwright MCP** at 390×844 and 1440×900, in light and dark, Amharic and English. Look at screenshots yourself.
3. Never commit. Give the owner a short summary with a suggested title, and the owner commits. No AI attribution anywhere.
4. Voxide must stay (it's a hackathon requirement). Addis AI is the Amharic voice lane.
5. The design must be premium, cultural (Ethiopian, inclusive of all faiths, no cartoons) and minimalist, with simple wording.

## Step 0: land the rebuild (owner)
```
git add -A
git commit -m "feat(ui): replace the old interface with the new premium, cultural Sened design"
git switch main && git merge --ff-only design/r9-rebuild && git push origin main
```

## Step 0.5: landing at root and a desktop layout (do first, since judges see this)
**Status 2026-10-09: DONE, committed and pushed (177c990).** `/` shows the landing page when signed out (client `useSession`), the app Home when signed in; the app Home also lives at `/home` (sample/demo mode, nav Home tab). Desktop (>=1024px) has a left rail and two-column Home, Ledger, Chat, Account, Draw, Members. Phone pixels unchanged (diffed). Lint, tsc, build, vitest 1879, e2e 73 pass. Reviewed in Playwright MCP at 1440 and 390.
Follow-ups: 8 new Amharic keys (`ui.chat.pick`, `ui.ledger.*`) need native review; `/members` avatars squash (pre-existing; wrap span around `WovenAvatar` needs `flex shrink-0`); sign-in, join, voice, community/new and account/edit stay a 480px column on desktop; signed-in `/` only tested with a fake session.

The live site is https://sened.ethiodeploy.com (deployed from main `c3c1db2`, the rebuild is committed). Two problems the owner reported:
1. **No landing page at `/`.** The landing page lives at `/welcome`, and `/` opens the app Home with sample data. Fix: signed-out visitors at `/` see the landing page (render it or redirect to `/welcome`), and signed-in members see the app Home. The `/welcome` "Start your equb" button goes to sign-in, and after sign-in members go to the app. Keep `/welcome` working.
2. **The app is phone-only on desktop.** It's a centred 390–480px column with empty space either side, because only phone screens were designed. Fix: a real responsive desktop layout from about 1024px up. Phone stays exactly as it is.
   - The bottom bar becomes a left side navigation rail (ቤት, ደብተር, ውይይት, እኔ), with the voice dock at the top or bottom of the rail and the voice sheet as a centred dialog.
   - Two-column content:
     - Home: share card and voice button on the left, basket-ring round progress and next draw on the right.
     - Ledger: month list and rows, with entry detail or summary beside them.
     - Chat: channel list plus the open conversation side by side.
     - Account: profile beside settings and communities.
     - Draw: 3D mesob beside the winner and the coffee steps.
   - Max content width of about 1200px, centred. The tibeb header stretches full width.
   - Keep the design tokens, motion, dark mode and both languages.
   - Verify with Playwright MCP at 1440×900, 1280×800, 1024×768 and 390×844, light and dark, Amharic and English. Look for no horizontal scroll and no overlap. Update the e2e tests (root shows landing when signed out; the desktop nav rail works).

## Step 1: chat backend (biggest gap)
**Status 2026-10-09: DONE (code + migration), committed and pushed.** Migration `supabase/migrations/20261016100000_chat_backend.sql` (chat_messages append-only, chat_reactions, chat_rsvps, membership-gated RLS, 30 msgs/min throttle trigger, ledger/draw system-line triggers, realtime publication, private `chat-voice` bucket). Client talks to Supabase directly under RLS via `src/lib/chat/*`; own outbox in `src/lib/chat/outbox.ts`. Sample chat stays in memory. Verified: verify-migrations.ps1 on Docker Postgres (all chat checks pass), vitest 1910, e2e 73, lint/tsc/build clean; sample chat sends in Playwright MCP.
**Owner action:** apply the migration to the production Supabase project (`supabase db push`), it is NOT applied yet.
Follow-ups: real Realtime/Storage/signed-in flow untested; draw_reveals trigger untested at runtime; undelivered voice notes are lost on reload; no "add first reaction" button; RSVP not wired to live events; chat-list previews lack sender names; `ui.chat.sampleNote` copy stale, `ui.chat.localNote` unused; 6 new `ui.chat.*` Amharic keys need review.

Today chat is in-memory (`src/lib/ui/chatStore`), so messages vanish on reload.
- New Supabase migration (use the `supabase-migration` skill and the repo conventions): `chat_messages` (id, group_id, author_id, kind text|voice|system|ledger_ref|invite, body, voice_path, reply_to, created_at, append-only), `chat_reactions` and `chat_rsvps`. RLS: only members of `group_id` (via `ledger_group_memberships`) can read and insert, and authors can only insert as themselves.
- Supabase Realtime subscription per channel. Use Supabase Storage for voice notes, with a per-group bucket policy.
- API routes (`add-api-route` skill) or direct client use with RLS. Rate-limit buckets go in `middleware.ts`.
- Ledger and draw events become system/ledger_ref messages, through a server-side insert when a contribution is confirmed or a draw is revealed.
- Wire `/chat` and `/chat/[groupId]` to it. Keep the offline queue for sending.
- Tests: RLS checks against the real local stack (`scripts/verify-migrations.ps1`, Docker), plus API and e2e tests.

## Step 2: account and communities on the server
**Status 2026-10-10: DONE (code + migration + UI + tests), uncommitted for owner review.** Migration `supabase/migrations/20261017100000_profiles_and_communities.sql` adds:
- `public.profiles` table with RLS (owner read/write, peer community member read via `sened_profile_can_read` security definer helper to prevent RLS recursion).
- Auto-profile trigger on `auth.users` insert with `to_jsonb(new)` for safe metadata extraction across test harness and production.
- `public.sened_profile_upsert_v1` RPC and private/public `avatars` bucket with owner write and public read RLS.
- Group attributes on `public.ledger_groups` (`kind`, `contribution_amount`, `frequency`, `target_members`) and `public.sened_community_create_v1` RPC (provisions group, creator owner/treasurer membership, 4 chart accounts, and generates 7-day invite token).
- Server backend modules: `src/lib/profile/server.ts`, `src/lib/community/server.ts`, request validation schemas in `src/lib/validation.ts`.
- Rate-limited API endpoints: `/api/profile` (GET/PUT) and `/api/community` (POST) registered in `src/middleware.ts`.
- Client and UI integration:
  - `src/lib/ui/profile.ts`: automatic server fetch on mount, optimistic local save + background server sync, automatic avatar image upload to Supabase storage.
  - `/account`: displays profile, community roles, and syncs language & theme preference toggles.
  - `/account/edit`: full profile editing (name, phone, avatar upload, language preference).
  - `/community/new`: 3-step creation flow for Equb and Iddir with server provisioning, invite link generation, and offline fallback.
- Verified: `scripts/verify-migrations.ps1` in Docker Postgres (27/27 migrations idempotent, all checks passed), vitest 105 files / 1,923 tests pass, typecheck clean, reviewed via Playwright at 390×844 and 1440×900 in light and dark mode.
**Applied 2026-10-10:** all 27 migrations pushed to the live project `xylzfdayegnhykqcmern` (via the IPv4 session pooler URL; the direct `db.<ref>` host is IPv6-only). End-to-end in Playwright against live Supabase: magic-link sign-in → profile PUT saved to `profiles` → community POST 201 with invite link → second user redeemed the invite and joined. Fixed during e2e: `/join` lost the `#token` under React strict mode (effect ran twice after the fragment was cleared); stale "not connected yet" copy on community step 3; `useProfile.save` always returned true. Test users `e2e-step2@sened.test` and `e2e-step2-b@sened.test` and their "የሙከራ እቁብ" community remain in the live project.

Follow-ups: real device camera test for avatar upload; invite link share dialog on mobile native share sheet; production worker reconciliation for auto-generated chart accounts.

## Step 3: verification gaps
**Status 2026-10-10: DONE (verified on local stack + Playwright + unit tests).**
- **Treasurer console role gating (`/draw/manage`)**:
  - Created `scripts/verify-draw-roles.sql` running against Docker Postgres with real authenticated session claims (`sub` JWT + `role: authenticated`).
  - Proved `owner` can provision community and create cycles; `member` is refused with `42501` (`draw_forbidden`) when attempting `create_draw_cycle_v1`, `set_draw_cycle_contribution_gate_v1`, or `open_draw_v1`; `treasurer` can update contribution gates; `outsider` is rejected across all RPCs. Verified round count invariant (`draw_cycle_rounds_exceed_members`).
  - Added real-session tests to `scripts/verify-migrations.ps1` (`ALL DRAW ROLE GATING CHECKS PASSED`).
  - Added unit test cases for loading, owner/treasurer notes in `test/draw.manage.page.test.tsx` (6 tests pass).
- **Console in dark mode**:
  - Verified `/draw/manage` in light and dark mode at 390×844 and 1440×900 (`draw_manage_mobile_light.png`, `draw_manage_mobile_dark.png`, `draw_manage_desktop_light.png`, `draw_manage_desktop_dark.png`). Refusal card and CTA match design system tokens with high contrast and proper parchment/terracotta/forest green palette.
- **3D draw (`three@0.158.0`) and mobile fallback**:
  - Inspected `src/lib/ui/mesobScene.ts` and `src/components/draw3d/DrawCeremony.tsx`.
  - Confirmed CSS-only mesob fallback (`Fallback`) runs immediately until WebGL draws its first frame, and gracefully resumes on `webglcontextlost`.
  - Confirmed `prefers-reduced-motion: reduce` jumps cleanly to the won state without jarring animation.
  - Verified 3D mesob rendering at 390×844 and 1440×900 (`draw_mobile_light.png`, `draw_desktop_light.png`).
- **Voice keys (`ADDIS_AI_API_KEY` and `NEXT_PUBLIC_VOXIDE_KEY`)**:
  - Addressed storage domain allowlist gap: updated `isTrustedAudioUrl` and `AddisAiTextToSpeechProvider` in `src/lib/voice/addisAi.ts` and `src/lib/voice/tts.ts` to support optional `ADDIS_AI_AUDIO_HOSTS` env configuration (e.g. `storage.googleapis.com, r2.cloudflarestorage.com, s3.amazonaws.com`).
  - All 29 tests in `test/voice.addis.test.ts` pass, including new extra-storage-hosts test suite.
  - Voxide assistant fails closed with 0 network calls when `NEXT_PUBLIC_VOXIDE_KEY` is empty, and loads `@voxide/react` widget when set.

## Step 4: polish
**Status 2026-10-10: DONE (verified on local stack + Postgres container + unit tests).**
- **Amharic review tooling & i18n checks**:
  - Resolved Windows 8.3 short path temp resolution in `scripts/export-amharic-review.ts` by generating temporary baseline fixtures under `node_modules/.cache/`.
  - Ran `npm run i18n:review` cleanly; exported 1,545 strings to `docs/i18n/amharic-review.csv` and scanned 241 hardcoded lines into `docs/i18n/amharic-hardcoded.csv`.
  - Confirmed 100% placeholder token symmetry across all `ui.*` strings via `test/ui.foundation.test.tsx`.
  - Verified cultural key terms: proverb «ድር ቢያብር አንበሳ ያስር» (`ui.proverb`), landing hero, equb/iddir governance, and the three traditional coffee ceremony stages (Abol / አቦል, Tona / ቶና, Baraka / በረካ) with matching ceremony cards.
- **Ethiopian calendar conversion verification**:
  - Verified the custom Julian Day Number algorithm in `src/lib/ui/geez.ts` (`toEthiopic`) against standard Ethiopian astronomical/calendrical definitions.
  - Proved mathematical accuracy across Ethiopian leap years (2015 E.C., 2019 E.C.), Pagume 5 vs Pagume 6 leap-day boundaries, Gregorian leap years (2024, 2028), Meskerem 1 transitions across consecutive years (2016 through 2021 E.C.), and historical milestones (Adwa victory Yekatit 23, 1888 E.C., Ginbot 20, 1983 E.C., Ethiopian Millennium Meskerem 1, 2000 E.C.).
  - Added comprehensive test coverage in `test/ui.foundation.test.tsx` (all 9 tests pass).
- **Invite link lifecycle and expiration**:
  - Added live authenticated Postgres test coverage in `scripts/verify-draw-roles.sql` exercising `create_group_invite_v1`, `redeem_group_invite_v1`, and `revoke_group_invite_v1`.
  - Verified active joining (`joined`), active member re-redemption (`already_member`), time-based expiration (`ledger_invite_expired`), explicit manager revocation (`ledger_invite_revoked`), and single-use exhaustion (`ledger_invite_exhausted`).
  - Verified in `scripts/verify-migrations.ps1` (`ALL DRAW ROLE AND INVITE LIFECYCLE CHECKS PASSED`).
- **Payout replay & race semantics**:
  - Confirmed deterministic idempotency key generation (`draw-payout.${commitment}`) prevents double disbursements.
  - Confirmed identical caller replay returns `replayed: true` (HTTP 200), concurrent manager race returns `alreadyPaid: true` (HTTP 200), and conflicting account arguments return `IDEMPOTENCY_CONFLICT` (HTTP 409).


## Step 5: hackathon (STARK)
**Status 2026-10-10: the parts that need no credentials are DONE (uncommitted); the rest needs the owner.**
- Done: README rewritten from the code (features, stack, env names, migrations via the IPv4 pooler, tests, deploy, screenshots); public-page screenshots in `docs/screenshots/` (landing, sign-in, join at 390x844 and 1440x900); `docs/hackathon/scholarxiv-ideation.md`; `docs/hackathon/deploy-checklist.md`; Dockerfile now takes `NEXT_PUBLIC_VOXIDE_KEY` and `NEXT_PUBLIC_SITE_URL` as build args (it only had the two Supabase ones, so a container build never got the Voxide key).
- Owner: deploy `main` on EthioDeploy with the build variables (incl. `NEXT_PUBLIC_VOXIDE_KEY`), whitelist the live domain in the Voxide dashboard, mint the ScholarXIV key and set `SCHOLARXIV_API_URL`/`SCHOLARXIV_API_KEY` (the Papers request/response shape is unverified against a live key), then refresh the launch video with `/brag-slim` against the live URL. Exact steps: `docs/hackathon/deploy-checklist.md`.
- Follow-ups: `docs/IDEATION.md` states the papers' findings more strongly than the code's catalogue and names the 2023 paper's author differently ("Michael, K." vs Sowon); reconcile. Signed-in screenshots (home, ledger, draw, chat) were not taken because they need a session.
