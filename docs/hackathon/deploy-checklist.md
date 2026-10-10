# Hackathon deploy checklist (owner steps)

These steps need your accounts and keys. Never paste a secret into git, a screenshot or a chat.

## 1. Before you deploy

- [ ] On `main`, run `npm run typecheck`, `npm test` and `npm run build`; all must pass.
- [ ] Apply any pending migrations to the Supabase project (see README, "Database migrations"). Use the IPv4 session pooler URL with `supabase db push --db-url ...`; the direct `db.<ref>.supabase.co` host is IPv6-only. Newest files: `20261016100000_chat_backend.sql`, `20261017100000_profiles_and_communities.sql` (and any added since). Deploy the app and migrations together; several migrations change function signatures.
- [ ] Have these ready: Supabase project URL and anon key; Voxide publishable key (`vox_pub_...`); optionally Addis AI, Links.et and ScholarXIV keys.

## 2. Deploy on EthioDeploy

1. Push `main` to GitHub (the live site, https://sened.ethiodeploy.com, was deployed from `main`).
2. In the EthioDeploy console open the Sened service and trigger a new deploy of `main`, or create a service from the repository's `Dockerfile` (container port 3000).
3. Set the **build** variables (they are inlined into the browser bundle, so changing one needs a rebuild):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_VOXIDE_KEY`
   - `NEXT_PUBLIC_SITE_URL` (the live origin, for link previews)
4. Set the **runtime** secrets (server only, never as build args): `BANK_REFERENCE_ENCRYPTION_KEY`, `BANK_REFERENCE_HMAC_KEY` (each `openssl rand -base64 32`), `BANK_REFERENCE_KEY_VERSION`, `LINKS_ET_API_KEY`, `ADDIS_AI_API_KEY`, `SCHOLARXIV_API_URL` (normally `https://www.scholarxiv.com/api/v1`), `SCHOLARXIV_API_KEY`, and, only if you schedule the reconciliation drain, `RECONCILIATION_CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`. Anything left unset just disables that provider.
5. Health check: HTTP GET `/` expecting 200, over HTTPS.
6. In Supabase (Authentication, URL Configuration) add the live URL to the Site URL and allowed redirect URLs.

## 3. Whitelist the domain in Voxide

1. Open the Voxide dashboard and the project that owns the publishable key.
2. Add the live domain (`sened.ethiodeploy.com`) to the allowed domains. `localhost` always works, the live site does not until you do this.
3. Confirm the key in the dashboard matches the `NEXT_PUBLIC_VOXIDE_KEY` you set, then redeploy if you changed it.
4. Open the live site, and confirm the assistant button appears and starts a session (the browser console shows no domain-rejected error).

## 4. Smoke test (full list: `docs/DEPLOYMENT.md`, section 6)

- [ ] `/` shows the landing page signed out; `/manifest.json` and `/sw.js` return 200.
- [ ] Sign in, create a community, copy an invite link and open it in a private window: `/join` redeems it.
- [ ] `/chat`: send a message from two accounts; it appears live in the other.
- [ ] `/draw`: commit, reveal and verify a round.
- [ ] `GET /api/voice/capabilities` reports `sttConfigured`/`ttsConfigured` true only if the Addis AI key is set.
- [ ] `/governance`: with the ScholarXIV key set, chips read "confirmed"; if they read "not found" or an error, see `docs/hackathon/scholarxiv-ideation.md`.

## 5. Refresh the launch video (brag skill)

The existing video is in `brag-output/` (`brag.mp4`, `brag-poster.png`, `share-copy.txt`).

1. After the deploy is live and the smoke test passes, open Claude Code in `c:\Sened`.
2. Run `/brag-slim` (or say "let's /brag about this") and give it the live URL https://sened.ethiodeploy.com so it captures the current landing page and app instead of the old build.
3. Review the new `brag-output/brag.mp4` and `share-copy.txt`, then keep the one you like. Re-record if the old cut shows pre-landing-page screens.
4. Add the video link to the hackathon submission and, if you want, to the README.

## 6. Submission

- [ ] README screenshots render (`docs/screenshots/`); retake them after UI changes with the same sizes (390x844, 1440x900).
- [ ] ScholarXIV collection link and `docs/hackathon/scholarxiv-ideation.md` are in the submission.
- [ ] Mention Voxide (voice assistant), Addis AI (Amharic), Links.et (verification) and EthioDeploy (hosting) in the write-up.
