# claude-dsv4f installer - Windows 11 (PowerShell)
#
# There is no systemd here, so the shim is started on demand by `dsv4f run` instead of by a
# service. That costs ~1s on first launch and removes a whole class of thing that can break.
$ErrorActionPreference = "Stop"

$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = if ($env:DSV4F_HOME) { $env:DSV4F_HOME } else { Join-Path $HOME ".local\share\claude-dsv4f" }
$bin  = Join-Path $HOME ".local\bin"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is required (v20+). Install from nodejs.org" }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "WARNING: 'claude' not on PATH - install Claude Code first." -ForegroundColor Yellow }

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
