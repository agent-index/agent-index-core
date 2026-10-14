# remove-permission-helper.ps1 -- removes the retired permission-change-helper from a Windows machine
# (agent-index-core 4.0.0, lib/uninstall; Level 3). Run by apply-updates (and create-org/member-bootstrap
# on an old install) natively on the member's machine. Idempotent: every step treats "not found" as ok.
# Usage: powershell -ExecutionPolicy Bypass -File remove-permission-helper.ps1 -InstallRoot <agent-index install folder>
# Output: one JSON line {"handler_removed":bool,"binary_removed":bool,"stray_ext_removed":bool,"errors":[...]}
# Exit: 0 = every step ok or nothing to remove; 1 = partial failure (the helper is unused, so this never blocks an update).
param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = "Continue"
$errors = @(); $handler = $false; $binary = $false; $stray = $false

# 1. agent-index:// URL handler (HKCU, per-user)
$key = "HKCU:\Software\Classes\agent-index"
if (Test-Path $key) {
  try { Remove-Item -Recurse -Force $key -ErrorAction Stop; $handler = $true } catch { $errors += "registry: $($_.Exception.Message)" }
}

# 2. the install-folder copy (mcp-servers/permission-helper-go/, incl. the stray "agent-index-show-plan{ext}" folder)
$dir = Join-Path $InstallRoot "mcp-servers\permission-helper-go"
if (Test-Path -LiteralPath $dir) {
  $stray = [bool](Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*{ext}*" })
  try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop; $binary = $true } catch { $errors += "install dir: $($_.Exception.Message)" }
}

# 3. the standalone installer location (installer/windows/install.ps1 default)
$legacy = Join-Path $env:LOCALAPPDATA "Agent-Index\bin\agent-index-show-plan.exe"
if (Test-Path -LiteralPath $legacy) {
  try { Remove-Item -LiteralPath $legacy -Force -ErrorAction Stop; $binary = $true } catch { $errors += "legacy binary: $($_.Exception.Message)" }
}

$out = [ordered]@{ handler_removed = $handler; binary_removed = $binary; stray_ext_removed = $stray; errors = $errors }
Write-Output ($out | ConvertTo-Json -Compress)
if ($errors.Count -gt 0) { exit 1 } else { exit 0 }
# AIFS:FILE-END
