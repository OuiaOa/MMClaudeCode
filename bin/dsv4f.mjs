#!/usr/bin/env node
/**
 * dsv4f — portable CLI. One Node entry point so Windows and Linux share the same code; the
 * bash scripts remain as thin Linux conveniences but every command here works on both.
 *
 *   dsv4f setup            first-time setup: key prompt, probe, profile, autostart
 *   dsv4f key <provider>   store/replace an API key (deepseek | deepinfra | openrouter)
 *   dsv4f start|stop|status  manage the shim process
 *   dsv4f run [args...]    launch Claude Code against the profile (imports on first run)
 *   dsv4f cap [amount]     show/set the DeepSeek daily cap
 *   dsv4f cap vision [amt] show/set the vision daily cap
 *
 * Platform differences are confined to: where the shim's PID/log live, and how it is started
 * in the background (systemd on Linux when available, a detached process otherwise).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_DIR = process.env.DSV4F_CONFIG_DIR || path.join(HOME, '.config', 'claude-dsv4f');
const DATA_DIR = process.env.DSV4F_DATA_DIR || path.join(HOME, '.local', 'share', 'claude-dsv4f');
const PROFILE_DIR = path.join(HOME, '.claude-dsv4f');
const PID_FILE = path.join(DATA_DIR, 'shim.pid');
const LOG_FILE = path.join(DATA_DIR, 'shim.log');

const bold = s => `\x1b[1m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const grn = s => `\x1b[32m${s}\x1b[0m`;
const yel = s => `\x1b[33m${s}\x1b[0m`;
const die = m => { console.error(red(m)); process.exit(1); };

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const cfg = () => readJson(path.join(CONFIG_DIR, 'config.json'), {});
const port = () => process.env.DSV4F_PORT || cfg().port || 8788;

const PROVIDERS = {
  deepseek:   { file: 'key',            label: 'DeepSeek',   verify: 'https://api.deepseek.com/user/balance' },
  deepinfra:  { file: 'deepinfra-key',  label: 'DeepInfra',  verify: 'https://api.deepinfra.com/v1/openai/models' },
  openrouter: { file: 'openrouter-key', label: 'OpenRouter', verify: 'https://openrouter.ai/api/v1/key' },
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
  return spawnSync('systemctl', ['--user', 'is-enabled', 'claude-dsv4f-shim.service'], { stdio: 'ignore' }).status === 0;
}

async function health(ms = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port()}/_dsv4f/health`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

async function cmdStart({ quiet = false } = {}) {
  if (await health()) { if (!quiet) console.log('shim already running'); return true; }
  if (systemdAvailable()) {
    spawnSync('systemctl', ['--user', 'start', 'claude-dsv4f-shim.service'], { stdio: 'ignore' });
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
  if (systemdAvailable()) { spawnSync('systemctl', ['--user', 'stop', 'claude-dsv4f-shim.service'], { stdio: 'inherit' }); return; }
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

// ------------------------------------------------------------------------ run

async function cmdRun(rest) {
  if (!fs.existsSync(path.join(CONFIG_DIR, 'key'))) die("No DeepSeek key stored. Run: dsv4f setup");
  if (!fs.existsSync(path.join(PROFILE_DIR, 'settings.json'))) die('Profile missing. Run: dsv4f setup');
  if (!await cmdStart({ quiet: true })) process.exit(1);

  // First run: pull across memories, transcripts and permissions (scrubbed so they resume).
  if (!fs.existsSync(path.join(PROFILE_DIR, '.imported')) && fs.existsSync(path.join(HOME, '.claude', 'projects'))) {
    console.error('dsv4f: first run — importing existing Claude Code state...');
    spawnSync(process.execPath, [path.join(ROOT, 'bin', 'dsv4f-import')], { stdio: 'inherit' });
  }

  const r = spawnSync(WIN ? 'claude.cmd' : 'claude',
    ['--settings', path.join(PROFILE_DIR, 'settings.json'), ...rest],
    { stdio: 'inherit', env: { ...process.env, CLAUDE_CONFIG_DIR: PROFILE_DIR }, shell: WIN });
  process.exit(r.status ?? 0);
}

// ------------------------------------------------------------------------ caps

function capCmd(rest) {
  const vision = rest[0] === 'vision';
  const amount = vision ? rest[1] : rest[0];
  const file = path.join(CONFIG_DIR, vision ? 'vision-cap' : 'cap');
  const fallback = vision ? (cfg().vision?.dailyCapUsd ?? 1.5) : (cfg().cap?.dailyUsd ?? 5);
  if (amount === undefined) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : String(fallback);
    console.log(`${vision ? 'Vision' : 'DeepSeek'} daily cap: $${cur} (UTC day)`);
    return;
  }
  if (!/^\d+(\.\d+)?$/.test(amount)) die(`'${amount}' is not a non-negative number`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, amount);
  if (parseFloat(amount) === 0) console.log(yel('0 is read as DISABLED (unlimited), not a $0 limit. Use 0.01 for a hard stop.'));
  else console.log(`${vision ? 'Vision' : 'DeepSeek'} daily cap set to $${amount}.`);
}

// ------------------------------------------------------------------------ main

function help(topic) {
  const H = {
    setup: `${bold('dsv4f setup')} [--rekey] [--no-vision]

First-time setup. Prompts for your DeepSeek API key (hidden — never echoed, never in argv or
shell history), offers an optional DeepInfra key for screenshots, probes the endpoint to
calibrate itself against what it actually does, writes the isolated Claude Code profile, and
starts the shim.

  --rekey       replace the stored DeepSeek key
  --no-vision   skip the DeepInfra prompt entirely

Safe to re-run: an existing config.json is never overwritten.`,

    key: `${bold('dsv4f key <provider>')}

Store or replace an API key. Input is hidden and the key is verified against the provider
immediately, so a mangled paste fails now rather than at first use.

  deepseek     required — the coding model
  deepinfra    optional — vision, for screenshots. DeepSeek cannot accept images, so they are
               transcribed to text first. Without it, images degrade to a clear note.
  openrouter   optional — alternative vision provider

Keys are written 0600 into ~/.config/claude-dsv4f/ and never enter Claude Code's environment;
Claude Code authenticates to the local shim with a separate generated sentinel.`,

    run: `${bold('dsv4f run')} [claude arguments...]

Launch Claude Code against the DeepSeek profile. Everything after 'run' is passed through:

  dsv4f run                          normal session
  dsv4f run --effort ultracode       xhigh effort + workflow orchestration
  dsv4f run --resume                 resume this directory's most recent session
  dsv4f run -p "explain this repo"   one-shot

Starts the shim if it is not already up. On first run, imports your existing memories,
transcripts and permissions from ~/.claude (see dsv4f-import).

Effort is chosen per task: background calls run with thinking off, routine turns at high,
detected-hard turns at ultra, and 'ultrathink' or ultracode at max. A level you set
explicitly with /effort is never overridden.

Screenshots: say what you need from the image, or write 'VISION: <what to look for>', and the
transcription is directed accordingly.`,

    cap: `${bold('dsv4f cap')} [amount] | ${bold('dsv4f cap vision')} [amount]

Daily spend caps, enforced per provider on a rolling UTC day. With no amount, shows the
current cap.

  dsv4f cap              show the DeepSeek cap
  dsv4f cap 10           set it to $10/day
  dsv4f cap vision 3     set the vision cap to $3/day

At the cap the shim refuses new requests with a clear error rather than a retryable status.
Cached image descriptions keep working past the vision cap, since replaying them costs nothing.

Note: 0 means DISABLED (unlimited), not a $0 limit. For a hard stop use 0.01.`,

    status: `${bold('dsv4f status')}

Shows whether the shim is running, how it is started (systemd where available, otherwise on
demand from 'dsv4f run'), and which provider keys are stored. Never prints key material.`,
  };
  if (topic && H[topic]) { console.log('\n' + H[topic] + '\n'); return; }
  console.log(`
${bold('dsv4f')} — Claude Code driven by DeepSeek V4 Flash 0731

${bold('SETUP')}
  dsv4f setup                  first-time setup: key, probe, profile, autostart
  dsv4f key <provider>         store a key (${Object.keys(PROVIDERS).join(', ')})

${bold('USE')}
  dsv4f run [claude args]      launch Claude Code against the profile
  dsv4f run --effort ultracode full fan-out
  dsv4f run --resume           resume this directory's last session

${bold('SPEND')}
  dsv4f cap [amount]           DeepSeek daily cap        (default $5)
  dsv4f cap vision [amount]    vision daily cap          (default $1.50)
  dsv4f-usage                  spend, burn rate, balance
  dsv4f-usage --reconcile      cross-check the ledger against balance drawdown

${bold('SERVICE')}
  dsv4f start | stop | status  manage the local shim
  dsv4f-import [--force]       re-import memories/transcripts from ~/.claude

${bold('HELP')}
  dsv4f help <command>         detail on setup, key, run, cap, status

Your normal 'claude' is untouched: this uses a separate profile at ~/.claude-dsv4f and never
reads your Anthropic credentials.
`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'key':    await cmdKey(rest[0]); break;
  case 'start':  await cmdStart(); break;
  case 'stop':   cmdStop(); break;
  case 'status': await cmdStatus(); break;
  case 'run':    await cmdRun(rest); break;
  case 'cap':    capCmd(rest); break;
  case 'setup':  spawnSync(process.execPath, [path.join(ROOT, 'bin', 'dsv4f-setup.mjs'), ...rest], { stdio: 'inherit' }); break;
  case 'help': case '--help': case '-h': case '-help': case undefined:
    help(rest[0]); break;
  default:
    console.error(red(`unknown command '${cmd}'`));
    help(); process.exit(1);
}
