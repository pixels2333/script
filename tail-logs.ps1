param(
    [string]$OutFile = "worker.logs.jsonl",
    [string]$Env = "",
    [string]$Name = "fragrant-base-aea7",
    [switch]$UseHardcodedToken,
    [int]$ProxyPort = 7897,
    [string]$ProxyHost = "127.0.0.1",
    [switch]$PreferOAuth,
    [switch]$RetryForever,
    [int]$RetryDelaySeconds = 2
)

# NOTE: Avoid hardcoding secrets. This is kept only for convenience during local testing.
# Prefer `wrangler login` or setting $env:CLOUDFLARE_API_TOKEN in the shell.
$HardcodedToken = '6TbGhbzsn0InNmderQj11qjZx_IzixmEwflHb6Qq'
if ($UseHardcodedToken -and [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
    $env:CLOUDFLARE_API_TOKEN = $HardcodedToken
}

if ($ProxyPort -gt 0) {
    # Ensure wrangler/node uses the proxy regardless of Windows system proxy settings.
    $proxy = "http://${ProxyHost}:${ProxyPort}"
    $env:HTTPS_PROXY = $proxy
    $env:HTTP_PROXY = $proxy
    if ([string]::IsNullOrWhiteSpace($env:NO_PROXY)) {
        $env:NO_PROXY = "localhost,127.0.0.1"
    }
}

if (-not $PSBoundParameters.ContainsKey('PreferOAuth')) {
    # Default to OAuth session from `wrangler login` to avoid token-based /memberships failures.
    $PreferOAuth = $true
}

if ($PreferOAuth) {
    # Force wrangler to prefer the OAuth session from `wrangler login`.
    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
}
$ErrorActionPreference = "Stop"

# Streams Cloudflare Worker logs to a local file (JSONL).
# Requires: wrangler installed and authenticated.
$wrangler = Get-Command -Name "wrangler" -ErrorAction SilentlyContinue
if (-not $wrangler) {
    Write-Error "wrangler not found. Install it first: npm i -g wrangler"
    exit 127
}

$hasConfig = (Test-Path -LiteralPath "./wrangler.toml") -or (Test-Path -LiteralPath "./wrangler.json") -or (Test-Path -LiteralPath "./wrangler.jsonc")
$problems = @()

if (-not $hasConfig -and [string]::IsNullOrWhiteSpace($Name)) {
    $problems += "Missing Worker name. Provide -Name <worker-name> or add wrangler.toml."
}

if ($problems.Count -gt 0) {
    Write-Host "Cannot start log tailing:" -ForegroundColor Yellow
    $problems | ForEach-Object { Write-Host ("- " + $_) -ForegroundColor Yellow }
    Write-Host "\nExamples:" -ForegroundColor Yellow
    Write-Host "  `$env:CLOUDFLARE_API_TOKEN = '<token>'" -ForegroundColor Yellow
    Write-Host "  ./tail-logs.ps1 -Name '<worker-name>'" -ForegroundColor Yellow
    Write-Host "  ./tail-logs.ps1 -Name '<worker-name>' -Env '<envName>' -OutFile worker.logs.jsonl" -ForegroundColor Yellow
    Write-Host "\nWhat to put in -Name / -Env:" -ForegroundColor Yellow
    Write-Host "  -Name: your Cloudflare Worker name (the same as in wrangler.toml: name = '...')" -ForegroundColor Yellow
    Write-Host "  -Env: optional Wrangler environment (matches a section like [env.<envName>] in wrangler.toml)" -ForegroundColor Yellow
    exit 2
}

$args = @("tail")
if (-not [string]::IsNullOrWhiteSpace($Name)) {
    # Wrangler v4 expects the worker/script name as a positional argument.
    $args += @($Name)
}
$args += @("--format", "json")
if (-not [string]::IsNullOrWhiteSpace($Env)) {
    $args += @("--env", $Env)
}

$outPath = Join-Path -Path (Get-Location) -ChildPath $OutFile
Write-Host ("Writing logs to: {0}" -f $outPath)
Write-Host ("Running: wrangler {0}" -f ($args -join " "))


# Wrangler chooses auth based on environment variables.
# If CLOUDFLARE_API_TOKEN is set, it will prefer token auth, which may fail on /memberships
# depending on token type/permissions. We retry once by unsetting the token to fall back to
# `wrangler login` (OAuth) session.
$hadToken = -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)

function Invoke-WranglerTail {
    param([string[]]$Argv)

    $captured = New-Object System.Collections.Generic.List[string]
    & $wrangler.Source @Argv 2>&1 | ForEach-Object {
        $line = [string]$_
        $captured.Add($line) | Out-Null

        # Preserve each line as-is; JSON mode emits one JSON object per line.
        $line | Add-Content -LiteralPath $OutFile -Encoding utf8
        $line
    }

    # If wrangler exits (non-zero), treat as failure so we can retry/fallback.
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "wrangler tail exited with code ${exitCode}.\n" + ($captured -join "\n")
    }
}

while ($true) {
    try {
        Invoke-WranglerTail -Argv $args
        break
    } catch {
        $msg = $_ | Out-String
        if ($hadToken -and $msg -match "/memberships") {
            Write-Host "Detected /memberships failure while using CLOUDFLARE_API_TOKEN; retrying with token unset (wrangler login session)..." -ForegroundColor Yellow
            Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
            $hadToken = $false
            continue
        }

        if ($RetryForever) {
            Write-Host "wrangler tail failed; retrying in ${RetryDelaySeconds}s..." -ForegroundColor Yellow
            Start-Sleep -Seconds $RetryDelaySeconds
            continue
        }

        throw
    }
}
