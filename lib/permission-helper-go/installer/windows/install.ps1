# install.ps1 — Windows installer for agent-index-show-plan.
#
# Lays the binary at %LOCALAPPDATA%\Agent-Index\bin\, runs --register
# to install the agent-index:// URL scheme handler for the current
# user, and verifies the result.
#
# Usage:
#   pwsh -File install.ps1 [-BinaryPath <path>] [-InstallDir <dir>]
#
# By default the script looks for agent-index-show-plan.exe next to
# itself (the goreleaser archive layout). Pass -BinaryPath to override.

[CmdletBinding()]
param(
    [string]$BinaryPath = (Join-Path $PSScriptRoot "agent-index-show-plan.exe"),
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Agent-Index\bin")
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg) Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Err  { param([string]$msg) Write-Host "✗ $msg" -ForegroundColor Red }

# 1. Verify source binary exists
Write-Step "Locating binary..."
if (-not (Test-Path $BinaryPath)) {
    Write-Err "Binary not found at $BinaryPath"
    Write-Host "Pass -BinaryPath <path> to point at the agent-index-show-plan.exe you want installed."
    exit 1
}
Write-OK "Found $BinaryPath"

# 2. Create install directory
Write-Step "Creating install directory $InstallDir..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-OK "Directory ready"

# 3. Copy binary
$DestPath = Join-Path $InstallDir "agent-index-show-plan.exe"
Write-Step "Installing binary to $DestPath..."
Copy-Item -Force $BinaryPath $DestPath
Write-OK "Binary installed"

# 4. Register URL scheme
Write-Step "Registering agent-index:// URL scheme handler..."
& $DestPath --register
if ($LASTEXITCODE -ne 0) {
    Write-Err "Registration failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}
Write-OK "Scheme registered"

# 5. Verify
Write-Step "Verifying registration..."
$RegOut = reg.exe query "HKCU\Software\Classes\agent-index\shell\open\command" /ve 2>&1
if ($LASTEXITCODE -ne 0 -or -not ($RegOut -match [regex]::Escape($DestPath))) {
    Write-Err "Verification failed; agent-index:// is not pointing at $DestPath"
    Write-Host $RegOut
    exit 1
}
Write-OK "Registry entry points at $DestPath"

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "Test it: open any chat link of the form agent-index://apply?spec=<path-relative-to-workspace>"
