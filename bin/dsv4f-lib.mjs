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
 * Recursively visit every FILE (not directory) under `root`, calling
 * `onFile(fullPath, relativePath)` for each. Shared by dsv4f-sources.mjs and dsv4f-scrub.mjs,
 * which each used to hand-roll their own near-identical recursive walk — five copies across
 * the two files, differing only in what they did per file. A missing/unreadable directory is
 * silently skipped (matches every original copy's behavior: detection/scrub must not crash
 * just because a source half-exists).
 *
 * Returning `false` from `onFile` stops the walk early (used by counters with a cap, so a
 * huge tree can't stall setup).
 *
 * @param {string} root
 * @param {(fullPath: string, relativePath: string) => (void|boolean)} onFile
 */
export function walkFiles(root, onFile) {
  let stopped = false;
  const walk = (dir, relBase) => {
    if (stopped) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stopped) return;
      const full = path.join(dir, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (onFile(full, rel) === false) { stopped = true; return; }
    }
  };
  walk(root, '');
}

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
                                // Same fallback dsv4f.mjs itself uses for DATA_DIR — kept as
                                // a real default (not just "read env.DSV4F_DATA_DIR and give
                                // up if it's unset") because callers essentially never set
                                // that env var explicitly; the default install path IS the
                                // data dir on a normal install. Second bug found alongside
                                // the platform one below: without this default, the bundled
                                // check only ever fired for someone who'd hand-exported
                                // DSV4F_DATA_DIR — i.e. never, in practice.
                                dataDir = env.DSV4F_DATA_DIR || path.join(home, '.local', 'share', 'claude-dsv4f'),
                                fsSync = fs,
                                exec = spawnSync } = {}) {
  // Bundled copy wins on EVERY platform when present — "bundled-private" mode (install
  // --bundle, or the actual bundle-and-drop-credentials action a "remove Claude Code"
  // setup choice performs — see dsv4f-scrub.mjs's performCliRemoval) copies the real
  // binary here specifically so dsv4f never has to fall back to a system-wide `claude`
  // that might carry a real Anthropic login.
  //
  // CONFIRMED LIVE BUG, fixed 2026-08-13: this check used to live entirely inside the
  // `if (platform !== 'win32') return 'claude'` branch below — i.e. it ran ONLY on
  // Windows. On Linux/Mac this function unconditionally returned the bare string
  // 'claude' before ever looking at the data dir, so `install.sh --bundle` copied a
  // binary to a path nothing ever read: the bundle was silently inert on every platform
  // except Windows. Moved above the early return so it actually takes effect everywhere.
  const bundleDir = path.join(dataDir, 'bin');
  const bundleNames = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const name of bundleNames) {
    const p = path.join(bundleDir, name);
    try { if (fsSync.existsSync(p)) return p; } catch {}
  }

  if (platform !== 'win32') return 'claude';

  // Otherwise let cmd.exe's PATHEXT do its job: if 'claude' resolves on PATH
  //    (via where.exe), hand back the bare name with no extension.
  try {
    const r = exec('where.exe', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r && r.status === 0 && r.stdout && r.stdout.toString().trim()) return 'claude';
  } catch { /* fall through to path-based lookups below */ }

  // Final fallback: scan the few places Claude Code actually lands on Windows
  // when it's installed outside npm (e.g. direct download to ~/.local/bin).
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
