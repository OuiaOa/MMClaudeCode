# claude-dsv4f installer - Windows 11 (PowerShell)
#
# There is no systemd here, so the shim is started on demand by `dsv4f run` instead of by a
# service. That costs ~1s on first launch and removes a whole class of thing that can break.
#
# Detects Node, npm, and Claude Code. If Claude Code is missing, attempts to install it via
# `npm install -g @anthropic-ai/claude-code` (only when npm is on PATH and -NoAutoInstall
# wasn't passed). If Node/npm are missing entirely, fails with an actionable error rather
# than trying to bootstrap a toolchain.
#
# Flags:
#   -NoAutoInstall    do NOT auto-install Claude Code even if missing
#   -Bundle           copy Claude Code's binary into the dsv4f install, so the resulting
#                     setup is self-contained and the resolver prefers the bundled copy
#   -Update           re-copy files even if the destination already exists

[CmdletBinding()]
param(
    [switch]$NoAutoInstall = $false,
    [switch]$Bundle        = $false,
    [switch]$Update        = $false
)

$ErrorActionPreference = "Stop"

$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = if ($env:DSV4F_HOME) { $env:DSV4F_HOME } else { Join-Path $HOME ".local\share\claude-dsv4f" }
$bin  = Join-Path $HOME ".local\bin"

# ------------------------------------------------- Node (hard requirement)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js v20+ is required. Install from https://nodejs.org/"
}
$nodeVersion = (node -e 'process.stdout.write(process.versions.node)')
$nodeMajor = [int]$nodeVersion.Split('.')[0]
if ($nodeMajor -lt 20) {
    throw "Node $nodeVersion detected — claude-dsv4f needs v20 or newer. Please upgrade: https://nodejs.org/"
}

# ---------------------------------------------- Find Claude Code binary
function Find-Claude {
    try { if ((& where.exe claude 2>$null | Select-Object -First 1)) { return (& where.exe claude 2>$null | Select-Object -First 1) } } catch {}
    foreach ($candidate in @(
        (Join-Path $HOME ".local\bin\claude.exe"),
        (Join-Path $HOME ".local\bin\claude.cmd"),
        (Join-Path $env:APPDATA "npm\claude.cmd"),
        (Join-Path $env:LOCALAPPDATA "npm\bin\claude.cmd")
    )) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }
    return $null
}

$claudeBin = Find-Claude

# ------------------------------------------------- Auto-install Claude Code
if (-not $claudeBin -and -not $NoAutoInstall) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Write-Host "Claude Code CLI not found — attempting install via npm..." -ForegroundColor Yellow
        try {
            & npm install -g @anthropic-ai/claude-code 2>&1 | Out-Host
            $claudeBin = Find-Claude
            if ($claudeBin) {
                Write-Host "Claude Code installed." -ForegroundColor Green
            }
        } catch {
            Write-Host "  npm install failed — falling through to manual instructions." -ForegroundColor Red
        }
    } else {
        Write-Host "  npm not found either — install Node.js (which includes npm) from https://nodejs.org/, then run:" -ForegroundColor Yellow
        Write-Host "    npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
    }
}

if (-not $claudeBin) {
    throw "Claude Code CLI is required. Install from https://claude.com/code, then re-run this installer.`n  (Looked for 'claude' on PATH and in: $HOME\.local\bin, $env:APPDATA\npm)"
}

New-Item -ItemType Directory -Force -Path $dest, $bin | Out-Null
if ($src -ne $dest -or $Update) {
    foreach ($f in @("shim.mjs","probe.mjs","test-shim.mjs","config.default.json")) {
        Copy-Item (Join-Path $src $f) $dest -Force
    }
    Copy-Item (Join-Path $src "bin") $dest -Recurse -Force
    if (Test-Path (Join-Path $src "e2e")) { Copy-Item (Join-Path $src "e2e") $dest -Recurse -Force }
}

# ------------------------------------------ Optional: bundle Claude Code
# Copies claude into the dsv4f install so the resolver can prefer it. Makes the dsv4f
# install self-contained — PATH becomes optional.
if ($Bundle -and $claudeBin) {
    $bundled = Join-Path $dest "bin\claude.cmd"
    $bundledExe = Join-Path $dest "bin\claude.exe"
    try {
        # The npm-installed wrapper is a .cmd; also copy the actual exe if adjacent
        Copy-Item -Path $claudeBin -Destination $bundled -Force -ErrorAction Stop
        if ($claudeBin -like "*.cmd") {
            $exeSibling = $claudeBin -replace '\.cmd$', '.exe'
            if (Test-Path $exeSibling) { Copy-Item -Path $exeSibling -Destination $bundledExe -Force }
        }
        Write-Host "Bundled Claude Code → $bundled (resolver will prefer this copy)." -ForegroundColor Cyan
    } catch {
        Write-Host "  WARNING: could not bundle '$claudeBin' into $bundled (continuing anyway)." -ForegroundColor Yellow
    }
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

Write-Host ""
Write-Host "Installed to $dest" -ForegroundColor Green
Write-Host "Next:  dsv4f setup"