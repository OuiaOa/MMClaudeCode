# claude-dsv4f installer - Windows 11 (PowerShell)
#
# There is no systemd here, so the shim is started on demand by `dsv4f run` instead of by a
# service. That costs ~1s on first launch and removes a whole class of thing that can break.
$ErrorActionPreference = "Stop"

$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = if ($env:DSV4F_HOME) { $env:DSV4F_HOME } else { Join-Path $HOME ".local\share\claude-dsv4f" }
$bin  = Join-Path $HOME ".local\bin"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is required (v20+). Install from nodejs.org" }

# Find Claude Code on PATH or in common install locations. Without it, `dsv4f run`
# cannot launch. A bare yellow warning lets installs silently half-work, so we error
# out with an actionable message instead.
$claudeFound = $false
try { if ((& where.exe claude 2>$null | Select-Object -First 1)) { $claudeFound = $true } } catch {}
if (-not $claudeFound) {
  foreach ($candidate in @(
    (Join-Path $HOME ".local\bin\claude.exe"),
    (Join-Path $HOME ".local\bin\claude.cmd"),
    (Join-Path $env:APPDATA "npm\claude.cmd")
  )) {
    if (Test-Path $candidate) { $claudeFound = $true; break }
  }
}
if (-not $claudeFound) {
  throw "Claude Code CLI not found. Install it from https://claude.com/code, then re-run this installer.`n  (Looked for 'claude' on PATH and in: $HOME\.local\bin, $env:APPDATA\npm)"
}

New-Item -ItemType Directory -Force -Path $dest, $bin | Out-Null
if ($src -ne $dest) {
  foreach ($f in @("shim.mjs","probe.mjs","test-shim.mjs","config.default.json")) {
    Copy-Item (Join-Path $src $f) $dest -Force
  }
  Copy-Item (Join-Path $src "bin") $dest -Recurse -Force
  if (Test-Path (Join-Path $src "e2e")) { Copy-Item (Join-Path $src "e2e") $dest -Recurse -Force }
}

# .cmd shims: Windows cannot exec a .mjs directly from PATH
$entries = @{ "dsv4f" = "bin\dsv4f.mjs"; "claude-dsv4f" = "bin\dsv4f.mjs";
              "dsv4f-usage" = "bin\dsv4f-usage"; "dsv4f-import" = "bin\dsv4f-import" }
foreach ($name in $entries.Keys) {
  $target = Join-Path $dest $entries[$name]
  Set-Content -Path (Join-Path $bin "$name.cmd") -Encoding ASCII -Value @"
@echo off
node "$target" %*
"@
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$bin*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$bin", "User")
  Write-Host "Added $bin to your user PATH - open a new terminal for it to take effect." -ForegroundColor Yellow
}

Write-Host "Installed to $dest" -ForegroundColor Green
Write-Host "Next:  dsv4f setup"
