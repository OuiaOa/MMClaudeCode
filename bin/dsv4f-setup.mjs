#!/usr/bin/env node
/**
 * Cross-platform first-time setup: key, probe, profile, autostart.
 *
 * On Linux with systemd this installs a --user unit. Elsewhere (Windows, or a systemd-less
 * Linux) the shim is started on demand by `dsv4f run`, which is why there is no service to
 * install there — one less thing to break, at the cost of a ~1s first launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_DIR = process.env.DSV4F_CONFIG_DIR || path.join(HOME, '.config', 'claude-dsv4f');
const DATA_DIR = process.env.DSV4F_DATA_DIR || path.join(HOME, '.local', 'share', 'claude-dsv4f');
const PROFILE_DIR = path.join(HOME, '.claude-dsv4f');

const bold = s => `\x1b[1m${s}\x1b[0m`;
const yel = s => `\x1b[33m${s}\x1b[0m`;
const node = process.execPath;

for (const d of [CONFIG_DIR, DATA_DIR, PROFILE_DIR]) fs.mkdirSync(d, { recursive: true });
try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* Windows */ }

// config.json ships with the package; copy it in on first setup, never overwrite a tuned one.
const cfgPath = path.join(CONFIG_DIR, 'config.json');
if (!fs.existsSync(cfgPath)) fs.copyFileSync(path.join(ROOT, 'config.default.json'), cfgPath);

// sentinel: what Claude Code presents to the shim, so the real key never enters its environment
const sentinelPath = path.join(CONFIG_DIR, 'sentinel');
if (!fs.existsSync(sentinelPath) || !fs.readFileSync(sentinelPath, 'utf8').trim()) {
  const { randomBytes } = await import('node:crypto');
  fs.writeFileSync(sentinelPath, randomBytes(24).toString('base64').replace(/[/+=]/g, ''), { mode: 0o600 });
}
const SENTINEL = fs.readFileSync(sentinelPath, 'utf8').trim();

// key
if (!fs.existsSync(path.join(CONFIG_DIR, 'key')) || process.argv.includes('--rekey')) {
  const r = spawnSync(node, [path.join(ROOT, 'bin', 'dsv4f.mjs'), 'key', 'deepseek'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!fs.readFileSync(path.join(CONFIG_DIR, 'key'), 'utf8').trim()) { console.error('No key stored.'); process.exit(1); }

// DeepInfra is optional: it only powers screenshots. Machines that never paste images do not
// need it, and skipping leaves image handling to degrade with a clear note rather than fail.
if (!fs.existsSync(path.join(CONFIG_DIR, 'deepinfra-key')) && !process.argv.includes('--no-vision')) {
  console.log(`\n${bold('Screenshots (optional)')}`);
  console.log('DeepSeek cannot accept images, so screenshots are transcribed by a vision model');
  console.log('on DeepInfra. Skip this if you will not paste screenshots on this machine —');
  console.log('you can add it later with: dsv4f key deepinfra\n');
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const want = await new Promise(res => rl.question('Add a DeepInfra key now? [y/N] ', a => { rl.close(); res(a.trim().toLowerCase()); }));
  if (want === 'y' || want === 'yes') {
    spawnSync(node, [path.join(ROOT, 'bin', 'dsv4f.mjs'), 'key', 'deepinfra'], { stdio: 'inherit' });
  } else {
    console.log(yel('Skipped — screenshots will report that vision is unconfigured.'));
  }
}

// probe — calibrates the shim against what the endpoint actually does
console.log(bold('\nProbing endpoint behaviour...'));
spawnSync(node, [path.join(ROOT, 'probe.mjs')], { stdio: 'inherit' });

// profile
const port = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).port || 8788;
const statusline = WIN ? undefined : { type: 'command', command: path.join(ROOT, 'statusline.sh'), refreshInterval: 10 };

// deny-list.sh ships with the package (a PreToolUse guardrail — bypassPermissions mode has
// no other check on destructive commands) but never overwrite a hand-tuned copy, matching
// how config.json is handled below.
const denyListDst = path.join(PROFILE_DIR, 'deny-list.sh');
const denyListSrc = path.join(ROOT, 'deny-list.sh');
if (!WIN && fs.existsSync(denyListSrc) && !fs.existsSync(denyListDst)) {
  fs.copyFileSync(denyListSrc, denyListDst);
  try { fs.chmodSync(denyListDst, 0o755); } catch { /* no-op on Windows filesystems */ }
}

const settings = {
  env: {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: SENTINEL,
    ANTHROPIC_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash-bg',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4-flash-bg',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash-sub',
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-v4-flash',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DeepSeek V4 Flash 0731',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
    // The auto-mode fast-mode availability probe and the main-classifier fallback both call
    // api.anthropic.com directly regardless of ANTHROPIC_BASE_URL, per llm-gateway-connect.md
    // — there is no Anthropic account behind this profile to answer them, so disable the
    // paths that would otherwise stall or fail against it. Point what auto-mode classifying
    // DOES run through the shim at the cheap background sentinel instead of full price.
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_TWO_STAGE_CLASSIFIER: '0',
    CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'deepseek-v4-flash-bg',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '384000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
    API_TIMEOUT_MS: '900000',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '900000',
  },
  effortLevel: 'high',
  skipWebFetchPreflight: true,
  // 'bypassPermissions' (skip everything) — there is no Anthropic classifier reachable
  // behind the local shim, so any other mode would either constantly prompt (default) or
  // hang on a classifier that calls api.anthropic.com directly (auto/acceptEdits). This
  // is the documented "I trust this model" mode. To fall back to prompt-on-tool-call,
  // change this to 'acceptEdits' (auto-approves common fs ops) or 'default' (manual).
  permissions: { defaultMode: 'bypassPermissions' },
  ...(statusline ? { statusLine: statusline } : {}),
  ...(fs.existsSync(denyListDst) ? {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${denyListDst}`, timeout: 5 }] }] },
  } : {}),
};

const sPath = path.join(PROFILE_DIR, 'settings.json');
if (!fs.existsSync(sPath)) {
  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(bold(`Wrote ${sPath}`));
} else {
  // Re-running setup (a "reinstall", or picking up a new dsv4f version's defaults) used to
  // blindly overwrite this file, silently destroying anything hand-tuned in it — including,
  // on at least one box, the statusLine and deny-list hook wiring themselves, which existed
  // there only because an earlier session added them directly rather than through this
  // script. Merge new/missing keys in instead; never touch a key that's already set,
  // including nested ones (a new env var lands even if `env` itself is already customized).
  let live;
  try { live = JSON.parse(fs.readFileSync(sPath, 'utf8').replace(/^﻿/, '')); }
  catch (e) { console.error(yel(`settings.json merge skipped (unparseable JSON): ${e.message}`)); live = null; }
  if (live) {
    const added = [];
    (function merge(dst, src, keyPath = '') {
      for (const [k, v] of Object.entries(src)) {
        const here = keyPath ? `${keyPath}.${k}` : k;
        if (!(k in dst)) { dst[k] = v; added.push(here); }
        else if (v && typeof v === 'object' && !Array.isArray(v) &&
                 dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], v, here);
      }
    })(live, settings);
    // hooks.PreToolUse is an array — the generic merge above only fills it in when missing
    // entirely. If it already exists (from an earlier setup, or the user's own hook), check
    // for our specific entry by command string and append rather than duplicate or clobber.
    if (fs.existsSync(denyListDst)) {
      live.hooks ??= {};
      live.hooks.PreToolUse ??= [];
      const already = live.hooks.PreToolUse.some(h =>
        Array.isArray(h?.hooks) && h.hooks.some(hh => String(hh?.command || '').includes('deny-list.sh')));
      if (!already) {
        live.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${denyListDst}`, timeout: 5 }] });
        added.push('hooks.PreToolUse[deny-list]');
      }
    }
    if (added.length) {
      fs.writeFileSync(sPath, JSON.stringify(live, null, 2) + '\n');
      console.log(bold(`${sPath}: added ${added.length} new key(s): ${added.join(', ')}`));
    } else {
      console.log(`${sPath}: already up to date`);
    }
  }
}
try { fs.chmodSync(sPath, 0o600); } catch { /* Windows */ }   // embeds the sentinel

// autostart
if (!WIN && spawnSync('systemctl', ['--user', '--version'], { stdio: 'ignore' }).status === 0) {
  const unitDir = path.join(HOME, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'claude-dsv4f-shim.service'),
`[Unit]
Description=claude-dsv4f shim (Claude Code -> DeepSeek V4 Flash)
After=network-online.target

[Service]
Type=simple
ExecStart=${node} ${path.join(ROOT, 'shim.mjs')}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`);
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'enable', '--now', 'claude-dsv4f-shim.service'], { stdio: 'ignore' });
  console.log('systemd --user service installed and started');
} else {
  console.log(yel('No systemd — the shim starts on demand when you run `dsv4f run`.'));
}

spawnSync(node, [path.join(ROOT, 'bin', 'dsv4f.mjs'), 'start'], { stdio: 'inherit' });

// ------------------------------------------------------ existing-state scan
// Look in ~/.claude (the standard Claude Code data directory) for projects, memories and
// portable config (agents/skills/commands/output-styles). If any of those exist, offer to
// import them now so the user does not have to discover `dsv4f-import` later. This is the
// behaviour the README described and that users were expecting.
const scanSrc = path.join(HOME, '.claude');
const scanProjects = (() => {
  try {
    const p = path.join(scanSrc, 'projects');
    return fs.readdirSync(p).filter(n => !n.includes('claude-dsv4f'));
  } catch { return []; }
})();
const scanMemory = (() => {
  let n = 0;
  try {
    for (const proj of scanProjects) {
      try { n += fs.readdirSync(path.join(scanSrc, 'projects', proj, 'memory')).length; } catch {}
    }
  } catch {}
  return n;
})();
const scanPortable = ['agents', 'skills', 'commands', 'output-styles', 'CLAUDE.md'].filter(d =>
  fs.existsSync(path.join(scanSrc, d))
);

if (scanProjects.length || scanMemory > 0 || scanPortable.length) {
  const items = [];
  if (scanProjects.length) items.push(`${scanProjects.length} project${scanProjects.length === 1 ? '' : 's'}`);
  if (scanMemory > 0) items.push(`${scanMemory} memory file${scanMemory === 1 ? '' : 's'}`);
  if (scanPortable.length) items.push(`${scanPortable.length} portable config item${scanPortable.length === 1 ? '' : 's'}`);
  console.log(bold(`\nExisting Claude Code state detected: ${items.join(', ')} at ${scanSrc}`));

  // In TTY mode, ask. In non-interactive (CI, scripted), skip with a notice -- the user can
  // run `dsv4f-import` explicitly if they want it.
  const TTY = process.stdin.isTTY && process.stdout.isTTY;
  let doImport = !TTY;
  if (TTY) {
    const rl = (await import('node:readline')).default.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(res => rl.question('Import now? [Y/n] ', a => { rl.close(); res(a.trim().toLowerCase()); }));
    doImport = (ans === '' || ans === 'y' || ans === 'yes');
  }
  if (doImport) {
    const args = [];
    if (!TTY) args.push('--all');          // non-interactive: import everything, no picker
    const r = spawnSync(node, [path.join(ROOT, 'bin', 'dsv4f-import'), ...args], { stdio: 'inherit' });
    if (r.status !== 0) console.error(yel(`Import returned ${r.status}; you can retry with: dsv4f-import --force`));
  } else {
    console.log(yel('Skipped. Run later: dsv4f-import'));
  }
}

console.log(`\n${bold('Setup complete.')}

  dsv4f run                 launch Claude Code
  dsv4f run --effort ultracode
  dsv4f status              shim + stored keys
  dsv4f cap 10              raise the daily cap

  Optional: dsv4f key deepinfra   enables screenshots (DeepSeek cannot see images)
`);
