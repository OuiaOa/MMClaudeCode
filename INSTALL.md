# Installing mmclaude

Step-by-step for **Windows 11**, **macOS** and **Linux**. If you can open a terminal and paste
a command, you can do this. Total time is about five minutes, most of it waiting for a download.

---

## Before you start

You need three things. Check each one before going further — most installation problems are
actually one of these missing.

### 1. Node.js 20 or newer

Open a terminal and run:

```
node --version
```

You should see `v20.x.x` or higher. If the command is not found, or the number is lower than
20, install it:

- **Windows** — download the LTS installer from [nodejs.org](https://nodejs.org), run it, then
  **close and reopen your terminal**. Windows only picks up the new PATH in fresh terminals.
- **macOS** — `brew install node` if you use Homebrew, otherwise the installer from nodejs.org.
- **Linux** — your distribution's package may be too old. Check with `node --version`; if it is
  below 20, use [NodeSource](https://github.com/nodesource/distributions) or `nvm`.

### 2. The Claude Code CLI

```
claude --version
```

If that fails, install it from [claude.com/code](https://claude.com/code). You do **not** need
an Anthropic subscription and you do **not** need to be logged in — this tool points Claude
Code at MiniMax instead. If you *are* logged in, that stays untouched and keeps working.

### 3. A MiniMax API key

Create one at [platform.minimax.com/api_keys](https://platform.minimax.com/api_keys) and add
a few dollars of credit. Keys start with `sk-`. Keep the tab open — you will paste it shortly.

No second provider key is needed. MiniMax M3 handles supported image and video blocks natively.

---

## Windows 11

Open **PowerShell** (press Start, type `powershell`, press Enter).

```powershell
# 1. Download and unpack
cd $HOME\Downloads
curl.exe -L -o mmclaude.zip https://github.com/OuiaOa/MMClaudeCode/archive/refs/heads/main.zip
tar -xf mmclaude.zip
cd MMClaudeCode-main

# 2. Install
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`-ExecutionPolicy Bypass` applies to that one command only; it does not change your system
settings. The installer copies files into `%USERPROFILE%\.local\share\mmclaude` and adds
`%USERPROFILE%\.local\bin` to your user PATH.

**Now close PowerShell and open a new one.** PATH changes only apply to new terminals — this
is the single most common reason `mmclaude` appears "not found" on Windows.

```powershell
# 3. Set up
mmclaude setup
```

Follow the prompts (see [First run](#first-run) below).

<details>
<summary><b>If <code>mmclaude</code> is still not found</b></summary>

Check the PATH entry actually landed:

```powershell
[Environment]::GetEnvironmentVariable("Path","User") -split ';' | Select-String "\.local"
```

If nothing prints, add it manually and reopen your terminal:

```powershell
[Environment]::SetEnvironmentVariable("Path", "$([Environment]::GetEnvironmentVariable('Path','User'));$HOME\.local\bin", "User")
```

You can always run it by full path instead:
`node "$HOME\.local\share\mmclaude\bin\mmclaude.mjs" setup`
</details>

<details>
<summary><b>Using WSL instead</b></summary>

If you already work inside WSL, install there using the Linux instructions rather than the
Windows ones. Do not mix: run Claude Code and this tool on the same side of the WSL boundary,
otherwise the CLI cannot reach the local service.
</details>

---

## macOS

Open **Terminal** (⌘-Space, type `terminal`).

```bash
cd ~/Downloads
curl -L -o mmclaude.zip https://github.com/OuiaOa/MMClaudeCode/archive/refs/heads/main.zip
unzip -q mmclaude.zip
cd MMClaudeCode-main

./install.sh
mmclaude setup
```

If `mmclaude: command not found` afterwards, `~/.local/bin` is not on your PATH. Add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

macOS has no systemd, so the background service starts automatically the first time you run
`mmclaude run` and stays up until you reboot or run `mmclaude stop`. This costs about a second on
first launch and nothing thereafter.

---

## Linux

```bash
cd ~/Downloads
curl -L -o mmclaude.zip https://github.com/OuiaOa/MMClaudeCode/archive/refs/heads/main.zip
unzip -q mmclaude.zip
cd MMClaudeCode-main

./install.sh
mmclaude setup
```

If `~/.local/bin` is not already on your PATH, add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

On systems with systemd, setup installs a `--user` service that starts the shim at login. On
systems without it, the shim starts on demand from `mmclaude run` instead — both work, the service
just saves a second on first launch.

---

## First run

`mmclaude setup` asks you for one thing:

**1. Your MiniMax API key.** Paste it and press Enter. Nothing appears as you type — that is
deliberate, the key is never echoed to the screen, never written to your shell history, and
never passed as a command argument where other programs could read it. It is checked against
MiniMax immediately, so a mangled paste fails now rather than confusing you later.

**2. Nothing else.** Setup then probes the MiniMax endpoint to work out how it actually
behaves, writes an isolated Claude Code profile, and starts the background service.

You should see `Setup complete.` Then:

```
mmclaude run
```

That launches Claude Code against MiniMax. On this first run it also imports your existing
memories, saved sessions and tool permissions from `~/.claude`, so previous work is available.

---

## Checking it works

```
mmclaude status
```

Expected:

```
shim      : running on 127.0.0.1:8788
autostart : systemd --user          (or "launcher-managed")
minimax   : key stored
```

Then try a real request:

```
mmclaude run -p "reply with exactly: it works"
```

And check token usage and live quota:

```
mmclaude-usage
```

---

## Everyday use

| command | what it does |
|---|---|
| `mmclaude run` | start a session |
| `mmclaude run --resume` | resume this folder's last session |
| `mmclaude run --effort ultracode` | maximum thoroughness, multi-agent |
| `mmclaude-usage` | token burn rate, live Token Plan quota and traffic queue |
| `mmclaude cap 10` | set the daily spend limit to $10 |
| `mmclaude status` | is the service up, which keys are stored |
| `mmclaude help <command>` | detail on any command |

Sessions are keyed by folder, so `cd` into a project first and Claude Code picks up that
project's history automatically.

**Screenshots:** just reference the image file. To get a better description, say what you are
looking for in the same message — or write `VISION: exact pixel positions and z-order of the
sprites` — and the transcription is aimed at that.

---

## Uninstalling

```bash
# Linux with systemd
systemctl --user disable --now mmclaude-shim.service
rm ~/.config/systemd/user/mmclaude-shim.service

# all platforms
mmclaude stop
rm -rf ~/.local/share/mmclaude ~/.config/mmclaude ~/.mmclaude
rm -f ~/.local/bin/mmclaude* ~/.local/bin/mmclaude
```

On Windows delete `%USERPROFILE%\.local\share\mmclaude`, `%USERPROFILE%\.config\mmclaude`,
`%USERPROFILE%\.mmclaude` and the `.cmd` files in `%USERPROFILE%\.local\bin`.

Your normal `claude` installation and its login are never touched by any of this.

---

## Common problems

**`mmclaude: command not found`** — `~/.local/bin` is not on your PATH, or on Windows you did not
open a new terminal after installing. See the platform section above.

**`shim is not responding`** — run `mmclaude start`. If it still fails, check the log at
`~/.local/share/mmclaude/shim.log`, or on systemd machines
`journalctl --user -u mmclaude-shim -n 50`. The usual cause is another program already
using port 8788; change it with `"port": 8799` in `~/.config/mmclaude/config.json`.

**`mmclaude run` says `'claude.cmd' is not recognized`** — older versions hardcoded the
literal string `claude.cmd`, which `cmd.exe` treats as a fully-qualified filename and
does not resolve via `PATHEXT`. mmclaude resolves `claude` via `PATHEXT` and falls
back to common install locations (`%USERPROFILE%\.local\bin\`, `%APPDATA%\npm\`). If you
still see this, install Claude Code from https://claude.com/code, then re-run.

**No sessions appear after `mmclaude-import --force`** — the importer walks recursively now,
so subagent transcripts (`<session>/subagents/*.jsonl`) and tool-result blobs
(`<session>/tool-results/*`) are included. If a session is still missing, run
`mmclaude-import --source <path-to-your-.claude> --force` and check `~/.mmclaude/projects/`
for the encoded-path folder matching your cwd (e.g. `C--Users-you`).

**`FAILED (HTTP 401)` when entering a key** — the key is wrong or was pasted with a missing
character. Run `mmclaude key minimax` again.

**`daily cap $5.00 reached`** — a safety limit, not an error. `mmclaude cap 10` raises it. Note
that `0` means *unlimited*, not zero; use `0.01` if you want a hard stop.

**Images are rejected** — check that the request is using MiniMax M3 and that the image is in a
supported image block format. No separate vision key is needed.

**`/cost` inside Claude Code shows $0.00** — expected. Claude Code prices from a built-in table
that only knows Anthropic models. Use `mmclaude-usage` instead; it is accurate.

**An old session will not resume** — imported sessions are stripped of data MiniMax cannot
process. Very old ones may still refuse. Starting fresh in the same folder always works; your
code and any `CLAUDE.md` are what actually carry the context.
