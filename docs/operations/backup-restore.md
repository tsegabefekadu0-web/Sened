# Backup and restore

`supabase-backup.yml` runs every Sunday (03:43 UTC) and on demand (Actions -> supabase-backup -> Run workflow).
It uses `pg_dump` 17 to dump the `public` and `auth` schemas (custom format), encrypts the file with
`gpg --symmetric --cipher-algo AES256` using `BACKUP_PASSPHRASE`, and uploads `sened-<timestamp>.dump.gpg`
as the artifact `sened-db-backup` (kept 30 days).

Not included: storage files (avatars; members can re-upload) and Supabase-internal schemas.

## Download and decrypt

1. GitHub -> Actions -> pick a successful `supabase-backup` run -> Artifacts -> download `sened-db-backup` and unzip.
2. Decrypt (you will be asked for the passphrase):

```
gpg --output sened.dump --decrypt sened-<timestamp>.dump.gpg
```

## Restore

Use `pg_restore` 15 or newer. `<DB_URL>` is the session pooler URL of the target project. Prefer a fresh or empty project.

Public schema (the app data):

```
pg_restore --dbname "<DB_URL>" --no-owner --no-privileges --schema=public --clean --if-exists sened.dump
```

Users (only needed if the target has no auth users; run before the public restore, because the app tables reference them):

```
pg_restore --dbname "<DB_URL>" --no-owner --no-privileges --data-only --schema=auth \
  --table=users --table=identities sened.dump
```

If the auth step reports conflicts, the users already exist; skip it.

Check afterwards: sign in, open a community, and compare row counts with `scripts/db-usage.sql`.
Re-apply the migrations in `supabase/migrations` if the target project is missing functions or policies.
