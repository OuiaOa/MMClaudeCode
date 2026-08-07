#!/usr/bin/env node
/**
 * Side-effect-free helpers shared by bin/dsv4f.mjs and the CLI tests.
 *
 * Kept separate so it can be imported from a test without triggering the
 * top-level dispatch in dsv4f.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Resolve the Claude Code CLI to invoke.
 *
 * On non-Windows, returns 'claude' (the standard PATH lookup finds it).
 *
 * On Windows, the bug this fixes: passing the literal string 'claude.cmd' to
 * `spawnSync(..., { shell: true })` hands the command line to
 * `cmd.exe /d /s /c "claude.cmd <args>"`. cmd.exe treats `claude.cmd` as a
 * fully-qualified filename and does NOT fall back to PATHEXT — so a real
 * `claude.exe` on PATH is never found. Returning 'claude' (no extension) lets
 * cmd.exe apply PATHEXT and find claude.exe / claude.cmd / claude.bat.
 *
 * If `where.exe claude` does not find anything, fall back to the common
 * install locations so PATH doesn't have to be set up for this tool to work.
 *
 * Dependency injection lets tests swap out spawnSync / fs / env without
 * monkey-patching globals.
 *
 * @param {object} [deps]
 * @param {NodeJS.Platform} [deps.platform]  defaults to process.platform
 * @param {string}           [deps.home]     defaults to os.homedir()
 * @param {object}           [deps.env]      defaults to process.env
 * @param {typeof fs}        [deps.fsSync]   defaults to node:fs
 * @param {typeof spawnSync} [deps.exec]     defaults to node:child_process.spawnSync
 * @returns {string} absolute path or bare command name to pass to spawn
 * @throws  if no candidate is found
 */
export function resolveClaude({ platform = process.platform,
                                home = os.homedir(),
                                env = process.env,
                                fsSync = fs,
                                exec = spawnSync } = {}) {
  if (platform !== 'win32') return 'claude';

  // 1) Bundled copy wins when present. The user ran `install --bundle` (or the
  //    future self-installing installer placed one) so this copy is the
  //    authoritative one for the dsv4f install.
  const bundled = env.DSV4F_DATA_DIR ? path.join(env.DSV4F_DATA_DIR, 'bin') : null;
  if (bundled) {
    for (const name of ['claude.exe', 'claude.cmd']) {
      const p = path.join(bundled, name);
      try { if (fsSync.existsSync(p)) return p; } catch {}
    }
  }

  // 2) Otherwise let cmd.exe's PATHEXT do its job: if 'claude' resolves on PATH
  //    (via where.exe), hand back the bare name with no extension.
  try {
    const r = exec('where.exe', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r && r.status === 0 && r.stdout && r.stdout.toString().trim()) return 'claude';
  } catch { /* fall through to path-based lookups below */ }

  // 3) Final fallback: scan the few places Claude Code actually lands on Windows
  //    when it's installed outside npm (e.g. direct download to ~/.local/bin).
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.cmd'),
    env.APPDATA     ? path.join(env.APPDATA,     'npm', 'claude.cmd') : '',
    env.APPDATA     ? path.join(env.APPDATA,     'npm', 'claude')     : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm', 'bin', 'claude.cmd') : '',
  ].filter(Boolean);

  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) return c; } catch { /* unreadable FS — ignore */ }
  }

  throw new Error(
    `Claude Code CLI not found.\n` +
    `  Looked for a bundled copy, 'claude' on PATH (via where.exe), and in: ${candidates.join(', ')}\n` +
    `  Install Claude Code from https://claude.com/code, then re-run.`
  );
}
