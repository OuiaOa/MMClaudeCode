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
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '384000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
    API_TIMEOUT_MS: '900000',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '900000',
  },
  effortLevel: 'high',
  skipWebFetchPreflight: true,
  permissions: { defaultMode: 'auto' },
  ...(statusline ? { statusLine: statusline } : {}),
};
const sPath = path.join(PROFILE_DIR, 'settings.json');
fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n');
try { fs.chmodSync(sPath, 0o600); } catch { /* Windows */ }   // embeds the sentinel
console.log(bold(`Wrote ${sPath}`));

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
console.log(`\n${bold('Setup complete.')}

  dsv4f run                 launch Claude Code (imports your existing state on first run)
  dsv4f run --effort ultracode
  dsv4f status              shim + stored keys
  dsv4f cap 10              raise the daily cap

  Optional: dsv4f key deepinfra   enables screenshots (DeepSeek cannot see images)
`);
