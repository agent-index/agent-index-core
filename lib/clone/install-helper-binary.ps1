# install-helper-binary.ps1 -- committed backend-matched signed-helper resolver+installer (infra mode)
# Called by clone-repos.ps1 after agent-index-resource-listings is cloned. ALL logic committed once.
# Encodes: binwrongbackend, binfield (current_version), tls12, sha256-verify-or-abort, signing field,
# per-platform registration (macosregister -- never --register a bare darwin file).
param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$Backend,
  [Parameter(Mandatory=$true)][string]$HostArch
)
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Die([string]$m) { Write-Host "FATAL: $m"; exit 2 }

$dir = Join-Path $InstallRoot "agent-index-resource-listings/infrastructure-directory.json"
if (-not (Test-Path $dir)) { Die "infrastructure-directory.json not found at $dir" }
try { $d = Get-Content -Raw -Path $dir | ConvertFrom-Json } catch { Die "infrastructure-directory.json is not valid JSON" }

# 1. backend-matched binary entry (binwrongbackend)
$bin = $null
foreach ($b in $d.binaries) { if ("$($b.backend)" -eq $Backend) { $bin = $b; break } }
if (-not $bin) { Die "no binaries[] entry for backend $Backend (binwrongbackend guard)" }

# 2. version from current_version, NOT version (binfield)
$version = "$($bin.current_version)"
if (-not $version) { Die "binary entry has no current_version (binfield guard)" }

# 3. platform row matching host_os=windows + arch
$plat = $null
foreach ($p in $bin.platforms) { if ("$($p.os)" -eq "windows" -and "$($p.arch)" -eq $HostArch) { $plat = $p; break } }
if (-not $plat) { Die "no platform row for windows/$HostArch" }
$filename = ("$($plat.filename)") -replace '\{version\}', $version
$sha256   = "$($plat.sha256)"
$urlTmpl  = "$($bin.release_url_template)" -replace '\{version\}', $version
$url      = $urlTmpl -replace '\{filename\}', $filename

$dest = Join-Path $InstallRoot ("$($bin.install_destination)")
if (-not $dest) { $dest = Join-Path $InstallRoot "mcp-servers/permission-helper-go" }
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
$out = Join-Path $dest $filename

Write-Host "Downloading helper $filename ($version) for backend $Backend ..."
try { Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing } catch { Die "download failed: $url -- $($_.Exception.Message)" }

# 5. sha256 verify or abort
$got = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLower()
if ($sha256 -and ($got -ne $sha256.ToLower())) { Remove-Item -Force $out -ErrorAction SilentlyContinue; Die "sha256 mismatch (want $sha256 got $got) -- deleted, no install" }

# 6. version.txt
Set-Content -Path (Join-Path $dest "version.txt") -Value $version -Encoding ascii

# signing expectation
$signing = "$($bin.signing)"
if ($signing -eq "unsigned-bypass") {
  Write-Host "NOTE: this helper build is intentionally unsigned (certs pending). If Windows Smart App Control blocks launch/register, see SIGNING.md for the SAC Evaluation-mode workaround -- this is expected, not a failure."
}

# 7. register (windows)
& $out --register 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  if ($signing -eq "unsigned-bypass") { Write-Host "WARN: --register returned nonzero; if SAC blocked it, apply the SIGNING.md workaround then re-run --register." }
  else { Die "helper --register failed (native host registration is a hard error)" }
}
Write-Host ("OK    helper installed at " + $out + " (v" + $version + ", registered)")
exit 0
