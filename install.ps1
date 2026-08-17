# dsv4shim installer - Windows 11 (PowerShell)
#
# There is no systemd here, so the shim is started on demand by `dsv4shim run` instead of by a
# service. That costs ~1s on first launch and removes a whole class of thing that can break.
#
# Detects Node and Claude Code. If Node itself is missing, attempts to install it via winget
# (present on Windows 10 1709+ / 11 by default) before falling back to a manual-install
# error. If Claude Code is missing, attempts to install it via
# `npm install -g @anthropic-ai/claude-code`. Either auto-install step is skipped entirely
# if -NoAutoInstall was passed.
#
# Flags:
#   -NoAutoInstall    do NOT auto-install Node.js or Claude Code even if missing
#   -Bundle           copy Claude Code's binary into the dsv4shim install, so the resulting
#                     setup is self-contained and the resolver prefers the bundled copy
#   -Update           re-copy files even if the destination already exists
#
# NOTE: PowerShell on Windows reads this file with the system codepage by default. UTF-8
# bytes (em-dashes, etc.) become mojibake and break parsing. The script intentionally uses
# ASCII-only text so a default `powershell -File .\install.ps1` parses cleanly regardless of
# the host codepage. If you edit this file, avoid non-ASCII characters in string literals.

[CmdletBinding()]
param(
    [switch]$NoAutoInstall = $false,
    [switch]$Bundle        = $false,
    [switch]$Update        = $false
)

$ErrorActionPreference = "Stop"

$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = if ($env:DSV4SHIM_HOME) { $env:DSV4SHIM_HOME } else { Join-Path $HOME ".local\share\dsv4shim" }
$bin  = Join-Path $HOME ".local\bin"

# ------------------------------------------------- Node (auto-install, then hard check)
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not $NoAutoInstall) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "Node.js not found -- attempting install via winget..." -ForegroundColor Yellow
        try {
            & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Host
        } catch {
            Write-Host "  winget install failed." -ForegroundColor Red
        }
        # winget updates the registry's PATH but not this already-running process -- reload
        # it from Machine+User so `node` is findable without needing a brand new shell.
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPathNow = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machinePath;$userPathNow"
    } else {
        Write-Host "  winget not found either -- install Node.js manually from https://nodejs.org/" -ForegroundColor Yellow
    }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js v20+ is required. Install from https://nodejs.org/ (or: winget install -e --id OpenJS.NodeJS.LTS), then re-run this installer in a NEW terminal."
}
$nodeVersion = (node -e 'process.stdout.write(process.versions.node)')
$nodeMajor = [int]$nodeVersion.Split('.')[0]
if ($nodeMajor -lt 20) {
    throw "Node $nodeVersion detected -- dsv4shim needs v20 or newer. Please upgrade: https://nodejs.org/"
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
        Write-Host "Claude Code CLI not found -- attempting install via npm..." -ForegroundColor Yellow
        try {
            & npm install -g @anthropic-ai/claude-code 2>&1 | Out-Host
            # CONFIRMED LIVE BUG (found on a real Windows machine, 2026-08-12): npm install
            # can report success (the package really is on disk, e.g. claude.cmd exists at
            # $env:APPDATA\npm\claude.cmd immediately checkable in a fresh shell) while THIS
            # SAME process's very next Find-Claude call still returns nothing -- reproduced
            # twice: install.ps1 threw "Claude Code CLI is required" right after npm printed
            # "added N packages", but running install.ps1 again immediately succeeded with
            # zero further action needed. Root cause not fully isolated (likely a brief
            # antivirus scan lock or filesystem-event delay on the just-written .cmd file,
            # not an actual npm failure) -- a short retry loop is a robust fix regardless of
            # the exact cause, and costs nothing when Find-Claude succeeds on the first try
            # as it normally does.
            for ($i = 0; -not $claudeBin -and $i -lt 5; $i++) {
                $claudeBin = Find-Claude
                if (-not $claudeBin) { Start-Sleep -Milliseconds 500 }
            }
            if ($claudeBin) {
                Write-Host "Claude Code installed." -ForegroundColor Green
            }
        } catch {
            Write-Host "  npm install failed -- falling through to manual instructions." -ForegroundColor Red
        }
    } else {
        Write-Host "  npm not found either -- install Node.js (which includes npm) from https://nodejs.org/, then run:" -ForegroundColor Yellow
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
    # Skills (Claude Code Skills) -- auto-discovered under the dsv4shim profile. Copy
    # the whole skills/ tree so user-level skills install alongside the binary.
    if (Test-Path (Join-Path $src "skills")) { Copy-Item (Join-Path $src "skills") $dest -Recurse -Force }
    # Agents (Claude Code subagents) -- one .md per agent, discovered under the profile's
    # agents/ dir. See agents/README.md for provenance.
    if (Test-Path (Join-Path $src "agents")) { Copy-Item (Join-Path $src "agents") $dest -Recurse -Force }
}

# ------------------------------------------ Optional: bundle Claude Code
# Copies claude into the dsv4shim install so the resolver can prefer it. Makes the dsv4shim
# install self-contained -- PATH becomes optional.
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
        Write-Host "Bundled Claude Code -> $bundled (resolver will prefer this copy)." -ForegroundColor Cyan
    } catch {
        Write-Host "  WARNING: could not bundle '$claudeBin' into $bundled (continuing anyway)." -ForegroundColor Yellow
    }
}

# .cmd shims: Windows cannot exec a .mjs directly from PATH
# `dsv4f` and `claude-dsv4f` were two names for one script; under the DSv4Shim rename they
# collapse to a single `dsv4shim`, so there is one entry where there were two. A duplicate key
# in a PowerShell hash literal is a hard parse error, not a silent overwrite.
$entries = @{ "dsv4shim" = "bin\dsv4shim.mjs";
              "dsv4shim-usage" = "bin\dsv4shim-usage"; "dsv4shim-import" = "bin\dsv4shim-import" }
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
Write-Host "Next:  dsv4shim setup"