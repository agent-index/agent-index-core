# uninstall.ps1 — Removes the agent-index-show-plan installation.
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Agent-Index\bin")
)

$ErrorActionPreference = "Stop"
$DestPath = Join-Path $InstallDir "agent-index-show-plan.exe"

if (Test-Path $DestPath) {
    & $DestPath --unregister
    Remove-Item -Force $DestPath
    Write-Host "✓ Removed $DestPath" -ForegroundColor Green
} else {
    Write-Host "Nothing to uninstall at $DestPath" -ForegroundColor Yellow
}

# Final cleanup of any residual registry keys (in case --unregister couldn't run).
$Keys = @(
    "HKCU:\Software\Classes\agent-index\shell\open\command",
    "HKCU:\Software\Classes\agent-index\shell\open",
    "HKCU:\Software\Classes\agent-index\shell",
    "HKCU:\Software\Classes\agent-index\DefaultIcon",
    "HKCU:\Software\Classes\agent-index"
)
foreach ($k in $Keys) {
    if (Test-Path $k) { Remove-Item -Recurse -Force $k }
}
Write-Host "✓ Registry cleaned" -ForegroundColor Green
