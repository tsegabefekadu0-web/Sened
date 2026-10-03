# syntax=docker/dockerfile:1

# ─── Dependencies ────────────────────────────────────────────────────────────
# Copied on their own so a source-only change does not re-run `npm ci`. Editing
# a component should not invalidate a 400 MB install layer.
FROM node:22-alpine AS deps
WORKDIR /app

# `npm ci` from the lockfile, not `npm install`: a container that silently
# resolves different versions than CI is not reproducible, and the lockfile is
# the record of what was verified.
COPY package.json package-lock.json ./
RUN npm ci

# ─── Build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `NEXT_PUBLIC_*` values are inlined into the browser bundle by `next build`
# (src/lib/auth/browserClient.ts reads them as literal property accesses), so
# they must be supplied HERE, at build time; setting them on the running
# container does not reach the client. Both are public by design (the anon key
# is not a secret). Left empty, the build succeeds and sign-in is simply
# disabled in the browser. Server-only secrets are deliberately NOT build args:
# they are read at runtime and must never be baked into an image layer.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

# `output: "standalone"` in next.config.mjs produces `.next/standalone`, a
# self-contained server plus only the modules it actually imports.
RUN npm run build

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Platforms that route to a container set PORT; Next's standalone server reads
# it, so the same image works on 3000 locally and wherever it is hosted.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a user that is not root. A treasury app holds a group treasury's
# records; there is no reason for it to be able to write to its own image.
RUN addgroup --system --gid 1001 sened \
 && adduser --system --uid 1001 --ingroup sened sened

# `sharp` is optional in Next but strongly recommended: without it, production
# image optimisation falls back to a slower path and logs a warning on boot.
RUN apk add --no-cache libc6-compat

COPY --from=build --chown=sened:sened /app/.next/standalone ./
COPY --from=build --chown=sened:sened /app/.next/static ./.next/static
COPY --from=build --chown=sened:sened /app/public ./public

USER sened
EXPOSE 3000

# A real check rather than `curl`, which alpine does not ship. It hits `/` and
# refuses to report healthy on anything but a 200, so a container that starts
# but cannot serve is failed by the orchestrator instead of being sent traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
