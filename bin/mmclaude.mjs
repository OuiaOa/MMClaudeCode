#!/usr/bin/env node
/**
 * mmclaude — portable CLI. One Node entry point so Windows and Linux share the same code; the
 * bash scripts remain as thin Linux conveniences but every command here works on both.
 *
 *   mmclaude setup            first-time setup: key prompt, probe, profile, autostart
 *   mmclaude key minimax      store/replace the MiniMax Token Plan or API key
 *   mmclaude start|stop|status  manage the shim process
 *   mmclaude [run] [args...]  launch Claude Code against the profile (imports on first run).
 *                          `run` is implicit -- bare `mmclaude`, or any args that aren't a known
 *                          subcommand (flags, a prompt), launch it the same way.
 *   mmclaude cap [amount]     show/set the MiniMax daily cap
 *
 * Platform differences are confined to: where the shim's PID/log live, and how it is started
 * in the background (systemd on Linux when available, a detached process otherwise).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { resolveClaude } from './mmclaude-lib.mjs';

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_DIR = process.env.MMCLAUDE_CONFIG_DIR || path.join(HOME, '.config', 'mmclaude');
const DATA_DIR = process.env.MMCLAUDE_DATA_DIR || path.join(HOME, '.local', 'share', 'mmclaude');
const PROFILE_DIR = process.env.MMCLAUDE_PROFILE_DIR || path.join(HOME, '.mmclaude');
const PID_FILE = path.join(DATA_DIR, 'shim.pid');
const LOG_FILE = path.join(DATA_DIR, 'shim.log');

const bold = s => `\x1b[1m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const grn = s => `\x1b[32m${s}\x1b[0m`;
const yel = s => `\x1b[33m${s}\x1b[0m`;
const die = m => { console.error(red(m)); process.exit(1); };

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const cfg = () => readJson(path.join(CONFIG_DIR, 'config.json'), {});
const port = () => process.env.MMCLAUDE_PORT || cfg().port || 8788;

const PROVIDERS = {
  minimax: { file: 'key', label: 'MiniMax', verify: 'https://www.minimax.io/v1/token_plan/remains' },
};

// ------------------------------------------------------------- hidden key input

/** Reads a secret without echoing. Works on Windows and POSIX; never touches argv or history. */
function promptSecret(label) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (ch) => {
      const s = ch.toString();
      if (s === '\r' || s === '\n' || s === '') process.stdout.write('\n');
      else process.stdout.write('');            // swallow the echo
    };
    process.stdin.on('data', onData);
    rl.question(`${label} API key: `, (ans) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      resolve(ans.replace(/[\r\n\t ]/g, ''));
    });
    if (rl.output.isTTY) rl.output.write = (function (w) {
      return function (str, ...a) { if (typeof str === 'string' && str.includes('API key:')) return w.call(this, str, ...a); return true; };
    })(rl.output.write);
  });
}

async function cmdKey(provider) {
  const p = PROVIDERS[provider];
  if (!p) die(`unknown provider '${provider}'. Use: ${Object.keys(PROVIDERS).join(' | ')}`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  console.log(`\n${bold(p.label + ' API key')}\nPaste it and press enter. Input is hidden.\n`);
  const key = await promptSecret(p.label);
  if (!key) die('Empty input, nothing written.');
  const dest = path.join(CONFIG_DIR, p.file);
  fs.writeFileSync(dest, key, { mode: 0o600 });
  try { fs.chmodSync(dest, 0o600); } catch { /* best effort on Windows */ }
  console.log(bold(`Stored in ${dest}`));
  process.stdout.write('Verifying... ');
  try {
    const r = await fetch(p.verify, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    console.log(r.ok ? grn(`OK (HTTP ${r.status})`) : red(`FAILED (HTTP ${r.status})`));
    if (!r.ok) console.log(yel('The key was still written. Re-run to replace it.'));
  } catch (e) { console.log(red(`FAILED (${e.message})`)); }
}

// ------------------------------------------------------------------ shim control

function shimRunning() {
  const pid = parseInt(readJson(PID_FILE) ?? fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (!Number.isFinite(pid)) return 0;
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

function systemdAvailable() {
  if (WIN) return false;
  return spawnSync('systemctl', ['--user', 'is-enabled', 'mmclaude-shim.service'], { stdio: 'ignore' }).status === 0;
}

async function health(ms = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port()}/_mmclaude/health`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

async function cmdStart({ quiet = false } = {}) {
  if (await health()) { if (!quiet) console.log('shim already running'); return true; }
  if (systemdAvailable()) {
    spawnSync('systemctl', ['--user', 'start', 'mmclaude-shim.service'], { stdio: 'ignore' });
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'shim.mjs')], {
      detached: true, stdio: ['ignore', out, out],
      env: { ...process.env },
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
  }
  for (let i = 0; i < 30; i++) { if (await health(800)) { if (!quiet) console.log('shim started'); return true; } await new Promise(r => setTimeout(r, 300)); }
  console.error(red(`shim did not come up on 127.0.0.1:${port()}`));
  console.error(`  log: ${LOG_FILE}`);
  return false;
}

function cmdStop() {
  if (systemdAvailable()) { spawnSync('systemctl', ['--user', 'stop', 'mmclaude-shim.service'], { stdio: 'inherit' }); return; }
  const pid = shimRunning();
  if (!pid) { console.log('shim not running'); return; }
  try { process.kill(pid, WIN ? undefined : 'SIGTERM'); console.log(`stopped (pid ${pid})`); } catch (e) { console.error(e.message); }
}

async function cmdStatus() {
  const up = await health();
  console.log(`shim      : ${up ? grn('running') : red('not running')} on 127.0.0.1:${port()}`);
  console.log(`autostart : ${systemdAvailable() ? 'systemd --user' : (WIN ? 'launcher-managed' : 'launcher-managed')}`);
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const f = path.join(CONFIG_DIR, p.file);
    console.log(`${name.padEnd(10)}: ${fs.existsSync(f) && fs.statSync(f).size ? 'key stored' : 'not set'}`);
  }
}

// ------------------------------------------------------------------------ auto-update

/**
 * Checks GitHub for a newer commit and applies it automatically, bounded so a slow or
 * unreachable network never meaningfully delays startup: --check is a single `git fetch`
 * (fast — 15s is generous, and covers the one-time initial clone if the update cache doesn't
 * exist yet) with no local mutation; the full update (reset + copy + test suite + restart)
 * only runs when one is actually available, with more generous headroom since it only pays
 * that cost on a real update, not every launch. Both timeouts fail SAFE: mmclaude-update.mjs
 * itself already treats "offline" as "keep the installed version" (exit 0, not an error), and
 * a killed/timed-out check here is treated identically — this must never block using the tool.
 */
function autoUpdateCheck() {
  const updater = path.join(DATA_DIR, 'bin', 'mmclaude-update.mjs');
  if (!fs.existsSync(updater)) return;   // portable/tarball install predating the updater
  const check = spawnSync(process.execPath, [updater, '--check'], { stdio: 'ignore', timeout: 15000 });
  if (check.status === 10) {
    console.error('mmclaude: update available — applying...');
    const apply = spawnSync(process.execPath, [updater], { stdio: 'inherit', timeout: 120000 });
    if (apply.status !== 0) console.error('mmclaude: auto-update failed; continuing with the current version');
  }
}

// ------------------------------------------------------------------------ run

async function cmdRun(rest) {
  if (!fs.existsSync(path.join(CONFIG_DIR, 'key'))) die("No MiniMax key stored. Run: mmclaude setup");
  if (!fs.existsSync(path.join(PROFILE_DIR, 'settings.json'))) die('Profile missing. Run: mmclaude setup');

  autoUpdateCheck();
  if (!await cmdStart({ quiet: true })) process.exit(1);

  // Pull across memories, transcripts and permissions (scrubbed so they resume). --source
  // <path> propagates into the importer (handled below as a mmclaude flag, then stripped before
  // we hand the rest to claude).
  //
  // This used to be gated behind a one-time .imported marker — ran exactly once, ever, so any
  // Claude Code session created after the very first `mmclaude run` was never picked up again.
  // mmclaude-import is incremental by default now (a per-file manifest skips anything unchanged),
  // so it's cheap enough to run --auto on every launch instead; --quiet keeps a normal launch
  // silent when nothing changed. A failed import no longer aborts the whole run — you can
  // still use the tool with whatever was imported last time.
  const sourceArg = parseSource(rest);
  const srcDefault = path.join(HOME, '.claude', 'projects');
  if (fs.existsSync(srcDefault) || sourceArg.length > 0) {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, 'bin', 'mmclaude-import'), '--auto', '--quiet', ...sourceArg],
      { stdio: 'inherit', env: { ...process.env, MMCLAUDE_HOME: HOME, MMCLAUDE_PROFILE: PROFILE_DIR } });
    if (r.status !== 0) console.error('mmclaude: import failed; continuing without it');
  }

  // Resolve the Claude Code binary. On Windows this honours PATHEXT (so a `claude.exe`
  // installed outside npm works), and falls back to common install locations if PATH
  // is unset. See bin/mmclaude-lib.mjs for the resolver.
  let claude;
  try { claude = resolveClaude(); }
  catch (e) { die(e.message); }
  // Filter --source out of the args we hand to claude (it's a mmclaude flag, not a claude one).
  const claudeArgs = stripSource(rest);

  // Build the child env. Start from the parent env, then explicitly UNSET the two
  // env vars Claude Code uses to detect "I am inside Claude Code" so the child
  // announces itself as a foreground interactive session instead of a background
  // job, and add the override that lets nested sessions persist in --resume.
  //
  // No documented env var disables the "I'm a background task" announcement; the
  // detection is hard-coded against CLAUDECODE / CLAUDE_CODE_CHILD_SESSION /
  // parent-process checks (verified against code.claude.com/docs/en/env-vars.md
  // and issue #83830). Stripping both + using acceptEdits mode (see setup) gets
  // us as close to "foreground interactive" as the docs allow for a shim launch.
  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_CHILD_SESSION;
  childEnv.CLAUDE_CONFIG_DIR = PROFILE_DIR;
  childEnv.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  // Silence the direct api.anthropic.com telemetry/version-check probe that
  // bypasses ANTHROPIC_BASE_URL and would fail with the sentinel auth token.
  childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

  // CONFIRMED LIVE BUG, fixed 2026-08-13: resolveClaude() deliberately returns the bare
  // string 'claude' on Windows (see mmclaude-lib.mjs) so cmd.exe's PATHEXT resolves it to
  // claude.cmd/.exe -- but that resolution is a SHELL feature. Without a shell here, Node
  // calls CreateProcess directly (bypassing cmd.exe entirely), so a bare 'claude' with no
  // bundled binary present threw `spawn claude ENOENT` on every Windows machine using a
  // PATH-installed (npm .cmd wrapper) Claude Code -- reproduced live on PC-4D.
  //
  // `shell: true` with a separate args ARRAY makes Node just concatenate them unescaped
  // (DEP0190) -- passing ONE pre-quoted command STRING instead is the documented way to
  // avoid that while still going through cmd.exe for the .cmd/.bat PATHEXT resolution.
  const settingsArg = path.join(PROFILE_DIR, 'settings.json');
  const quoteForCmd = (a) => /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
  const commandLine = WIN
    ? [claude, '--settings', settingsArg, ...claudeArgs].map(quoteForCmd).join(' ')
    : claude;
  const spawnArgs = WIN ? [] : ['--settings', settingsArg, ...claudeArgs];
  const child = spawn(commandLine, spawnArgs, { stdio: 'inherit', env: childEnv, shell: WIN });
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
  process.exit(code);
}

// --source <path>  or  --source=<path>  — return the argv slice to forward.
function parseSource(argv) {
  const i = argv.indexOf('--source');
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return [argv[i], argv[i + 1]];
  const eq = argv.find(a => a.startsWith('--source='));
  if (eq) return [eq];
  return [];
}

// Strip --source (and its value) from an argv list, so it isn't handed to claude.
function stripSource(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') { i++; continue; }                  // skip flag + value
    if (typeof a === 'string' && a.startsWith('--source=')) continue;
    out.push(a);
  }
  return out;
}

// ------------------------------------------------------------------------ caps

function capCmd(rest) {
  const amount = rest[0];
  const file = path.join(CONFIG_DIR, 'cap');
  const fallback = cfg().cap?.dailyUsd ?? 0;
  if (amount === undefined) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : String(fallback);
    console.log(`MiniMax local dollar cap: $${cur} (Token Plan quota is authoritative)`);
    return;
  }
  if (!/^\d+(\.\d+)?$/.test(amount)) die(`'${amount}' is not a non-negative number`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, amount);
  if (parseFloat(amount) === 0) console.log(yel('0 is read as DISABLED (unlimited), not a $0 limit. Use 0.01 for a hard stop.'));
  else console.log(`MiniMax local dollar cap set to $${amount}. Token Plan usage remains authoritative.`);
}

// ------------------------------------------------------------------------ main

function help(topic) {
  const H = {
    setup: `${bold('mmclaude setup')} [--rekey] [--reprobe]

First-time setup. Prompts for your MiniMax API key (hidden — never echoed, never in argv or
shell history), probes the MiniMax endpoint, writes the isolated Claude Code profile, and starts
the shim. MiniMax M3 receives image and video blocks natively; no vision sidecar key is needed.

  --rekey       replace the stored MiniMax key (also re-probes — a new key/account could
                behave differently)
  --reprobe     force a fresh endpoint probe even if a cached result already exists

The probe (a few cents, but several minutes — it times real API calls at every effort level)
only runs once and is cached; re-running setup later (e.g. to pick up a new feature) skips it
by default instead of re-measuring something that hasn't changed.

Safe to re-run: an existing config.json is never overwritten.`,

    key: `${bold('mmclaude key <provider>')}

Store or replace an API key. Input is hidden and the key is verified against the provider
immediately, so a mangled paste fails now rather than at first use.

  minimax     required — the MiniMax Token Plan or standard API key

Keys are written 0600 into ~/.config/mmclaude/ and never enter Claude Code's environment;
Claude Code authenticates to the local shim with a separate generated sentinel.`,

    run: `${bold('mmclaude run')} [claude arguments...]  (also just ${bold('mmclaude')} -- 'run' is the default)

Launch Claude Code against the MiniMax profile. Everything after 'run' is passed through:

  mmclaude                               normal session -- same as 'mmclaude run'
  mmclaude run --effort ultracode        xhigh effort + workflow orchestration
  mmclaude run --resume                  resume this directory's most recent session
  mmclaude run -p "explain this repo"    one-shot

Imported and prior sessions show up the normal Claude Code way -- the in-session switcher
(left arrow) and --resume both read the same history; nothing special is needed to reach them.

Starts the shim if it is not already up. On first run, imports your existing memories,
transcripts and permissions from ~/.claude (see mmclaude-import).

Effort is chosen per task: the default main turn uses M3 without thinking; Fable/Opus use M3
thinking; Sonnet uses M2.7 thinking; Haiku and helper/background work use the faster M2.x tiers.
Ultracode and swarm fan-out remain enabled, but the shim queues and paces helper calls for Token
Plan safety.

Screenshots and supported video blocks are passed directly to MiniMax M3.`,

    cap: `${bold('mmclaude cap')} [amount]

Optional local dollar cap. It is disabled by default because MiniMax Token Plan quota is the
authoritative limit. With no amount, shows the current local cap.

  mmclaude cap              show the MiniMax cap
  mmclaude cap 10           set it to $10/day
Note: 0 means DISABLED (unlimited).`,

    status: `${bold('mmclaude status')}

Shows whether the shim is running, how it is started (systemd where available, otherwise on
demand from 'mmclaude run'), and which provider keys are stored. Never prints key material.`,
  };
  if (topic && H[topic]) { console.log('\n' + H[topic] + '\n'); return; }
  console.log(`
${bold('mmclaude')} — Claude Code driven by MiniMax M3 (native multimodal)

${bold('SETUP')}
  mmclaude setup                  first-time setup: key, probe, profile, autostart
  mmclaude key <provider>         store a key (${Object.keys(PROVIDERS).join(', ')})

${bold('USE')}
  mmclaude run [claude args]      launch Claude Code against the profile
  mmclaude run --effort ultracode full fan-out
  mmclaude run --resume           resume this directory's last session

${bold('USAGE')}
  mmclaude cap [amount]           optional local dollar cap (Token Plan is authoritative)
  mmclaude-usage                  token usage, burn rate, live Token Plan snapshot

${bold('SERVICE')}
  mmclaude start | stop | status  manage the local shim
  mmclaude-import [--force]       re-import memories/transcripts from ~/.claude

${bold('HELP')}
  mmclaude help <command>         detail on setup, key, run, cap, status

Your normal 'claude' is untouched: this uses a separate profile at ~/.mmclaude and never
reads your Anthropic credentials.
`);
}

const KNOWN_COMMANDS = ['key', 'start', 'stop', 'status', 'run', 'cap', 'import', 'setup', 'help'];
const HELP_FLAGS = ['help', '--help', '-h', '-help'];
const [rawCmd, ...rawRest] = process.argv.slice(2);
// Bare `mmclaude` (no subcommand), or any first token that isn't one of mmclaude's OWN literal
// subcommand words, means "launch Claude Code" -- the whole point of this tool day-to-day.
// That includes a genuine typo of a subcommand ('mmclaude ruun') -- it gets forwarded to claude
// as an argument and claude reports the unrecognised-argument error itself, rather than mmclaude
// needing its own duplicate notion of what a "valid" trailing argument looks like.
const looksLikeRunArgs = !HELP_FLAGS.includes(rawCmd) &&
  (rawCmd === undefined || rawCmd.startsWith('-') || !KNOWN_COMMANDS.includes(rawCmd));
const [cmd, ...rest] = looksLikeRunArgs ? ['run', ...process.argv.slice(2)] : [rawCmd, ...rawRest];
switch (cmd) {
  case 'key':    await cmdKey(rest[0]); break;
  case 'start':  await cmdStart(); break;
  case 'stop':   cmdStop(); break;
  case 'status': await cmdStatus(); break;
  case 'run':    await cmdRun(rest); break;
  case 'cap':    capCmd(rest); break;
  case 'import': {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'mmclaude-import'), ...rest], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }
  case 'setup':
    // CONFIRMED LIVE BUG, fixed 2026-08-13: only cmdRun() called autoUpdateCheck(), so
    // `mmclaude setup` (no prior `mmclaude run` on this machine — the exact shape of a fresh
    // install) could run whatever code happened to be on disk at that moment, missing a
    // fix that landed on GitHub in between. Confirmed on Work-PC: a reroute ran against
    // stale bin/mmclaude-setup.mjs, silently missing the statusLine/effortLevel/deny-list
    // extras a slightly newer commit had already added (env alone still worked, since
    // that part of the code was unchanged) -- required a manual re-apply to fix. Setup
    // is exactly the command a fresh install runs before ever calling `mmclaude run` once,
    // so it needs its own update check, not a reliance on run's.
    autoUpdateCheck();
    spawnSync(process.execPath, [path.join(ROOT, 'bin', 'mmclaude-setup.mjs'), ...rest], { stdio: 'inherit' });
    break;
  case 'help': case '--help': case '-h': case '-help':
    help(rest[0]); break;
  default:
    console.error(red(`unknown command '${cmd}'`));
    help(); process.exit(1);
}
