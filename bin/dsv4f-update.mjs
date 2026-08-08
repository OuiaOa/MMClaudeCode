#!/usr/bin/env node
/**
 * dsv4f-update.mjs — pull the latest shim from GitHub over the installed copy.
 *
 *   node bin/dsv4f-update.mjs           apply if there is anything new
 *   node bin/dsv4f-update.mjs --check   report only (exit 10 = update available)
 *   node bin/dsv4f-update.mjs --force   reapply even when already current
 *   node bin/dsv4f-update.mjs --no-restart
 *
 * The install directory deliberately is NOT a git working tree: it mixes shipped
 * code with runtime state (usage.jsonl, balance history, vision-cache, shim.pid),
 * and a working tree there would keep trying to reconcile files that are none of
 * git's business. Instead the repo is kept in a cache clone and only files that
 * git actually tracks are copied out of it.
 *
 * That inverts the usual risk. Rather than listing what to protect and hoping the
 * list is complete, nothing is copied unless the repo tracks it — so a state file
 * cannot be clobbered by an update that forgot about it. ~/.config/claude-dsv4f,
 * which holds your API keys, caps and probe results, is never written at all
 * except to add newly-introduced config keys.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const REPO_URL = 'https://github.com/OuiaOa/claude-dsv4f.git';
const DATA = process.env.DSV4F_DATA_DIR || join(homedir(), '.local', 'share', 'claude-dsv4f');
const CONFIG = process.env.DSV4F_CONFIG_DIR || join(homedir(), '.config', 'claude-dsv4f');
const CACHE = join(DATA, '.update-cache');
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE = args.includes('--force');
const NO_RESTART = args.includes('--no-restart');

const log = (m) => console.log(m);
const warn = (m) => console.log(`  ! ${m}`);

function run(cmd, argv, cwd, timeout = 180000) {
  try {
    return { ok: true, out: execFileSync(cmd, argv, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: (String(e.stdout || '') + String(e.stderr || e.message)).trim() };
  }
}
const git = (argv, cwd = CACHE) => run('git', argv, cwd);

// --------------------------------------------------------------- cache clone
if (!existsSync(join(CACHE, '.git'))) {
  mkdirSync(dirname(CACHE), { recursive: true });
  rmSync(CACHE, { recursive: true, force: true });
  log('creating update cache…');
  const c = run('git', ['clone', '--quiet', REPO_URL, CACHE], DATA);
  if (!c.ok) { log(`could not clone (offline?): ${c.out.split('\n')[0]}`); process.exit(0); }
}

const fetched = git(['fetch', '--quiet', 'origin']);
if (!fetched.ok) { log(`offline or fetch failed; keeping the installed version.`); process.exit(0); }

const remote = git(['rev-parse', 'origin/main']).out;
const markerPath = join(DATA, '.installed-commit');
const installed = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;

if (installed === remote && !FORCE) {
  log(`already current (${remote.slice(0, 7)})`);
  writeResult({ outcome: 'current', from: installed, to: remote });
  process.exit(0);
}

log(`update available: ${installed ? installed.slice(0, 7) : '(unknown)'} -> ${remote.slice(0, 7)}`);
if (installed) {
  const l = git(['log', '--oneline', `${installed}..${remote}`]);
  if (l.ok) for (const line of l.out.split('\n').filter(Boolean)) log(`    ${line}`);
}
if (CHECK_ONLY) process.exit(installed === remote ? 0 : 10);

git(['reset', '--hard', '--quiet', remote]);

// ------------------------------------------------------------------- apply
// Only what git tracks. A runtime file is untracked by construction, so it is not
// in this list and therefore cannot be overwritten.
const tracked = git(['ls-files']).out.split('\n').map(s => s.trim()).filter(Boolean);
if (!tracked.length) { console.error('FATAL: repo lists no tracked files — refusing to wipe the install.'); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(DATA, 'backups', `update-${stamp}`);
mkdirSync(backup, { recursive: true });

const changed = [];
for (const rel of tracked) {
  const src = join(CACHE, rel);
  const dst = join(DATA, rel);
  if (!existsSync(src)) continue;
  if (existsSync(dst)) {
    if (readFileSync(src).equals(readFileSync(dst))) continue;   // identical, skip
    const b = join(backup, rel);
    mkdirSync(dirname(b), { recursive: true });
    cpSync(dst, b);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { force: true });
  changed.push(rel);
}
log(`updated ${changed.length} file(s)`);

function rollback(why) {
  warn(`rolling back: ${why}`);
  for (const rel of changed) {
    const b = join(backup, rel);
    if (existsSync(b)) cpSync(b, join(DATA, rel), { force: true });
  }
  warn(`restored the previous files from ${backup}`);
}

// New config keys only — your keys, caps and model choices are never rewritten.
mergeConfig();

// ------------------------------------------------------------------ verify
let failed = null;
for (const f of ['shim.mjs', 'probe.mjs']) {
  const p = join(DATA, f);
  if (!existsSync(p)) continue;
  const r = run(process.execPath, ['--check', p], DATA);
  if (!r.ok) failed = `${f} failed syntax check: ${r.out.split('\n')[0]}`;
}
if (!failed && existsSync(join(DATA, 'test-shim.mjs'))) {
  const r = run(process.execPath, [join(DATA, 'test-shim.mjs')], DATA, 600000);
  const tail = r.out.split('\n').filter(Boolean).slice(-1)[0] || '';
  log(`  tests: ${r.ok ? tail : 'FAIL'}`);
  if (!r.ok) failed = `test-shim.mjs failed:\n${r.out.split('\n').slice(-12).join('\n')}`;
}

if (failed) {
  console.error(`\nVERIFICATION FAILED — ${failed}`);
  rollback('verification failed');
  writeResult({ outcome: 'rolled-back', from: installed, to: remote, error: failed, backup });
  process.exit(1);
}

writeFileSync(markerPath, remote + '\n');
if (!NO_RESTART) restartShim();

log(`\nupdated to ${remote.slice(0, 7)} — backup at ${backup}`);
writeResult({ outcome: 'success', from: installed, to: remote, backup, files: changed.length });

// ------------------------------------------------------------------ helpers

/** Add keys the new version introduced; never overwrite a value already set. */
function mergeConfig() {
  const livePath = join(CONFIG, 'config.json');
  const basePath = join(DATA, 'config.default.json');
  if (!existsSync(basePath)) return;
  if (!existsSync(livePath)) {
    mkdirSync(CONFIG, { recursive: true });
    cpSync(basePath, livePath);
    log('config.json created from the shipped default');
    return;
  }
  let live, base;
  try {
    live = JSON.parse(readFileSync(livePath, 'utf8'));
    base = JSON.parse(readFileSync(basePath, 'utf8'));
  } catch (e) { warn(`config merge skipped (unparseable JSON): ${e.message}`); return; }
  const added = [];
  (function merge(dst, src, path = '') {
    for (const [k, v] of Object.entries(src)) {
      const here = path ? `${path}.${k}` : k;
      if (!(k in dst)) { dst[k] = v; added.push(here); }
      else if (v && typeof v === 'object' && !Array.isArray(v) &&
               dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], v, here);
    }
  })(live, base);
  if (added.length) {
    writeFileSync(livePath, JSON.stringify(live, null, 2) + '\n');
    log(`config.json: added ${added.length} new key(s): ${added.join(', ')}`);
  }
}

/** Replace the shim only when it is idle — a mid-request kill costs a live turn. */
function restartShim() {
  const port = (() => {
    try { return JSON.parse(readFileSync(join(CONFIG, 'config.json'), 'utf8')).port || 8788; } catch { return 8788; }
  })();
  const probe = run(process.execPath, ['-e',
    `fetch('http://127.0.0.1:${port}/health').then(r=>console.log(r.status)).catch(()=>process.exit(3))`], DATA, 15000);
  if (!probe.ok) { log('shim not running — it starts on the new code next time'); return; }
  const kill = process.platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -EA SilentlyContinue }`], DATA)
    : run('sh', ['-c', `lsof -ti tcp:${port} | xargs -r kill`], DATA);
  log(kill.ok ? 'shim stopped — it restarts on the new code on next use' : 'could not stop the shim; restart it yourself');
}

function writeResult(o) {
  try {
    writeFileSync(join(DATA, '.last-update.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), ...o }, null, 2) + '\n');
  } catch { /* reporting must not fail the update */ }
}
