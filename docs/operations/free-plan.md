# Running Sened on the Supabase Free plan

| Free limit | What the code does | What the owner must do |
|---|---|---|
| Project pauses after ~7 idle days | `supabase-keepalive.yml` calls a no-op RPC (`sened_keepalive`) every 2 days | Add secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`; apply migration `20261018100000`; run the workflow once from the Actions tab |
| No backups | `supabase-backup.yml` makes a weekly encrypted dump (public + auth), kept 30 days | Add secrets `SUPABASE_DB_URL` (session pooler URL), `BACKUP_PASSPHRASE`; store the passphrase somewhere safe, off GitHub. See [backup-restore.md](backup-restore.md) |
| Auth email: ~2 per hour | Sign-in shows a clear message on rate limit and locks the button for 60 s | Set up custom SMTP (below), then raise the rate limit |
| 1 GB storage, 5 GB egress | Avatars: 256 px WebP, one file per member, 1-year cache, 512 KB bucket cap | Apply the migration above |
| 500 MB database | `scripts/db-usage.sql` shows sizes | Run it monthly (below) |

## GitHub secrets

Repo -> Settings -> Secrets and variables -> Actions -> New repository secret:

- `SUPABASE_URL`: `https://xylzfdayegnhykqcmern.supabase.co`
- `SUPABASE_ANON_KEY`: Dashboard -> Project Settings -> API -> anon public key
- `SUPABASE_DB_URL`: Dashboard -> Connect -> Session pooler (IPv4) connection string, with the real database password filled in
- `BACKUP_PASSPHRASE`: a long random passphrase you generate (for example 6 random words)

## Custom SMTP with Resend (free)

1. Create an account at resend.com. Free tier: 3,000 emails a month, 100 a day.
2. Domains -> Add Domain. Add the DNS records Resend shows (SPF, DKIM) at your DNS host and wait for "Verified". Without a domain you can only send from `onboarding@resend.dev` to your own address, which is fine for testing but not for real members.
3. API Keys -> Create API Key (sending access). Copy it once.
4. Supabase Dashboard -> Authentication -> Emails -> SMTP Settings -> enable Custom SMTP:
   - Sender email: an address on your verified domain (for example `no-reply@yourdomain`)
   - Sender name: `Sened`
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: the API key
5. Save. Then Authentication -> Rate Limits -> raise "Rate limit for sending emails" (for example to 30 per hour). This field only appears after custom SMTP is on.
6. Test: sign in with a real address and confirm the email arrives.

## Database size

Dashboard -> SQL Editor -> paste `scripts/db-usage.sql` -> Run. The first row is the total size. Start acting at about 400 MB (80%): delete old test data, or upgrade the plan. Above 500 MB the project becomes read-only.
