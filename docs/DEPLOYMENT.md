# Deploying Sened

Sened is a Next.js 14 app (`output: "standalone"`) that ships as one container
image. It needs a Supabase project for auth and data; everything else
(bank verification, voice, ScholarXIV) is optional and inert until configured.

## 1. Prerequisites

### Supabase project

1. Create a Supabase project. Note the project URL and the **anon** key
   (Settings > API). The anon key is public by design; every `/api` route
   re-verifies the caller's JWT. Never put the service-role key in this app.
2. Enable email/password or whichever sign-in the app's `/sign-in` page uses in
   Authentication settings, and add your deployed origin to the allowed
   redirect URLs.
3. Apply every file in `supabase/migrations/` **in filename (timestamp) order**
   (`supabase db push` with the Supabase CLI, or paste each file into the SQL
   editor in order). Current files, oldest first:
   `20260924214531_ledger_core.sql`, `20260925120000_bank_verification_reconciliation.sql`,
   `20260926100000_draw_commit_reveal.sql`, `20260926110000_draw_reveal_binding.sql`,
   `20260927100000_ledger_group_provisioning.sql`, `20260927120000_draw_member_commitments.sql`,
   `20260927130000_draw_member_rpcs.sql`, `20260927140000_client_read_paths.sql`,
   `20260928100000_draw_round_response_shape.sql`, `20260929100000_ledger_member_roles.sql`,
   `20260930100000_ledger_group_invites.sql`. Later files depend on earlier ones.

### Migration harness (run before applying to a real project)

`scripts/verify-migrations.ps1` starts a throwaway Postgres container, applies
`scripts/supabase-auth-stub.sql` (a minimal stand-in for Supabase's `auth`
schema), then every migration in order, then `scripts/verify-migrations.sql`,
which executes the draw/ledger SQL and raises on any failure. Success prints
`ALL DRAW BINDING CHECKS PASSED`.

```
powershell -ExecutionPolicy Bypass -File scripts\verify-migrations.ps1
```

It needs Docker and Windows PowerShell 5.1+. On Linux/macOS, run the same
sequence by hand against a scratch Postgres: stub, migrations in order, then
`verify-migrations.sql` with `psql -v ON_ERROR_STOP=1`. Do this against a
scratch database, never your Supabase project (the harness inserts fixture
users).

### Tooling

Node 22 (matches the image), Docker for the container build.

## 2. Environment variables

The full, commented list is [`.env.example`](../.env.example). Summary:

| Variable | Kind | Required | Read in | If unset |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public, **build time** (also read server-side) | yes | `src/lib/supabaseServer.ts`, `src/lib/auth/browserClient.ts` | `/api/*` returns 503 `not_configured`; browser is signed out |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public, **build time** (also read server-side) | yes | same | same |
| `BANK_REFERENCE_ENCRYPTION_KEY` | server secret | for bank verification | `src/lib/banking/vault.ts` | bank-verification routes fail closed |
| `BANK_REFERENCE_HMAC_KEY` | server secret | for bank verification | `vault.ts`, `service.ts`, `linkset.ts` | same |
| `BANK_REFERENCE_KEY_VERSION` | server | optional (default `v1`) | `vault.ts` | `v1` |
| `LINKS_ET_API_KEY` | server secret (`vk_...`) | for bank verification | `src/lib/banking/linkset.ts` | adapter unconfigured; every verification fails closed |
| `LINKS_ET_BASE_URL` | server | optional (default `https://links.et`) | `linkset.ts` | default |
| `LINKS_ET_WAIT_MS` | server | optional (default 800, max 30000) | `linkset.ts` | default |
| `LINKS_ET_TIMEOUT_MS` | server | optional (default 5000) | `linkset.ts` | default |
| `LINKS_ET_ETB_OFFSET_MINUTES` | server | optional (default 180) | `linkset.ts` | default |
| `LINKS_ET_TIMESTAMP_TOLERANCE_SECONDS` | server | optional (default 900) | `linkset.ts` | default |
| `SCHOLARXIV_API_URL` | server | optional | `src/lib/governance/scholarxiv.ts` | bundled citations only |
| `SCHOLARXIV_API_KEY` | server secret (`sxv_...`) | optional | same | same |
| `SCHOLARXIV_TIMEOUT_MS` | server | optional (default 8000) | same | default |
| `VOXIDE_API_URL` | server | optional | `src/lib/voice/stt.ts`, `tts.ts` | server STT/TTS unconfigured |
| `VOXIDE_API_KEY` | server secret | optional | same | same |
| `VOXIDE_TTS_API_URL` | server | optional | `src/lib/voice/tts.ts` | falls back to `VOXIDE_API_URL` |
| `VOXIDE_TTS_API_KEY` | server secret | optional | same | falls back to `VOXIDE_API_KEY` |
| `PORT`, `HOSTNAME` | platform | set by image | Next standalone server, Dockerfile healthcheck | `3000`, `0.0.0.0` |
| `NODE_ENV` | platform | set by image | banking guards | must be `production` in production |
| `CI` | tooling | no | `playwright.config.ts` | local defaults |

Generate the bank keys with `openssl rand -base64 32` (one per environment;
rotating the encryption key makes existing sealed references unreadable).

### Build time vs runtime

- **Build time:** only `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `next build` inlines them into the browser
  bundle, so they must be present when the image is built. Changing them
  later requires a rebuild. They are not secrets.
- **Runtime:** everything else. Supply server secrets as environment variables
  (or the host's secret store) when the container starts. Do not pass them as
  build args: they would be baked into image layers.
- The Supabase pair is also read on the server at runtime; set it in both
  places (build arg and container env) with the same values.

## 3. Build and run the container

The Dockerfile is multi-stage (`npm ci` > `next build` > slim runtime running
`node server.js` as a non-root user, port 3000).

```
docker build -t sened:latest \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> .

docker run --rm -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
  -e BANK_REFERENCE_ENCRYPTION_KEY=... -e BANK_REFERENCE_HMAC_KEY=... \
  -e LINKS_ET_API_KEY=... \
  sened:latest
```

Or put the runtime variables in a file: `docker run --env-file .env.production ...`
(never commit it; `.dockerignore` excludes `.env*` from the image).

Without build args the image still builds and serves, but sign-in is disabled
in the browser.

## 4. Deploying to EthioDeploy (generic container host)

Treat EthioDeploy as a host that runs an OCI image. Generically that means:

1. Build the image as above (with the two `NEXT_PUBLIC_*` build args) and push
   it to a registry the host can pull from, or use whatever image-upload path
   the host provides.
2. Create a service from that image. Expose container port **3000**, or rely on
   the host injecting `PORT` (the server honours it).
3. Set the runtime environment variables / secrets from section 2 in the
   host's configuration. Keep secrets out of the image and out of git.
4. Configure the health check as an HTTP GET to `/` expecting `200` (see
   below), and serve over HTTPS (the PWA service worker and microphone access
   need a secure origin).
5. Add the public URL to Supabase's allowed redirect URLs.

Consult the host's own documentation for the actual commands and console
steps; they are not covered here.

## 5. Health check

`GET /` returns `200` when the server is up. The image already ships a
`HEALTHCHECK` that fetches `http://127.0.0.1:$PORT/` and fails on anything but
200. There is no dedicated `/api/health` route. `GET /api/voice/capabilities`
is an unauthenticated JSON endpoint that also proves API routes are live.

## 6. Post-deploy smoke checklist

- [ ] `GET /` returns 200 and the shell renders; `/manifest.json` and `/sw.js` return 200.
- [ ] **Sign-in:** `/sign-in` works with a real Supabase user; signing out returns to the signed-out home.
- [ ] **Ledger read:** signed in, `/ledger` loads the group's entries (not a 503; 503 `not_configured` means the Supabase vars are missing at runtime). Unauthenticated `GET /api/my-groups` returns 401.
- [ ] **Voice capabilities:** `GET /api/voice/capabilities` returns JSON; `sttConfigured`/`ttsConfigured` are `true` only if the Voxide variables are set.
- [ ] **Draw:** on `/draw`, commit and reveal a round and check the verify step passes.
- [ ] **Offline sync:** on `/offline`, go offline, queue a draft, reconnect and confirm it syncs via `/api/sync` and is recorded once.
- [ ] **Governance:** `/governance` renders recommendations; citation chips show the bundled list, and "confirmed" appears only when the ScholarXIV variables are set.
- [ ] **Bank verification** (if enabled): a verification attempt reaches links.et or fails closed with a clear message; no secrets appear in responses or logs.

## 7. End-to-end tests (Playwright)

`npm run test:e2e` builds nothing itself; run `npm run build` first (or use
`npm run test:all`). It starts `next start` on port 3210 and needs Playwright's
Chromium. If the installed browser does not match the pinned `@playwright/test`
version (`^1.61.1`), either run `npx playwright install chromium` or point the
config at an existing browser by setting `launchOptions.executablePath` under
`use` in `playwright.config.ts`, for example
`launchOptions: { executablePath: "/path/to/chromium" }`.
