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
docker rm -f $container 2>&1 | Out-Null
docker run -d --name $container `
    -e POSTGRES_PASSWORD=$password -e POSTGRES_DB=sened `
    postgres:16-alpine | Out-Null

# Wait for Postgres to actually answer a query.
#
# `pg_isready` alone is not enough: it can report ready while the postmaster is
# still coming up, and the first real connection then fails with
# "connection to server on socket ... No such file or directory". That is exactly
# what happened once this script was run repeatedly, so readiness is now proven
# with the same connection path every migration will use.
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    docker exec $container psql -U postgres -d postgres -c 'select 1' 2>&1 | Out-Null
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

docker rm -f $container 2>&1 | Out-Null
Write-Host 'Migrations applied and verified.' -ForegroundColor Green
