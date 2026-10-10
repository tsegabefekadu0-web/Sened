# EthioDeploy: limits and what Sened does about them

Checked 2026-10-10. "Unverified" means EthioDeploy publishes no figure; ask support (Telegram / ethiodeploy.com/docs/help) before relying on it.

Sources: [pricing](https://ethiodeploy.com/pricing), [home](https://ethiodeploy.com), [how deploys work](https://ethiodeploy.com/docs/deploys), [service types](https://ethiodeploy.com/docs/service-types), [env vars](https://ethiodeploy.com/docs/env-vars), [Next.js guide](https://ethiodeploy.com/deploy/nextjs), [troubleshooting](https://ethiodeploy.com/docs/troubleshooting), [Ethiopia hosting](https://ethiodeploy.com/ethiopia-hosting).

| Limitation | Evidence | What we did | Owner action |
|---|---|---|---|
| Free plan: 1 project, sleeps after 30 min idle; Pro ($10 / 1,399 ETB mo) is always-on | pricing page | `/api/health` plus `.github/workflows/keep-warm.yml` pings every 10 min | Set repo variable `SITE_URL=https://sened.ethiodeploy.com`. Upgrade to Pro for a guaranteed no-sleep demo. |
| Cold start time after sleep | unverified | Image is small (276 MB, ~51 MB RAM idle); service worker serves the shell from cache so returning users do not wait | Time a cold request once and note it |
| Keep-warm workflow is not a guarantee | GitHub disables scheduled workflows after 60 days without repo activity; cron runs can be delayed | Documented in the workflow header | Push a commit or re-enable in the Actions tab if it stops; check it ran before judging day |
| RAM / CPU caps, monthly usage quota | no figures published; service-types page says usage counts against a monthly quota | `NODE_OPTIONS=--max-old-space-size=384`, telemetry off, standalone output | Ask support for the Free RAM; raise the heap cap if it is larger |
| Build time / memory limit | unverified | Local `docker build` takes about 90 s; build uses the default heap | If builds are killed, ask support for the build memory limit |
| Image size limit | unverified | 276 MB (was 277 MB; the Dockerfile was already multi-stage, standalone, non-root alpine) | none |
| Dockerfile support | deploys page: a repo Dockerfile takes precedence over auto-detect | Existing Dockerfile used; container port 3000 | none |
| Env vars: "injected at deploy time"; build vs runtime split not documented | env-vars page | `NEXT_PUBLIC_*` are Docker build ARGs (inlined in the browser bundle); secrets stay runtime-only. Fixed a build crash when `NEXT_PUBLIC_SITE_URL` was an empty string (`layout.tsx`) | Confirm the console passes `NEXT_PUBLIC_*` as build args; changing one needs a redeploy |
| Health check on deploy ("old version serves until new is ready"); path/timeout unverified | service-types page | `GET /api/health`: 200 JSON, no DB call, never rate limited; Docker `HEALTHCHECK` uses it | If the console has a health path field, set `/api/health` |
| Zero-downtime deploys | deploys page says yes for web services | none needed | none |
| Ephemeral filesystem | not documented (assume ephemeral) | Code audit: no `fs` use in `src`; all state in Supabase / browser IndexedDB | none |
| No cron or background workers on the web service | workers are a separate service type; cron unverified | No in-process timers carry persistence. The reconciliation drain is an HTTP route meant for an external scheduler | Call `/api/reconciliation/drain` from a GitHub Actions cron or a worker service if bank reconciliation is needed |
| Rate limiter is in memory | `src/lib/rateLimit.ts` | Counters reset on every restart, wake or deploy and are per instance. Fine for one instance; abuse protection is best effort, and RLS/JWT checks do not depend on it | If scaled to several instances, move limits to Supabase or Redis (EthioDeploy offers a Redis addon) |
| Region / latency to Supabase | EthioDeploy region not published ("Hosting in Ethiopia" page gives none); Supabase region is the project's own | Heavy reads are cached on the client (offline queue, IndexedDB) | Note both regions; prefer a Supabase region near the host |
| Bandwidth / egress | unverified | `compress: true`; `/_next/static` immutable 1 year (Next.js default in production); service worker precaches the shell and static assets (public/sw.js); icons cached 1 day | none |
| Custom domain + SSL | free subdomain on every plan; custom domains and free SSL on Pro | `NEXT_PUBLIC_SITE_URL` drives social cards | Add the domain to Supabase redirect URLs and the Voxide whitelist |
| Logs retention | build logs and deployment history only; runtime log retention unverified | App logs no secrets | Capture errors you need during the demo |
| Bank-transfer billing: 30 days, 2-day grace, then back to Free | Ethiopia hosting page | none | Renew before the hackathon demo |

## If EthioDeploy is down

The same `Dockerfile` runs unchanged elsewhere (container port 3000, `PORT` honoured, health path `/api/health`).

- Fly.io, Render or Railway: create a service from the repo Dockerfile, pass the four `NEXT_PUBLIC_*` values as build args and the server secrets as runtime env, set the health path.
- Vercel: `vercel` works for Next without the Dockerfile; set the same env vars in the project.
- After switching, update `NEXT_PUBLIC_SITE_URL`, Supabase redirect URLs, the Voxide domain whitelist and the `SITE_URL` variable for keep-warm. Supabase data is unaffected.
