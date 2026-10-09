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
- Profile (name, phone, photo): a `profiles` table plus a Storage avatar, with RLS for own row only. Wire `/account` and `/account/edit`, which save locally today.
- Create community: a server route that creates the group, makes the creator owner/treasurer and returns invite links. Today it only saves a draft in localStorage; reuse the existing invite system.
- The language and theme preference could sync to the profile.

## Step 3: verification gaps
- Test the treasurer console (`/draw/manage`) role gating with a **real signed-in session** on the local Supabase stack (owner, treasurer, member). So far it's tested only with mocks.
- Check the console in dark mode.
- Do a real-device check of the 3D draw (`three@0.158.0`) on an Android phone, and its fallback.
- Live-test the voice keys: `ADDIS_AI_API_KEY` (Amharic STT/TTS; the audio host allowlist may need Addis AI's storage domain) and `NEXT_PUBLIC_VOXIDE_KEY` (English assistant; whitelist the live domain in the Voxide dashboard).

## Step 4: polish
- Have a native speaker review the Amharic: `ui.*` keys in `src/lib/i18n.ts`, especially `ui.landing.*`, `ui.create.*`, `ui.chat.*`, `ui.voice.*`, the FAQ, the proverb «ድር ቢያብር አንበሳ ያስር» and the coffee-round step names. Tools: `scripts/export-amharic-review.ts` and `scripts/import-amharic-review.ts`.
- Check the Ethiopian calendar conversion (custom implementation) against a reference library.
- Small items from earlier sessions:
  - A replayed draw payout has no ledger sequence.
  - A payout race loser gets 409.
  - Invite expiry is untested live.
  - No in-app bank account binding.
  - No production worker for reconciliation.

## Step 5: hackathon (STARK)
- Deploy (EthioDeploy counts in your favour) and whitelist the domain in Voxide.
- ScholarXIV: document the ideation (`src/lib/governance/scholarxiv.ts` exists). Using their MCP or Papers API earns extra points.
- Update the README and screenshots, and refresh the launch video from the live app with the brag skill if time allows.
