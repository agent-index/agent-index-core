# clone-repos.ps1 -- committed, parameterized repo clone/pin tool (agent-index-core lib/clone)
# Level-3 tooling: the agent emits ONLY a data manifest; ALL clone/ref logic lives here,
# written once and version-controlled. Replaces the per-run agent-transcribed clone script
# (retires clonescripttagassumption + ps1nonascii -- this file is committed ASCII).
#
# Which ref each repo gets is decided by resolve-refs.js (core 3.32.0), shared with the bash twin
# so the two platforms cannot disagree about "the highest tag". Distribution channels: a manifest
# "channel" makes every repo that has a "channel/<channel>" branch come from that branch head; the
# rest fall back to the normal rule (infra: highest v* tag; collections: default-branch head).
# Every run records its decisions in <install_root>/.agent-index/clone-resolution.json.
#
# Usage:  powershell -ExecutionPolicy Bypass -File clone-repos.ps1 -Manifest <path-to-manifest.json>
#
# Manifest shape (all data, no logic):
# {
#   "mode": "infra" | "collections",
#   "channel": null | "dev-1",
#   "host_os": "windows",
#   "host_arch": "amd64" | "arm64",
#   "install_root": "C:/Users/.../agent-index",
#   "backend": "gdrive" | "onedrive",
#   "repos": [ { "name": "agent-index-core", "git_url": "https://github.com/.../x.git", "version": "3.32.0" } ]
# }
param(
  [Parameter(Mandatory=$true)][string]$Manifest
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fail-Hard([string]$msg) { Write-Host "FATAL: $msg"; exit 2 }

if (-not (Test-Path $Manifest)) { Fail-Hard "manifest not found: $Manifest" }
try { $m = Get-Content -Raw -Path $Manifest | ConvertFrom-Json } catch { Fail-Hard "manifest is not valid JSON: $Manifest" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail-Hard "git is required" }

$mode        = "$($m.mode)"
$hostArch    = "$($m.host_arch)"
$installRoot = "$($m.install_root)"
$backend     = "$($m.backend)"
$channel     = if ($m.channel) { "$($m.channel)" } else { "" }
if ($mode -ne "infra" -and $mode -ne "collections") { Fail-Hard "mode must be infra or collections (got: $mode)" }
if (-not $installRoot) { Fail-Hard "install_root is required" }
if ($mode -eq "infra" -and -not $backend) { Fail-Hard "backend is required in infra mode" }
if (-not (Test-Path $installRoot)) { Fail-Hard "install_root does not exist: $installRoot" }

if (Get-Command node -ErrorAction SilentlyContinue) {
  $planText = & node (Join-Path $PSScriptRoot "resolve-refs.js") $Manifest
  if ($LASTEXITCODE -ne 0) { Fail-Hard "ref resolution failed: $planText" }
  try { $plan = ($planText -join "`n") | ConvertFrom-Json } catch { Fail-Hard "could not parse resolve-refs output" }
} else {
  # No Node on this host. Released code still works (built-in tag resolution, numeric sort);
  # distribution channels need resolve-refs.js and therefore Node.
  if ($channel) { Fail-Hard ("distribution channel '" + $channel + "' needs Node.js on this host (install Node, or clear the channel)") }
  Write-Host "note: Node.js not found on this host -- using built-in release-tag resolution (fine for released code)"
  $planRepos = @(); $planErrors = @()
  foreach ($repo in $m.repos) {
    $n = "$($repo.name)"; $u = "$($repo.git_url)"
    if (-not $n -or -not $u) { $planErrors += [pscustomobject]@{ name = $n; error = "manifest entry missing name/git_url" }; continue }
    $raw = & git ls-remote --symref $u HEAD "refs/heads/*" "refs/tags/*" 2>$null
    if ($LASTEXITCODE -ne 0) { $planErrors += [pscustomobject]@{ name = $n; error = "git ls-remote failed" }; continue }
    $dflt = $null; $heads = @{}; $tags = @{}
    foreach ($line in $raw) {
      if ($line -match '^ref: refs/heads/(\S+)\s+HEAD$') { $dflt = $Matches[1]; continue }
      if ($line -match '^([0-9a-f]+)\s+refs/heads/(.+)$') { $heads[$Matches[2]] = $Matches[1]; continue }
      if ($line -match '^([0-9a-f]+)\s+refs/tags/(.+?)(\^\{\})?$') { if ($Matches[3]) { $tags[$Matches[2]] = $Matches[1] } elseif (-not $tags.ContainsKey($Matches[2])) { $tags[$Matches[2]] = $Matches[1] } }
    }
    $rel = @($tags.Keys | Where-Object { $_ -match '^v\d+(\.\d+)*$' } | Sort-Object { [version](($_ -replace '^v','') + $(if (($_ -split '\.').Count -lt 2) { '.0' } else { '' })) })
    if ($mode -eq "infra" -and $rel.Count -gt 0) {
      $t = $rel[-1]; $planRepos += [pscustomobject]@{ name=$n; git_url=$u; mode=$mode; ref_type="tag"; ref=$t; commit=$tags[$t]; want_version="$($repo.version)" }; continue
    }
    if (-not $dflt) { if ($heads.ContainsKey("main")) { $dflt = "main" } elseif ($heads.ContainsKey("master")) { $dflt = "master" } }
    if (-not $dflt) { $planErrors += [pscustomobject]@{ name = $n; error = "remote has no default branch and no usable tag" }; continue }
    $planRepos += [pscustomobject]@{ name=$n; git_url=$u; mode=$mode; ref_type="branch_head"; ref=$dflt; commit=$heads[$dflt]; want_version="$($repo.version)" }
  }
  $plan = [pscustomobject]@{ ok = $true; channel = $null; mode = $mode; repos = $planRepos; errors = $planErrors }
}
if ($channel) { Write-Host ("distribution channel: " + $channel + " (repos with a channel/" + $channel + " branch come from it; the rest from the normal rule)") }

function Read-JsonVersion([string]$dir) {
  foreach ($f in @("collection.json","adapter.json")) {
    $p = Join-Path $dir $f
    if (Test-Path $p) {
      try { $j = Get-Content -Raw -Path $p | ConvertFrom-Json; if ($j.version) { return "$($j.version)" } } catch {}
    }
  }
  return ""
}

function Clear-Lock([string]$dir) {
  $lock = Join-Path $dir ".git/index.lock"
  if (Test-Path $lock) { Remove-Item -Force $lock -ErrorAction SilentlyContinue }
}

function Checkout-Branch([string]$dir, [string]$url, [string]$branch) {
  # clone or refresh to the branch head; the explicit refspec also fixes stale detached shallow clones
  if (-not (Test-Path $dir)) { & git clone --depth=1 --branch $branch $url $dir 2>$null | Out-Null; return ($LASTEXITCODE -eq 0) }
  Clear-Lock $dir
  & git -C $dir fetch --depth=1 origin ("+refs/heads/" + $branch + ":refs/remotes/origin/" + $branch) 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  & git -C $dir reset --hard 2>$null | Out-Null
  & git -C $dir checkout -f -B $branch ("origin/" + $branch) 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  & git -C $dir reset --hard ("origin/" + $branch) 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Checkout-Tag([string]$dir, [string]$url, [string]$tag) {
  if (-not (Test-Path $dir)) { & git clone --depth=1 --branch $tag $url $dir 2>$null | Out-Null; return ($LASTEXITCODE -eq 0) }
  Clear-Lock $dir
  & git -C $dir fetch --depth=1 origin ("+refs/tags/" + $tag + ":refs/tags/" + $tag) 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  & git -C $dir reset --hard 2>$null | Out-Null
  & git -C $dir checkout -f $tag 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

$results = @()   # each: @{ name; ok; detail }
$records = @{}
foreach ($e in @($plan.errors)) { if ($e) { $results += @{ name = "$($e.name)"; ok = $false; detail = "$($e.error)" } } }

foreach ($r in @($plan.repos)) {
  if (-not $r) { continue }
  $name = "$($r.name)"; $url = "$($r.git_url)"; $type = "$($r.ref_type)"; $ref = "$($r.ref)"; $want = "$($r.want_version)"
  $dir = Join-Path $installRoot $name
  try {
    $okCheckout = if ($type -eq "tag") { Checkout-Tag $dir $url $ref } else { Checkout-Branch $dir $url $ref }
    if (-not $okCheckout) { $results += @{ name=$name; ok=$false; detail="could not check out $ref" }; continue }
    if ($mode -eq "collections" -and -not (Test-Path (Join-Path $dir "collection.json"))) { $results += @{ name=$name; ok=$false; detail="collection.json missing after clone" }; continue }
    $ver = Read-JsonVersion $dir
    $sha = "$(& git -C $dir rev-parse HEAD 2>$null)".Trim()
    if ($type -eq "branch_head" -and $mode -eq "infra" -and ((-not $ver) -or ($want -and ($ver -ne $want)))) {
      $results += @{ name=$name; ok=$false; detail="ERROR: no release tag found for $name and version does not match (want=$want got=$ver) -- phantom/never-released (tagnofallback)" }
      continue
    }
    $label = switch ($type) {
      "channel" { "(channel)" }
      "tag"     { "(release tag)" }
      default   { if ($mode -eq "collections") { "(collection, default-branch head)" } else { "(branch-HEAD distribution, no release tags)" } }
    }
    $short = if ($sha.Length -ge 7) { $sha.Substring(0,7) } else { $sha }
    $results += @{ name=$name; ok=$true; detail="$ref@$short $label" }
    $records[$name] = [ordered]@{ ref_type = $type; ref = $ref; commit = $sha; version = $ver; channel = $(if ($channel) { $channel } else { $null }) }
  } catch {
    $results += @{ name=$name; ok=$false; detail="exception: $($_.Exception.Message)" }
  }
}

# ---- resolution record (merged: infra and collections runs touch different repos) ----
$stateDir = Join-Path $installRoot ".agent-index"
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
$recPath = Join-Path $stateDir "clone-resolution.json"
$rec = [ordered]@{ schema = "clone-resolution/1"; channel = $null; resolved_at = ""; repos = [ordered]@{} }
if (Test-Path $recPath) {
  try {
    $old = Get-Content -Raw -Path $recPath | ConvertFrom-Json
    foreach ($p in $old.repos.PSObject.Properties) { $rec.repos[$p.Name] = $p.Value }
  } catch {}
}
$rec.channel = if ($channel) { $channel } else { $null }
$rec.resolved_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
foreach ($k in $records.Keys) { $rec.repos[$k] = $records[$k] }
$tmp = $recPath + ".tmp"
($rec | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding ascii
Move-Item -Force $tmp $recPath

# ---- report ----
$okCount = 0; $failNames = @()
Write-Host ""
foreach ($x in $results) {
  if ($x.ok) { $okCount++; Write-Host ("OK    " + $x.name + " -- " + $x.detail) }
  else { $failNames += $x.name; Write-Host ("FAILED " + $x.name + " -- " + $x.detail) }
}
Write-Host ""
Write-Host ("clone summary: " + $okCount + " ok, " + $failNames.Count + " failed" + $(if ($failNames.Count) { ": " + ($failNames -join ", ") } else { "" }) + "  (record: .agent-index/clone-resolution.json)")

# ---- infra mode: deprecated helper binary (removed in core 4.0.0) ----
$helper = Join-Path $PSScriptRoot "install-helper-binary.ps1"
if ($mode -eq "infra" -and $failNames.Count -eq 0 -and (Test-Path $helper)) {
  & $helper -InstallRoot $installRoot -Backend $backend -HostArch $hostArch
  if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: helper binary install/registration failed"; exit 2 }
}

if ($failNames.Count -gt 0) { exit 1 } else { exit 0 }
# AIFS:FILE-END
