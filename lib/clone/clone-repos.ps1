# clone-repos.ps1 -- committed, parameterized repo clone/pin tool (agent-index-core lib/clone)
# Level-3 tooling: the agent emits ONLY a data manifest; ALL clone/tag/binary logic lives here,
# written once and version-controlled. Replaces the per-run agent-transcribed clone script
# (retires clonescripttagassumption + ps1nonascii -- this file is committed ASCII).
#
# Usage:  powershell -ExecutionPolicy Bypass -File clone-repos.ps1 -Manifest <path-to-manifest.json>
#
# Manifest shape (all data, no logic):
# {
#   "mode": "infra" | "collections",
#   "host_os": "windows",
#   "host_arch": "amd64" | "arm64",
#   "install_root": "C:/Users/.../agent-index",
#   "backend": "gdrive" | "onedrive",
#   "repos": [ { "name": "agent-index-core", "git_url": "https://github.com/.../x.git" } ]
# }
param(
  [Parameter(Mandatory=$true)][string]$Manifest
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fail-Hard([string]$msg) { Write-Host "FATAL: $msg"; exit 2 }

if (-not (Test-Path $Manifest)) { Fail-Hard "manifest not found: $Manifest" }
try { $m = Get-Content -Raw -Path $Manifest | ConvertFrom-Json } catch { Fail-Hard "manifest is not valid JSON: $Manifest" }

$mode        = "$($m.mode)"
$hostArch    = "$($m.host_arch)"
$installRoot = "$($m.install_root)"
$backend     = "$($m.backend)"
if ($mode -ne "infra" -and $mode -ne "collections") { Fail-Hard "mode must be infra or collections (got: $mode)" }
if (-not $installRoot) { Fail-Hard "install_root is required" }
if ($mode -eq "infra" -and -not $backend) { Fail-Hard "backend is required in infra mode" }
if (-not (Test-Path $installRoot)) { Fail-Hard "install_root does not exist: $installRoot" }

$results = @()   # each: @{ name; ok; detail }

function Get-HighestTag([string]$gitUrl) {
  # returns the highest v* tag string, or $null if the repo exposes zero v* tags
  $raw = & git ls-remote --tags --refs $gitUrl 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $tags = @()
  foreach ($line in $raw) {
    if ($line -match 'refs/tags/(v[0-9][^\s]*)$') { $tags += $Matches[1] }
  }
  if ($tags.Count -eq 0) { return $null }
  # ARRAY context so a single-tag repo still yields the whole string (singletag guard)
  $sorted = @($tags | Sort-Object { [version]($_ -replace '^v','') })
  return $sorted[-1]
}

function Read-JsonVersion([string]$dir) {
  foreach ($f in @("collection.json","adapter.json")) {
    $p = Join-Path $dir $f
    if (Test-Path $p) {
      try { $j = Get-Content -Raw -Path $p | ConvertFrom-Json; if ($j.version) { return "$($j.version)" } } catch {}
    }
  }
  return $null
}

function Clean-Checkout([string]$dir, [string]$ref) {
  # existing dir: clear stale lock, discard drift (pristine source clone), fetch, checkout ref
  $lock = Join-Path $dir ".git/index.lock"
  if (Test-Path $lock) { Remove-Item -Force $lock -ErrorAction SilentlyContinue }
  & git -C $dir fetch --tags --depth=1 origin 2>$null | Out-Null
  & git -C $dir reset --hard 2>$null | Out-Null
  & git -C $dir checkout $ref 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { & git -C $dir reset --hard $ref 2>$null | Out-Null }
  return ($LASTEXITCODE -eq 0)
}

foreach ($repo in $m.repos) {
  $name   = "$($repo.name)"
  $gitUrl = "$($repo.git_url)"
  $dir    = Join-Path $installRoot $name
  if (-not $name -or -not $gitUrl) { $results += @{ name = "$name"; ok = $false; detail = "manifest entry missing name or git_url" }; continue }

  try {
    if ($mode -eq "collections") {
      # collection repos: default-branch, HEAD-SHA pinned (colltags -- no tag required)
      if (-not (Test-Path $dir)) {
        & git clone --depth=1 $gitUrl $dir 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $results += @{ name=$name; ok=$false; detail="git clone failed" }; continue }
      } else {
        $lock = Join-Path $dir ".git/index.lock"; if (Test-Path $lock) { Remove-Item -Force $lock -ErrorAction SilentlyContinue }
        & git -C $dir fetch --depth=1 origin 2>$null | Out-Null
        & git -C $dir reset --hard "@{u}" 2>$null | Out-Null
      }
      if (-not (Test-Path (Join-Path $dir "collection.json"))) { $results += @{ name=$name; ok=$false; detail="collection.json missing after clone" }; continue }
      $sha = (& git -C $dir rev-parse HEAD 2>$null); $branch = (& git -C $dir rev-parse --abbrev-ref HEAD 2>$null)
      $results += @{ name=$name; ok=$true; detail="cloned at $branch@$sha (collection, HEAD-pinned)" }
      continue
    }

    # ---- infra mode: three-way tag / branch-HEAD / phantom discrimination ----
    $tag = Get-HighestTag $gitUrl
    if ($tag) {
      if (-not (Test-Path $dir)) {
        & git clone --depth=1 --branch $tag $gitUrl $dir 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $results += @{ name=$name; ok=$false; detail="git clone --branch $tag failed" }; continue }
      } else {
        if (-not (Clean-Checkout $dir $tag)) { $results += @{ name=$name; ok=$false; detail="checkout $tag failed" }; continue }
      }
      $results += @{ name=$name; ok=$true; detail="cloned at $tag (release tag)" }
      continue
    }

    # zero tags: clone default branch, then decide branch-HEAD vs phantom by version match
    if (-not (Test-Path $dir)) {
      & git clone --depth=1 $gitUrl $dir 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { $results += @{ name=$name; ok=$false; detail="git clone (default branch) failed" }; continue }
    } else {
      $lock = Join-Path $dir ".git/index.lock"; if (Test-Path $lock) { Remove-Item -Force $lock -ErrorAction SilentlyContinue }
      & git -C $dir fetch --depth=1 origin 2>$null | Out-Null
      & git -C $dir reset --hard "@{u}" 2>$null | Out-Null
    }
    $ver = Read-JsonVersion $dir
    $want = "$($repo.version)"
    if ($ver -and ((-not $want) -or ($ver -eq $want))) {
      $sha = (& git -C $dir rev-parse HEAD 2>$null); $branch = (& git -C $dir rev-parse --abbrev-ref HEAD 2>$null)
      $results += @{ name=$name; ok=$true; detail="cloned at $branch@$sha (branch-HEAD distribution, no release tags)" }
    } else {
      $results += @{ name=$name; ok=$false; detail="ERROR: no release tag found for $name and version does not match (want=$want got=$ver) -- phantom/never-released (tagnofallback)" }
    }
  } catch {
    $results += @{ name=$name; ok=$false; detail="exception: $($_.Exception.Message)" }
  }
}

# ---- report ----
$okCount = 0; $failNames = @()
Write-Host ""
foreach ($r in $results) {
  if ($r.ok) { $okCount++; Write-Host ("OK    " + $r.name + " -- " + $r.detail) }
  else { $failNames += $r.name; Write-Host ("FAILED " + $r.name + " -- " + $r.detail) }
}
Write-Host ""
Write-Host ("clone summary: " + $okCount + " ok, " + $failNames.Count + " failed" + $(if ($failNames.Count) { ": " + ($failNames -join ", ") } else { "" }))

# ---- infra mode: binary resolution from freshly-cloned listings ----
if ($mode -eq "infra" -and $failNames.Count -eq 0) {
  & "$PSScriptRoot\install-helper-binary.ps1" -InstallRoot $installRoot -Backend $backend -HostArch $hostArch
  if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: helper binary install/registration failed"; exit 2 }
}

if ($failNames.Count -gt 0) { exit 1 } else { exit 0 }
