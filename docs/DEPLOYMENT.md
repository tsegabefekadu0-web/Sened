# Deploying Sened

Sened is a Next.js 14 app (`output: "standalone"`) that ships as one container
image. It needs a Supabase project for auth and data; everything else
(bank verification, voice, ScholarXIV) is optional and inert until configured.

## 1. Prerequisites

### Supabase project

1. Create a Supabase project. Note the project URL and the **anon** key
   (Settings > API). The anon key is public by design; every `/api` route
   re-verifies the caller's JWT. The service-role key is not needed by any user-facing
   route; the only thing that reads it is the scheduled reconciliation drain
   (see "Scheduling the reconciliation drain"), and it is optional until you
   enable that.
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
   `20260930100000_ledger_group_invites.sql`, `20261001100000_reconciliation_worker_rpcs.sql`. Later files depend on earlier ones.

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
| `RECONCILIATION_CRON_SECRET` | server secret (>= 32 chars) | for the reconciliation drain | `src/lib/banking/reconciliationDrainRoute.ts` | `POST /api/reconciliation/drain` returns 503 and runs nothing |
| `SUPABASE_SERVICE_ROLE_KEY` | server secret, **service role** | for the reconciliation drain | same | the drain returns 503 `not_configured` |
| `RECONCILIATION_DRAIN_MAX_JOBS` | server | optional (default 25, max 100) | same | default |
| `RECONCILIATION_DRAIN_BUDGET_MS` | server | optional (default 20000, 1000-50000) | same | default |
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
- [ ] **Avatar attire** (migration `20261009100000`): signed in, the Profile slot lists No shawl / Gabi / Netela; choosing one saves (`PUT /api/ledger/member-attire` returns 200) and other members see it on that member's verified contributions.
- [ ] **Masked reference** (if bank verification is enabled): a verified contribution's badge reads `<Provider> Verified · ••••XXXX`. For verifications from before migration `20261008100000`, run the backfill (section 6b) once; until then they show the badge without a reference.
- [ ] **Reconciliation drain** (if bank verification is enabled): the scheduler is configured (section 6a), `POST /api/reconciliation/drain` with the secret returns 200, and without it returns 401.

## 6a. Scheduling the reconciliation drain

When links.et answers `202 queued` (or times out, or rate-limits), the
verification is stored as `PENDING_RECONCILIATION` and a row is kept in
`bank_reconciliation_jobs`. Nothing re-checks it until something calls
`POST /api/reconciliation/drain`, so **you must schedule that call** or pending
verifications stay pending forever.

### What to configure

| Variable | Purpose |
|---|---|
| `RECONCILIATION_CRON_SECRET` | Shared secret the scheduler sends. At least 32 characters (`openssl rand -base64 32`). Unset or shorter: the route returns 503 and does nothing. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key, **runtime env var only**. The claim/reschedule/finalize RPCs are granted to `service_role` only, and a cron has no user session, so this is the one place the app uses it. It is never sent to the browser and is read only by the drain route. Do not pass it as a build arg. |
| `RECONCILIATION_DRAIN_MAX_JOBS`, `RECONCILIATION_DRAIN_BUDGET_MS` | Optional per-call bounds (defaults 25 jobs, 20 s). A call stops starting new jobs after the budget; a job already started finishes (worst case: budget plus one provider call, about `LINKS_ET_TIMEOUT_MS`). Keep the budget comfortably under your platform's request timeout. |

Apply `20261001100000_reconciliation_worker_rpcs.sql` first: without it the
drain cannot read a binding or post to the ledger as the job's owner and every
job would be rescheduled as unavailable.

### The request

```
curl -fsS -X POST https://<your-host>/api/reconciliation/drain \
  -H "Authorization: Bearer $RECONCILIATION_CRON_SECRET"
```

Responses: `200` with a JSON summary, `401` wrong or missing secret, `503`
secret or service-role key not configured, `502` a storage failure mid-run (the
body carries the partial summary; the scheduler should alert and retry). All
responses are `Cache-Control: no-store`. A `200` looks like:

```
{"claimed":3,"verified":2,"rejected":0,"stillPending":1,"failed":0,"reaped":0,
 "nextDueAt":"2026-10-01T10:31:12.000Z","truncated":false,"durationMs":1840}
```

`failed` counts jobs that this call itself took to `MANUAL_REVIEW` because their
attempts ran out; they need a person. `reaped` counts jobs found stuck by an
earlier worker that died holding its final-attempt lease; the drain moves them
to `MANUAL_REVIEW` first (they could never be claimed again). `nextDueAt` is the earliest retry among jobs rescheduled by that
call. `truncated: true` means the batch or time bound ended the run early; the
next call continues.

### Safe to overlap

Claiming uses `for update skip locked` and a per-claim lease token, and
reschedule/finalize refuse unless the worker id and token match, so two
overlapping calls can never work the same job. A call that crashes leaves its
job leased; it becomes claimable again when the 2-minute lease expires. A
verified job is posted to the ledger with the idempotency key
`bank-verified-<intent key>`, so reprocessing never double-posts.

### Option A: any cron (recommended)

Call the endpoint every minute (or every few minutes) from whatever you
already run: the host's scheduled-jobs feature, a GitHub Actions `schedule`,
or a crontab on any machine that can reach the app:

```
* * * * * curl -fsS -m 60 -X POST https://<your-host>/api/reconciliation/drain -H "Authorization: Bearer $RECONCILIATION_CRON_SECRET" >/dev/null
```

Note that the app's per-instance rate limiter allows the route 40 calls per
minute per distinct credential; once a minute is far below that.

### Option B: Supabase `pg_cron` + `pg_net` (optional)

Enable the `pg_cron` and `pg_net` extensions (Database > Extensions), store the
secret in Vault so it is not in the cron definition, then schedule the call.
Verify the syntax against your project's extension versions before relying on it:

```sql
select vault.create_secret('<the same value as RECONCILIATION_CRON_SECRET>', 'reconciliation_cron_secret');

select cron.schedule(
  'sened-reconciliation-drain',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<your-host>/api/reconciliation/drain',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reconciliation_cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $$
);
```

`pg_net` is fire-and-forget, so check its response log
(`select * from net._http_response order by created desc limit 10`) for
non-200s. Remove the schedule with `select cron.unschedule('sened-reconciliation-drain');`.

### Verify it works

- Without the header: `401`. With `RECONCILIATION_CRON_SECRET` unset on the server: `503`.
- With the secret and an empty queue: `200` with all counts `0`.

## 6b. Backfilling masked bank references (one-off, after migration `20261008100000`)

The verified badge on the home feed shows the last characters of the bank
reference (`Telebirr Verified · ••••2F42`). New verifications store that masked
form when they are created. Verifications created **before** the migration have
none, and SQL cannot derive it (the reference is stored encrypted), so their
entries show no reference until this script has run once. Nothing breaks if you
never run it; those rows just stay as they are.

**Order:** apply migration `20261008100000_bank_reference_display.sql` first,
then deploy the application, then run the script. (The migration replaces
`create_bank_verification_intent_v1` with an 11-argument version whose last
argument is optional, so old and new code both work against it.)

```
# dry run (the default): reads, decrypts, counts, writes nothing
npx vite-node scripts/backfill-reference-display.ts

# write
npx vite-node scripts/backfill-reference-display.ts --apply
#   --batch-size N   rows per database read, 1-500 (default 100)
#   --max-rows N     stop after N rows this run (default 1000); run again for the rest
```

`npm run backfill:reference-display -- --apply` is the same command.

- **Where to run it:** on a machine you trust with the production secrets (the
  container host or your own shell), from the repo root with `npm ci` done. It
  needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `BANK_REFERENCE_ENCRYPTION_KEY`, `BANK_REFERENCE_HMAC_KEY` and, if you set
  one, `BANK_REFERENCE_KEY_VERSION`. It reads sealed references through two
  `service_role`-only functions (`list_bank_reference_display_backfill_v1`,
  `set_bank_reference_display_v1`); no other role can call them.
- **Idempotent:** only rows with no display are read, and a display is never
  overwritten, so it is safe to stop, re-run, or run twice. The second run
  reports `scanned: 0` (plus any rows that cannot be masked, see below).
- **Never logs a reference.** Output is counts and verification ids. The JSON
  summary has `scanned`, `updated` (or `wouldUpdate` in a dry run),
  `alreadySet`, `unmaskable`, `otherKeyVersion`, `failed` and `truncated`.
- **Rows it leaves alone:** `unmaskable` (a one-character reference, or one
  outside printable ASCII: nothing safe to show), `otherKeyVersion` (sealed under
  a key version other than `BANK_REFERENCE_KEY_VERSION`; run again with that
  key), and `failed` (could not be decrypted: wrong key or tampering; ids are
  printed to stderr and the exit code is 1). Those entries keep showing no
  reference.
- **Check it:** the final summary, then open the home screen: a verified
  contribution from before the migration now shows `••••` plus its last
  characters.
- **Scratch first:** like the migration harness, try it against a copy before
  production. The unit tests (`test/banking.reference-backfill.test.ts`) cover
  the algorithm with fakes; the database functions are covered by
  `scripts/verify-migrations.sql`.

## 7. End-to-end tests (Playwright)

`npm run test:e2e` builds nothing itself; run `npm run build` first (or use
`npm run test:all`). It starts `next start` on port 3210 and needs Playwright's
Chromium. If the installed browser does not match the pinned `@playwright/test`
version (`^1.61.1`), either run `npx playwright install chromium` or point the
config at an existing browser by setting `launchOptions.executablePath` under
`use` in `playwright.config.ts`, for example
`launchOptions: { executablePath: "/path/to/chromium" }`.
