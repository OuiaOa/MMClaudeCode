#!/usr/bin/env node
/**
 * dsv4shim-migrate — one-shot rename migration, claude-dsv4f -> dsv4shim.
 *
 * The rename is a CLEAN BREAK: no code path reads the old locations any more. That makes this
 * script the whole migration. A machine that gets the new code without running this loses
 * sight of its stored key, sentinel, usage ledger, daily cap and vision cache — the files are
 * still on disk under the old names, but nothing looks there.
 *
 * ORDER MATTERS, and it is UPDATE FIRST, then migrate, then restart:
 *
 *   1. run the OLD `dsv4f-update.mjs` (still present, still pointing at the same repo)
 *   2. run THIS script
 *   3. restart the shim
 *
 * Because this moves the install directory itself, the new code has to be inside it before it
 * moves. Migrating first leaves the OLD code sitting in the NEW directory, still looking for
 * `~/.config/claude-dsv4f` — which this script just moved out from under it. Either order has
 * a brief broken window, which is inherent to a clean break; this is the order where the
 * window closes by itself at step 2 rather than needing a manual fix.
 *
 * Step 1 leaves the old `dsv4f-*` files behind next to the new `dsv4shim-*` ones. That is
 * harmless clutter — the updater copies tracked files in and does not prune removed ones.
 *
 * What moves:
 *   ~/.config/claude-dsv4f        -> ~/.config/dsv4shim         (key, sentinel, config, cap)
 *   ~/.local/share/claude-dsv4f   -> ~/.local/share/dsv4shim    (install, usage ledger, caches)
 *   ~/.claude-dsv4f               -> ~/.dsv4shim                (isolated Claude Code profile)
 *   systemd --user claude-dsv4f-shim.service -> dsv4shim-shim.service
 *   Windows scheduled task claude-dsv4f-shim -> dsv4shim
 *   CLAUDE_DSV4F_* env keys in any settings.json this install wrote -> DSV4SHIM_*
 *
 * Safe to re-run: every step is skipped when its source is absent or its destination already
 * exists. Nothing is deleted — directories are MOVED, and a move that would clobber an
 * existing destination is refused rather than merged, so a half-finished run never silently
 * mixes two generations of state.
 *
 * --dry-run  print what would happen and change nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const HOME = os.homedir();
const WIN = process.platform === 'win32';

let moved = 0;
let skipped = 0;
let failed = 0;

const say = (...a) => console.log(DRY ? '[dry-run]' : '        ', ...a);

function moveDir(from, to, what) {
  if (!fs.existsSync(from)) { say(`skip  ${what}: nothing at ${from}`); skipped++; return; }
  if (fs.existsSync(to)) {
    say(`SKIP  ${what}: ${to} already exists — refusing to merge two generations of state.`);
    say(`      Inspect both, then move ${from} aside by hand.`);
    skipped++;
    return;
  }
  say(`move  ${what}: ${from} -> ${to}`);
  if (DRY) { moved++; return; }
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved++;
  } catch (e) {
    // A cross-device rename (EXDEV) needs a copy; anything else is a real failure.
    if (e.code === 'EXDEV') {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
      moved++;
    } else {
      console.error(`        FAILED ${what}: ${e.message}`);
      failed++;
    }
  }
}

console.log('dsv4shim migration (claude-dsv4f -> dsv4shim)\n');

moveDir(path.join(HOME, '.config', 'claude-dsv4f'),
        path.join(HOME, '.config', 'dsv4shim'), 'config dir');
moveDir(path.join(HOME, '.local', 'share', 'claude-dsv4f'),
        path.join(HOME, '.local', 'share', 'dsv4shim'), 'data dir');
moveDir(path.join(HOME, '.claude-dsv4f'),
        path.join(HOME, '.dsv4shim'), 'isolated profile');

// ---------------------------------------------------------------- service unit
if (!WIN) {
  const unitDir = path.join(HOME, '.config', 'systemd', 'user');
  const oldUnit = path.join(unitDir, 'claude-dsv4f-shim.service');
  const newUnit = path.join(unitDir, 'dsv4shim-shim.service');
  if (fs.existsSync(oldUnit) && !fs.existsSync(newUnit)) {
    say(`move  systemd unit: claude-dsv4f-shim.service -> dsv4shim-shim.service`);
    moved++;
    if (!DRY) {
      try {
        execFileSync('systemctl', ['--user', 'disable', '--now', 'claude-dsv4f-shim.service'],
                     { stdio: 'ignore' });
      } catch { /* not enabled, or not running — either is fine */ }
      // Rewrite ExecStart and friends: the unit points at paths that just moved.
      const body = fs.readFileSync(oldUnit, 'utf8')
        .replaceAll('claude-dsv4f', 'dsv4shim')
        .replaceAll('CLAUDE_DSV4F', 'DSV4SHIM');
      fs.writeFileSync(newUnit, body);
      fs.rmSync(oldUnit);
      try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
        execFileSync('systemctl', ['--user', 'enable', '--now', 'dsv4shim-shim.service'],
                     { stdio: 'ignore' });
        say('      unit reloaded and started');
      } catch (e) {
        console.error(`        unit written but systemctl failed: ${e.message}`);
        failed++;
      }
    }
  } else {
    say('skip  systemd unit: not present, or already migrated');
    skipped++;
  }
} else {
  // The scheduled task is what actually survives an SSH disconnect on Windows — a detached
  // node child does not, because OpenSSH tears down the whole job object on session end.
  say('note  Windows scheduled task must be re-created by hand (schtasks cannot rename):');
  say('        schtasks /delete /tn claude-dsv4f-shim /f');
  say('        then re-run setup, or re-create the task pointing at the new');
  say('        %USERPROFILE%\\.local\\share\\dsv4shim\\ops path.');
}

// ------------------------------------------------------- settings.json env keys
// A rerouted install carries DSV4SHIM_*/CLAUDE_DSV4F_* keys in someone else's settings.json.
// Renaming the vars in code without renaming them there leaves the reroute pointing nowhere.
for (const settings of [
  path.join(HOME, '.claude', 'settings.json'),
  path.join(HOME, '.dsv4shim', 'settings.json'),
]) {
  if (!fs.existsSync(settings)) continue;
  let text;
  try { text = fs.readFileSync(settings, 'utf8'); } catch { continue; }
  if (!text.includes('CLAUDE_DSV4F') && !text.includes('claude-dsv4f')) continue;
  say(`edit  ${settings}: CLAUDE_DSV4F_* -> DSV4SHIM_*, claude-dsv4f paths -> dsv4shim`);
  if (DRY) { moved++; continue; }
  try {
    JSON.parse(text);                       // refuse to touch a file that is already broken
    fs.copyFileSync(settings, settings + '.pre-dsv4shim.bak');
    const out = text.replaceAll('CLAUDE_DSV4F', 'DSV4SHIM').replaceAll('claude-dsv4f', 'dsv4shim');
    JSON.parse(out);                        // and refuse to write one we just broke
    fs.writeFileSync(settings, out);
    moved++;
  } catch (e) {
    console.error(`        FAILED ${settings}: ${e.message}`);
    failed++;
  }
}

console.log(`\n${moved} migrated, ${skipped} skipped, ${failed} failed`);
if (!WIN && !DRY && !failed) {
  console.log('\nNext: confirm the shim is up —  systemctl --user status dsv4shim-shim');
}
if (failed) process.exit(1);
