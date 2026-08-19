#!/usr/bin/env node
/**
 * Cross-platform first-time setup: key, probe, profile, autostart.
 *
 * On Linux with systemd this installs a --user unit. Elsewhere (Windows, or a systemd-less
 * Linux) the shim is started on demand by `mmclaude run`, which is why there is no service to
 * install there — one less thing to break, at the cost of a ~1s first launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { choosePort, configuredPort, healthAt } from './mmclaude-port-manager.mjs';

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_DIR = process.env.MMCLAUDE_CONFIG_DIR || path.join(HOME, '.config', 'mmclaude');
const DATA_DIR = process.env.MMCLAUDE_DATA_DIR || path.join(HOME, '.local', 'share', 'mmclaude');
// Test and portable installs can provide an isolated profile without touching the user's
// normal Claude settings or the default ~/.mmclaude directory.
const PROFILE_DIR = process.env.MMCLAUDE_PROFILE_DIR || path.join(HOME, '.mmclaude');

const bold = s => `\x1b[1m${s}\x1b[0m`;
const yel = s => `\x1b[33m${s}\x1b[0m`;
const node = process.execPath;

for (const d of [CONFIG_DIR, DATA_DIR, PROFILE_DIR]) fs.mkdirSync(d, { recursive: true });
try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* Windows */ }

// config.json ships with the package; copy it in on first setup, never overwrite a tuned one.
const cfgPath = path.join(CONFIG_DIR, 'config.json');
if (!fs.existsSync(cfgPath)) fs.copyFileSync(path.join(ROOT, 'config.default.json'), cfgPath);
// Existing installs keep their tuned config, but new safety sections must not remain absent
// forever after an upgrade. Merge only missing owned defaults; preserve ports, model choices,
// and other user edits. A pre-hardening config with no traffic policy also gets the safer
// ultracode helper setting, which is the one migration that changes an old unsafe default.
try {
  const liveCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, ''));
  const shippedCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));
  const hadTrafficPolicy = 'trafficPolicy' in liveCfg;
  let changed = false;
  for (const key of ['trafficPolicy', 'pausePolicy']) {
    if (!(key in liveCfg) && shippedCfg[key]) { liveCfg[key] = shippedCfg[key]; changed = true; }
  }
  if (!hadTrafficPolicy && liveCfg.effort?.ultracodePromotesSubagents === true) {
    liveCfg.effort.ultracodePromotesSubagents = false;
    changed = true;
  }
  if (liveCfg.balance?._comment?.includes('purchased Credits automatically')) {
    liveCfg.balance._comment = shippedCfg.balance._comment;
    changed = true;
  }
  if (changed) fs.writeFileSync(cfgPath, JSON.stringify(liveCfg, null, 2) + '\n');
} catch (e) { console.error(yel(`config safety migration skipped: ${e.message}`)); }

// sentinel: what Claude Code presents to the shim, so the real key never enters its environment
const sentinelPath = path.join(CONFIG_DIR, 'sentinel');
if (!fs.existsSync(sentinelPath) || !fs.readFileSync(sentinelPath, 'utf8').trim()) {
  const { randomBytes } = await import('node:crypto');
  fs.writeFileSync(sentinelPath, randomBytes(24).toString('base64').replace(/[/+=]/g, ''), { mode: 0o600 });
}
const SENTINEL = fs.readFileSync(sentinelPath, 'utf8').trim();

// key
if (!fs.existsSync(path.join(CONFIG_DIR, 'key')) || process.argv.includes('--rekey')) {
  const r = spawnSync(node, [path.join(ROOT, 'bin', 'mmclaude.mjs'), 'key', 'minimax'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!fs.readFileSync(path.join(CONFIG_DIR, 'key'), 'utf8').trim()) { console.error('No key stored.'); process.exit(1); }

console.log(`\n${bold('Native multimodal enabled')}`);
console.log('MiniMax M3 receives supported image and video blocks directly through its Anthropic-compatible API.');
console.log('No separate vision key or sidecar is used.');

// probe — calibrates the shim against what the endpoint actually does. Results are cached to
// probe-results.json and the shim reads them at startup (falling back to documented defaults
// if the file is missing) — genuinely needed on first setup (MiniMax's own docs contradict
// each other on the exact response shape), but re-measuring it on EVERY re-run of `mmclaude
// setup` was pure waste: the slow part (the effort ladder) makes 6 real, deliberately
// slow-at-high-effort API calls purely to TIME them, several minutes each — a user re-running
// setup just to pick up a new feature (e.g. reroute) had no way to skip 15-20 minutes of
// re-measuring something that hasn't changed. Skip whenever a cached result already exists,
// unless the key just changed (--rekey, since a different account could behave differently)
// or the user explicitly asks for a fresh measurement (--reprobe).
const probeResultsPath = path.join(CONFIG_DIR, 'probe-results.json');
const needsProbe = !fs.existsSync(probeResultsPath) || process.argv.includes('--reprobe') || process.argv.includes('--rekey');
if (needsProbe) {
  console.log(bold('\nProbing endpoint behaviour...'));
  spawnSync(node, [path.join(ROOT, 'probe.mjs')], { stdio: 'inherit' });
} else {
  const probedAt = fs.statSync(probeResultsPath).mtime.toISOString().slice(0, 10);
  console.log(`\nUsing cached endpoint probe from ${probedAt} (pass --reprobe to re-measure).`);
}

// profile
const liveConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const configured = configuredPort({ envVar: 'MMCLAUDE_PORT', dataDir: DATA_DIR, app: 'mmclaude', configPort: liveConfig.port, defaultPort: 8788 });
const preferred = Number.parseInt(process.env.MMCLAUDE_PORT || liveConfig.port || 8788, 10);
const portSelection = await (await healthAt(configured, '/_mmclaude/health', 500)
  ? Promise.resolve({ port: configured, preferredPort: preferred, shifted: configured !== preferred })
  : choosePort({ app: 'mmclaude', envVar: 'MMCLAUDE_PORT', configDir: CONFIG_DIR, dataDir: DATA_DIR,
      configPort: liveConfig.port, bind: liveConfig.bind || '127.0.0.1' }));
const port = portSelection.port;
if (portSelection.shifted) console.log(yel(`Port ${preferred} is reserved or busy; using ${port} for MMClaude.`));
// Cross-platform on every OS — see mmclaude-statusline.mjs's header for why this replaced the
// old bash+curl statusline.sh (that script never ran on Windows, which has no guaranteed
// POSIX shell, so every Windows install silently missed the cost display entirely).
const statusline = { type: 'command', command: `node "${path.join(ROOT, 'bin', 'mmclaude-statusline.mjs')}"`, refreshInterval: 10 };

// deny-list.sh ships with the package (a PreToolUse guardrail — bypassPermissions mode has
// no other check on destructive commands) but never overwrite a hand-tuned copy, matching
// how config.json is handled below.
const denyListDst = path.join(PROFILE_DIR, 'deny-list.sh');
const denyListSrc = path.join(ROOT, 'deny-list.sh');
if (!WIN && fs.existsSync(denyListSrc) && !fs.existsSync(denyListDst)) {
  fs.copyFileSync(denyListSrc, denyListDst);
  try { fs.chmodSync(denyListDst, 0o755); } catch { /* no-op on Windows filesystems */ }
}

const qualitySessionCommand = `node "${path.join(ROOT, 'bin', 'mmclaude-quality-session.mjs')}"`;
const qualityCheckCommand = `node "${path.join(ROOT, 'bin', 'mmclaude-quality-check.mjs')}"`;
const qualityHooks = {
  SessionStart: [{ hooks: [{ type: 'command', command: qualitySessionCommand, timeout: 5 }] }],
  // Async is important: tests provide feedback on the next turn without serialising Claude's
  // edit loop, and the hook itself coalesces concurrent firings with a short-lived lock.
  PostToolUse: [{ matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: qualityCheckCommand, async: true, timeout: 120 }] }],
};

const settings = {
  env: {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: SENTINEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'mmclaude-m3-thinking',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'mmclaude-m3-thinking',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'mmclaude-m2.7-thinking',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mmclaude-m2.7-highspeed-thinking',
    ANTHROPIC_SMALL_FAST_MODEL: 'mmclaude-m2.5-background',
    // Subagents are helper/background work too: keep them on M2.5 when available, with the
    // profile's configured M2.7-highspeed fallback, rather than spending M3 quota on every fan-out task.
    CLAUDE_CODE_SUBAGENT_MODEL: 'mmclaude-m2.5-background',
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
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'mmclaude-m2.5-background',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '384000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
    // A Token Plan pause can span the remainder of the rolling five-hour interval. Keep the
    // client request alive while the shim waits; ordinary upstream timeouts remain enforced by
    // the shim itself.
    API_TIMEOUT_MS: '21600000',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '21600000',
  },
  effortLevel: 'high',
  skipWebFetchPreflight: true,
  // Was 'bypassPermissions' (skip everything) from 2026-08-07, on the theory that any other
  // mode would hang on a classifier reaching for api.anthropic.com directly. That reasoning
  // stopped being true on 2026-08-10 when CLAUDE_CODE_TWO_STAGE_CLASSIFIER=0 (above) disabled
  // the classifier subsystem entirely — nobody revisited bypass mode after that landed.
  // CONFIRMED LIVE 2026-08-13: acceptEdits/default/auto all work correctly against this
  // profile with the classifier disabled — no hangs, no errors, real tool calls (including
  // chained Bash, the specific case that used to misbehave) and a real /compact all ran
  // clean under every mode tested, verified against the shim's own journal (zero
  // classifier/error/denial entries across the test). 'acceptEdits' is the new default:
  // keeps the smooth auto-approve-routine-edits experience bypass gave, while restoring real
  // prompting (backed by deny-list.sh's PreToolUse hook as the actual safety net either way)
  // for anything the deny-list doesn't already catch. Change to 'default' for full manual
  // confirmation, or back to 'bypassPermissions' if you want zero prompts again.
  permissions: { defaultMode: 'acceptEdits' },
  ...(statusline ? { statusLine: statusline } : {}),
  hooks: {
    ...(fs.existsSync(denyListDst) ? {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${denyListDst}`, timeout: 5 }] }],
    } : {}),
    ...qualityHooks,
  },
};

const sPath = path.join(PROFILE_DIR, 'settings.json');
if (!fs.existsSync(sPath)) {
  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(bold(`Wrote ${sPath}`));
} else {
  // Re-running setup (a "reinstall", or picking up a new mmclaude version's defaults) used to
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
    // Migrate an existing statusLine still pointing at the removed statusline.sh (Windows
    // installs never had one at all — the generic merge below only ADDS missing keys, so a
    // pre-existing statusLine object on Linux/Mac would otherwise never pick up the new
    // cross-platform command since `command` already exists under it).
    if (live.statusLine?.command && /statusline\.sh/.test(live.statusLine.command)) {
      live.statusLine = statusline;
      added.push('statusLine (migrated off statusline.sh)');
    }
    // Migrate an existing bypassPermissions setting to the new default (acceptEdits) — see
    // the comment above `settings` for why. Only touches it if it's STILL the old default;
    // if the user already changed it themselves (to anything else, including back to
    // bypassPermissions deliberately), that choice is left alone.
    if (live.permissions?.defaultMode === 'bypassPermissions') {
      live.permissions.defaultMode = 'acceptEdits';
      added.push('permissions.defaultMode (migrated off bypassPermissions)');
    }
    (function merge(dst, src, keyPath = '') {
      for (const [k, v] of Object.entries(src)) {
        const here = keyPath ? `${keyPath}.${k}` : k;
        if (!(k in dst)) { dst[k] = v; added.push(here); }
        else if (v && typeof v === 'object' && !Array.isArray(v) &&
                 dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], v, here);
      }
    })(live, settings);
    // Leave Claude Code's built-in Default row in charge of the default model. Older MMClaude
    // releases exposed ANTHROPIC_MODEL and ANTHROPIC_CUSTOM_MODEL_OPTION, which produced an
    // extra custom entry (and, worse, made the default profile look like a second model). Remove
    // only values recognisably written by MMClaude; a deliberate user model remains untouched.
    const ownProfile = v => typeof v === 'string' && /^mmclaude-(?:m3|m2\.7|m2\.5)/i.test(v);
    if (ownProfile(live.env?.ANTHROPIC_MODEL)) {
      delete live.env.ANTHROPIC_MODEL;
      added.push('ANTHROPIC_MODEL (restored Claude Default)');
    }
    if (ownProfile(live.env?.ANTHROPIC_CUSTOM_MODEL_OPTION) || live.env?.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME === 'MiniMax M3') {
      delete live.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
      delete live.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME;
      added.push('custom model option (removed duplicate)');
    }
    // Refresh model sentinels that belong to MMClaude itself when a new release changes the
    // tier policy. Deliberate user model names are left untouched; only our own profile names
    // are migrated. This is what moves an existing install's subagents from the old M3 helper
    // profile to the quota-friendly M2.5 background profile on the next setup run.
    const ownedModelKeys = new Set([
      'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
    ]);
    for (const [k, v] of Object.entries(settings.env)) {
      if (!ownedModelKeys.has(k) || typeof v !== 'string') continue;
      if (typeof live.env?.[k] === 'string' && /^mmclaude-(?:m3|m2\.7|m2\.5)/i.test(live.env[k]) && live.env[k] !== v) {
        live.env[k] = v;
        added.push(`${k} (model policy updated)`);
      }
    }
    for (const k of ['API_TIMEOUT_MS', 'CLAUDE_STREAM_IDLE_TIMEOUT_MS']) {
      if (live.env?.[k] === '900000') {
        live.env[k] = settings.env[k];
        added.push(`${k} (extended for Token Plan pause windows)`);
      }
    }
    if (typeof live.env?.ANTHROPIC_BASE_URL === 'string' &&
        /^http:\/\/127\.0\.0\.1:\d+$/i.test(live.env.ANTHROPIC_BASE_URL) &&
        live.env.ANTHROPIC_BASE_URL !== settings.env.ANTHROPIC_BASE_URL) {
      live.env.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL;
      added.push('ANTHROPIC_BASE_URL (port policy updated)');
    }
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
    live.hooks ??= {};
    const ensureQualityHook = (event, group) => {
      live.hooks[event] ??= [];
      const command = group.hooks?.[0]?.command;
      const already = live.hooks[event].some(h =>
        Array.isArray(h?.hooks) && h.hooks.some(hh => String(hh?.command || '') === command));
      if (!already) { live.hooks[event].push(group); added.push(`hooks.${event}[quality]`); }
    };
    ensureQualityHook('SessionStart', qualityHooks.SessionStart[0]);
    ensureQualityHook('PostToolUse', qualityHooks.PostToolUse[0]);
    if (added.length) {
      fs.writeFileSync(sPath, JSON.stringify(live, null, 2) + '\n');
      console.log(bold(`${sPath}: added ${added.length} new key(s): ${added.join(', ')}`));
    } else {
      console.log(`${sPath}: already up to date`);
    }
  }
}
try { fs.chmodSync(sPath, 0o600); } catch { /* Windows */ }   // embeds the sentinel

// Claude Code discovers portable agents and skills under its profile/config directory, not
// beside the shim executable. Copy missing shipped assets on every setup so upgrades become
// visible without overwriting anything the user has edited locally.
try {
  const { installPortableAssets } = await import('./mmclaude-reroute.mjs');
  const assets = installPortableAssets(PROFILE_DIR, ROOT);
  if (assets.length) console.log(`Installed portable assets: ${assets.join(', ')}`);
} catch (e) { console.error(yel(`portable skill install skipped: ${e.message}`)); }

// autostart
if (!WIN && spawnSync('systemctl', ['--user', '--version'], { stdio: 'ignore' }).status === 0) {
  const unitDir = path.join(HOME, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'mmclaude-shim.service'),
`[Unit]
Description=mmclaude shim (Claude Code -> MiniMax M3)
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
  spawnSync('systemctl', ['--user', 'enable', '--now', 'mmclaude-shim.service'], { stdio: 'ignore' });
  console.log('systemd --user service installed and started');
} else {
  console.log(yel('No systemd — the shim starts on demand when you run `mmclaude run`.'));
}

spawnSync(node, [path.join(ROOT, 'bin', 'mmclaude.mjs'), 'start'], { stdio: 'inherit' });

// ------------------------------------------------------ multi-source import picker
// Three possible sources, any combination present: Claude Code CLI, Claude Desktop, and
// opencode. See bin/mmclaude-sources.mjs's header for exactly what each one is and why
// claude-cli/claude-desktop are handled together (they share ~/.claude/projects — Desktop
// embeds the real CLI rather than having its own transcript format).
//
// Per source, four dispositions, asked INDIVIDUALLY — never assumed, never global:
//   leave   nothing happens
//   copy    imported into mmclaude; source keeps its own copy untouched
//   move    imported into mmclaude, then scrubbed from the source (source stays installed,
//           minus that history)
//   remove  copy + scrub, then remove the source itself. For claude-cli this means bundling
//           the binary privately into mmclaude and deleting Anthropic credentials — never
//           literally uninstalling it, since mmclaude cannot run without SOME Claude Code
//           binary. For claude-desktop/opencode it means printing manual uninstall steps —
//           mmclaude never runs a third-party uninstaller unattended. See mmclaude-scrub.mjs's
//           header for the full reasoning.
{
  const { detectSources } = await import('./mmclaude-sources.mjs');
  const sources = detectSources({ home: HOME, env: process.env, platform: process.platform });
  const present = sources.filter(s => s.present);

  if (present.length) {
    console.log(bold('\nExisting sessions found'));
    const TTY = process.stdin.isTTY && process.stdout.isTTY;
    const disposition = {}; // sourceId -> 'leave' | 'copy' | 'move' | 'remove'

    if (TTY) {
      const rl = (await import('node:readline')).default.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise(res => rl.question(q, a => res(a.trim().toLowerCase())));

      // Axis 3, asked FIRST and framed as the recommended path when a real CLI binary is
      // present: point the EXISTING install at MiniMax in place, rather than importing a
      // copy into an isolated profile. Nothing gets copied, so the session switcher
      // (left-arrow), background jobs, and memories are already perfect — they're the same
      // real profile, just talking to a different backend. Copy-into-isolated-profile
      // (below) genuinely cannot replicate that: the switcher is powered by Claude Code's
      // own internal per-session job-tracking state, generated live as a session runs, not
      // something a copied .jsonl file can carry with it (confirmed 2026-08-13 — see memory).
      // Reroute's real cost, stated plainly rather than buried: it edits the real, shared
      // settings.json in place, so a later "go back to standard Anthropic Claude Code" means
      // reverting that edit (backed up, always revertible) rather than nothing to undo at
      // all, which the copy-based path gives for free. That's why this is a recommendation,
      // not a default applied silently.
      const cliSource = present.find(s => s.id === 'claude-cli');
      let cliRerouted = false;
      if (cliSource?.binary) {
        console.log(`\n  ${bold('Recommended: point Claude Code CLI directly at MiniMax')}`);
        console.log('  Keeps the real `claude` command working exactly as it does today — same session');
        console.log('  switcher, same background jobs, same memories, nothing to import — it just never');
        console.log('  bills Anthropic again. Edits its real settings.json in place (backed up first,');
        console.log('  revertible any time). If you\'d rather keep a completely separate, isolated MiniMax');
        console.log('  profile instead (e.g. to keep the real install untouched for switching back to');
        console.log('  Anthropic later), say no here and you\'ll get the normal copy/move options next.');
        const rerouteAns = await ask('  Route the existing install through mmclaude? [Y/n] ');
        if (rerouteAns[0] !== 'n') {
          const { buildRerouteEnv, buildRerouteExtras, applyCliReroute } = await import('./mmclaude-reroute.mjs');
          const { newBackupDir } = await import('./mmclaude-scrub.mjs');
          const cliSettingsPath = path.join(cliSource.paths.profile, 'settings.json');
          const backupDir = newBackupDir(PROFILE_DIR, 'cli-reroute');
          try {
            const extras = buildRerouteExtras({ rootDir: ROOT, platform: process.platform });
            const r = applyCliReroute(cliSettingsPath, buildRerouteEnv({ port, sentinel: SENTINEL }), backupDir, extras);
            console.log(bold(`  Rerouted ${cliSettingsPath}`));
            if (r.backupPath) console.log(`  (original backed up to ${r.backupPath})`);
            console.log(yel('  Note: any OTHER standalone Claude Code CLI install that reads this same'));
            console.log(yel('  settings.json will also be rerouted — they share one config file.'));
            cliRerouted = true;
            // The real install now talks to MiniMax directly -- importing a copy into the
            // isolated mmclaude profile too would just be redundant duplication of the same
            // history, so claude-cli's own disposition is implicitly "leave" from here.
            disposition['claude-cli'] = 'leave';
          } catch (e) {
            console.error(yel(`  Reroute failed: ${e.message}`));
            console.log('  Falling through to the normal copy/move options for Claude Code CLI.');
          }
        }
      }

      for (const s of present) {
        if (s.id === 'claude-cli' && cliRerouted) continue; // already handled above
        const detail = s.id === 'opencode'
          ? (s.stats.error ? s.stats.error : `${s.stats.sessions} session(s)`)
          : s.id === 'claude-desktop'
            ? `${s.stats.sidecars} session(s) in its own list (shares history with Claude Code CLI)`
            : `${s.stats.sessions} transcript(s), ${s.stats.memories} memory file(s)`;
        console.log(`\n  ${bold(s.label)} — ${detail}`);
        const ans = await ask('  [l]eave alone / [c]opy / [m]ove (copy + clear from source) / [r]emove entirely (Enter = leave): ');
        disposition[s.id] = { l: 'leave', c: 'copy', m: 'move', r: 'remove' }[ans[0]] || 'leave';
      }

      // The shared-transcript case is exactly the kind of thing worth spelling out rather
      // than silently doing the "technically correct" thing — a user picking "leave" for
      // the CLI while picking "move" for Desktop needs to know their raw history isn't
      // actually going anywhere, only Desktop's own list of it.
      if (disposition['claude-desktop'] && ['move', 'remove'].includes(disposition['claude-desktop']) &&
          (!disposition['claude-cli'] || disposition['claude-cli'] === 'leave' || disposition['claude-cli'] === 'copy')) {
        console.log(yel('  Note: Claude Code CLI and Claude Desktop share the same underlying transcripts.'));
        console.log(yel('  Only removing them from Desktop\'s own session list — the transcripts themselves stay,'));
        console.log(yel('  since Claude Code CLI is set to keep them.'));
      }

      rl.close();
    } else {
      // Non-interactive: preserve the old default (auto-import, never destructive) and
      // extend it consistently to the two new sources. copy is always safe; move/remove
      // are NEVER chosen without an interactive human present to confirm them.
      for (const s of present) disposition[s.id] = 'copy';
      console.log(yel('  Non-interactive — copying everything found, nothing removed from any source.'));
      console.log(yel('  Re-run `mmclaude setup` interactively to choose move/remove instead.'));
    }

    const { applySourceDispositions } = await import('./mmclaude-setup-sources.mjs');
    await applySourceDispositions({
      sources: present, disposition, node, ROOT, PROFILE_DIR, DATA_DIR,
      // Keep both source detection and the destination explicit for portable/standalone
      // profiles; never let a temporary profile fall through to ~/.mmclaude.
      importEnv: { MMCLAUDE_HOME: HOME, MMCLAUDE_PROFILE: PROFILE_DIR },
    });
  }
}

console.log(`\n${bold('Setup complete.')}

  mmclaude run                 launch Claude Code
  mmclaude run --effort ultracode
  mmclaude status              shim + stored keys
  mmclaude cap 10              raise the daily cap

  Native multimodal: MiniMax M3 receives image and video blocks directly
`);
