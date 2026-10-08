# Applies every Supabase migration in filename order against a throwaway
# Postgres container, then runs scripts/verify-migrations.sql.
#
# This exists because the draw SQL can enforce things no TypeScript test can
# observe. A migration that parses is not a migration that enforces anything,
# and the CRITICAL findings in this project were all in code that looked
# correct until it was executed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\verify-migrations.ps1
# Exits non-zero if any check fails. Windows PowerShell 5.1 compatible.

$ErrorActionPreference = 'Continue'
# Windows PowerShell 5.1 promotes native-command stderr to a terminating error,
# which would abort on the expected "no such container" from `docker rm -f`.
# Errors are therefore detected by inspecting exit codes explicitly below rather
# than by the preference.

$container = 'sened-pg-verify'
$password = 'sened'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Db {
    param([Parameter(Mandatory = $true)][string]$SqlFile)

    $tmp = Join-Path $env:TEMP ('sened-sql-' + [guid]::NewGuid().ToString('N') + '.sql')
    Copy-Item -LiteralPath $SqlFile -Destination $tmp -Force
    try {
        # PowerShell has no `<` redirection; pipe the file in instead.
        $out = Get-Content -Raw -LiteralPath $tmp |
            docker exec -i $container psql -U postgres -d sened -v ON_ERROR_STOP=1 -f - 2>&1
        $code = $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
    return @{ Code = $code; Out = ($out -join "`n") }
}

Write-Host 'Starting Postgres...' -ForegroundColor Cyan

# A unique name per run.
#
# Reusing one name meant every run raced the previous container's teardown:
# `docker rm -f` returns before the container has actually gone, so the
# readiness loop could succeed against a database that was already shutting
# down, and the next statement failed with "the database system is shutting
# down". Waiting for the old container to disappear mostly fixed it and
# sometimes did not, because the removal is not observable from outside in a
# reliable order.
#
# A distinct name per run removes the race instead of timing around it. Stale
# containers from earlier runs are removed by label, which is a different
# container and cannot be mistaken for this one.
$label = 'sened.verify.run'
docker ps -a --filter "label=$label" --format '{{.Names}}' 2>&1 | ForEach-Object {
    docker rm -f $_ 2>&1 | Out-Null
}
$container = "sened-pg-verify-$([guid]::NewGuid().ToString('N').Substring(0, 8))"

docker run -d --name $container --label $label `
    -e POSTGRES_PASSWORD=$password -e POSTGRES_DB=sened `
    postgres:16-alpine | Out-Null

# Wait for Postgres to actually answer a query, against the database the harness
# uses.
#
# Two mistakes are corrected here, both of which looked like flaky Postgres:
# `pg_isready` alone reports ready while the postmaster is still coming up; and
# probing the built-in `postgres` database is ready *before* the image's
# initialisation has created `POSTGRES_DB`, so the probe passed and the next
# statement failed. The harness runs against `sened`, so that is what is probed.
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    docker exec $container psql -U postgres -d sened -c 'select 1' 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    docker logs $container 2>&1 | Out-String | Write-Host
    throw 'Postgres did not become ready'
}

$migrations = Get-ChildItem (Join-Path $repoRoot 'supabase\migrations\*.sql') | Sort-Object Name

# The auth stub must exist before the first migration: ledger_core.sql uses
# auth.uid() as a column default.
$stub = Invoke-Db -SqlFile (Join-Path $repoRoot 'scripts\supabase-auth-stub.sql')
if ($stub.Code -ne 0) {
    Write-Host $stub.Out -ForegroundColor Red
    docker rm -f $container 2>&1 | Out-Null
    throw 'Could not create the Supabase auth stub'
}

Write-Host "Applying $($migrations.Count) migrations..." -ForegroundColor Cyan
foreach ($migration in $migrations) {
    Write-Host "  $($migration.Name)"
    $result = Invoke-Db -SqlFile $migration.FullName
    if ($result.Code -ne 0) {
        Write-Host $result.Out -ForegroundColor Red
        docker rm -f $container 2>&1 | Out-Null
        throw "Migration failed: $($migration.Name)"
    }
}

# Apply the whole set a second time.
#
# Every migration in this repository claims to be idempotent - `create table if
# not exists`, `add column if not exists`, `on conflict do nothing` - and a
# migration that can only be applied once is a migration nobody can safely
# re-run. Nothing proved the claim until this pass existed: the three M4.3
# migrations and the provisioning migration all rely on it.
Write-Host 'Re-applying every migration to prove idempotency...' -ForegroundColor Cyan
foreach ($migration in $migrations) {
    $result = Invoke-Db -SqlFile $migration.FullName
    if ($result.Code -ne 0) {
        Write-Host "  $($migration.Name) failed on the second pass:" -ForegroundColor Red
        Write-Host $result.Out -ForegroundColor Red
        docker rm -f $container 2>&1 | Out-Null
        throw "Migration is not idempotent: $($migration.Name)"
    }
}
Write-Host '  every migration re-applied cleanly.' -ForegroundColor Green

Write-Host 'Running verification checks...' -ForegroundColor Cyan
$check = Invoke-Db -SqlFile (Join-Path $repoRoot 'scripts\verify-migrations.sql')
Write-Host $check.Out

if ($check.Code -ne 0) {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION FAILED'
}
if ($check.Out -notmatch 'ALL DRAW BINDING CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE SUCCESS MARKER'
}
if ($check.Out -notmatch 'ALL DRAW CYCLE AND SEAL CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE DRAW CYCLE AND SEAL SUCCESS MARKER'
}
if ($check.Out -notmatch 'ALL LEDGER PROVENANCE CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE LEDGER PROVENANCE SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL LEDGER BALANCES CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE LEDGER BALANCES SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL BANK REFERENCE DISPLAY CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE BANK REFERENCE DISPLAY SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL MEMBER ATTIRE CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE MEMBER ATTIRE SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL ATTRIBUTION AND COLLATERAL CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE ATTRIBUTION AND COLLATERAL SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL CONTRIBUTION GRID AND GATE CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE CONTRIBUTION GRID AND GATE SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL POST-WIN FILL AND COMMIT GATE CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE POST-WIN FILL AND COMMIT GATE SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL PAYMENT CHANNEL AND NOTE CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE PAYMENT CHANNEL AND NOTE SUCCESS MARKER'
}

if ($check.Out -notmatch 'ALL DRAW INTEGRITY CHECKS PASSED') {
    docker rm -f $container 2>&1 | Out-Null
    throw 'VERIFICATION DID NOT REACH THE DRAW INTEGRITY SUCCESS MARKER'
}

docker rm -f $container 2>&1 | Out-Null
Write-Host 'Migrations applied and verified.' -ForegroundColor Green
